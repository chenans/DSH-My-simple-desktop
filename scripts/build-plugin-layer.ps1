#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Build the plugin snapshot layer (plugins-layer/) for the Plugins edition installer.

.DESCRIPTION
    Orchestrates scripts/snapshot-plugin-layer.mjs to:
      1. Diff the author's ~/.dsh/profiles/web/node_modules against the
         bundled dsh/ tree, keeping only incremental plugins.
      2. Copy cordis.yml (web profile plugin manifest).
      3. Copy agent-presets (interactive whitelist selection).
      4. Generate manifest.json with versions + sha256.
      5. Security-scan for apiKey/token/secret/credentials — FAIL on hit.

    Run this AFTER `npm run build:runtime` and BEFORE `npm run dist:plugins`.

    Prerequisites:
      - dsh/ directory exists (run `npm run build:runtime` first)
      - ~/.dsh exists with profiles/web + .agent-presets
      - Node.js >= 18

.PARAMETER Presets
    Comma-separated list of preset names to include. If omitted, the script
    lists available presets and asks interactively.

.EXAMPLE
    .\scripts\build-plugin-layer.ps1
    .\scripts\build-plugin-layer.ps1 -Presets "my-agent,code-reviewer"
#>

param(
    [string]$Presets = ""
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$ProjectRoot = Split-Path -Parent $ScriptDir
$DshDir = Join-Path $ProjectRoot 'dsh'
$OutputDir = Join-Path $ProjectRoot 'plugins-layer'
$DshHome = Join-Path $env:USERPROFILE '.dsh'

Write-Host "=== Building plugin snapshot layer ==="
Write-Host "Project root: $ProjectRoot"
Write-Host "DSH_HOME:     $DshHome"
Write-Host "Bundled dsh:  $DshDir"
Write-Host "Output:       $OutputDir"
Write-Host ""

# ---------------------------------------------------------------------------
# 1. Validate prerequisites
# ---------------------------------------------------------------------------
Write-Host "[1/4] Validating prerequisites..."

if (-not (Test-Path $DshDir)) {
    throw "dsh/ directory not found. Run 'npm run build:runtime' first."
}

$DshNodeExe = Join-Path $DshDir 'node.exe'
if (-not (Test-Path $DshNodeExe)) {
    throw "dsh/node.exe not found. Run 'npm run build:runtime' first."
}

if (-not (Test-Path $DshHome)) {
    throw "DSH_HOME ($DshHome) not found. Ensure dsh has been initialized (run 'dsh web' once)."
}

$ProfilesWeb = Join-Path $DshHome 'profiles\web'
if (-not (Test-Path $ProfilesWeb)) {
    Write-Warning "profiles/web not found at $ProfilesWeb — no cordis.yml or user plugins to snapshot"
}

Write-Host "  Prerequisites OK."

# ---------------------------------------------------------------------------
# 2. Determine preset whitelist
# ---------------------------------------------------------------------------
Write-Host "`n[2/4] Selecting agent presets..."

$PresetsDir = Join-Path $DshHome '.agent-presets'
$PresetList = @()
if (Test-Path $PresetsDir) {
    $AvailablePresets = Get-ChildItem $PresetsDir -Directory | Select-Object -ExpandProperty Name
    if ($AvailablePresets.Count -gt 0) {
        Write-Host "  Available presets:"
        foreach ($p in $AvailablePresets) {
            Write-Host "    - $p"
        }

        if ($Presets) {
            $PresetList = $Presets -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
            Write-Host "  Selected (from -Presets): $($PresetList -join ', ')"
        } else {
            # Interactive: ask which presets to include
            Write-Host ""
            $answer = Read-Host "  Include all presets? (Y/n, or type names comma-separated)"
            if ($answer -eq 'n' -or $answer -eq 'N') {
                Write-Host "  Skipping all presets."
            } elseif ($answer -and $answer -ne 'y' -and $answer -ne 'Y' -and $answer -ne '') {
                $PresetList = $answer -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
                Write-Host "  Selected: $($PresetList -join ', ')"
            } else {
                $PresetList = @($AvailablePresets)
                Write-Host "  Including all presets."
            }
        }
    } else {
        Write-Host "  No preset directories found."
    }
} else {
    Write-Host "  .agent-presets directory not found."
}

# ---------------------------------------------------------------------------
# 3. Run the snapshot builder (Node module)
# ---------------------------------------------------------------------------
Write-Host "`n[3/4] Building snapshot..."

$PresetArg = if ($PresetList.Count -gt 0) { $PresetList -join ',' } else { '' }

# Pass config via env vars to the mjs module
$env:DSD_SNAPSHOT_DSH_HOME = $DshHome
$env:DSD_SNAPSHOT_BUNDLED_DSH = $DshDir
$env:DSD_SNAPSHOT_OUTPUT = $OutputDir
$env:DSD_SNAPSHOT_PRESETS = $PresetArg

$NodeExe = (Get-Command node).Source
$Script = Join-Path $ScriptDir 'snapshot-plugin-layer.mjs'

# The mjs module exports buildSnapshot; we invoke it via a small inline runner
$RunnerScript = Join-Path $env:TEMP "dsd-snapshot-runner-$(Get-Random).mjs"
@"
import { buildSnapshot } from 'file:///$($Script -replace '\\','/')';

const presets = process.env.DSD_SNAPSHOT_PRESETS
  ? process.env.DSD_SNAPSHOT_PRESETS.split(',').map(s => s.trim()).filter(Boolean)
  : null;

try {
  const manifest = await buildSnapshot({
    dshHome: process.env.DSD_SNAPSHOT_DSH_HOME,
    bundledDsh: process.env.DSD_SNAPSHOT_BUNDLED_DSH,
    outputDir: process.env.DSD_SNAPSHOT_OUTPUT,
    presetWhitelist: presets,
  });
  console.log('MANIFEST_JSON:' + JSON.stringify(manifest));
  process.exit(0);
} catch (err) {
  console.error('SNAPSHOT_ERROR: ' + err.message);
  process.exit(1);
}
"@ | Set-Content -Path $RunnerScript -Encoding UTF8

try {
    & $NodeExe $RunnerScript
    $exitCode = $LASTEXITCODE
} finally {
    Remove-Item -Path $RunnerScript -Force -ErrorAction SilentlyContinue
}

if ($exitCode -ne 0) {
    throw "Snapshot build failed (exit code $exitCode). See output above."
}

# ---------------------------------------------------------------------------
# 4. Print summary
# ---------------------------------------------------------------------------
Write-Host "`n[4/4] Summary..."

if (Test-Path $OutputDir) {
    $TotalSize = (Get-ChildItem -Recurse $OutputDir -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
    $FileCount = (Get-ChildItem -Recurse $OutputDir -File -ErrorAction SilentlyContinue).Count
    $ManifestPath = Join-Path $OutputDir 'manifest.json'

    Write-Host "  Output dir: $OutputDir"
    Write-Host "  Files:      $FileCount"
    Write-Host "  Size:       $([math]::Round($TotalSize/1MB, 1)) MB"

    if (Test-Path $ManifestPath) {
        Write-Host ""
        Write-Host "  manifest.json:"
        $manifest = Get-Content $ManifestPath -Raw | ConvertFrom-Json
        Write-Host "    dsh version: $($manifest.dshVersion)"
        Write-Host "    plugins:     $($manifest.plugins.Count)"
        Write-Host "    presets:     $($manifest.presets.Count)"
        Write-Host "    snapshot sha: $($manifest.snapshotSha.Substring(0, [Math]::Min(16, $manifest.snapshotSha.Length)))..."
        Write-Host "    created:     $($manifest.createdAt)"
    }
} else {
    throw "Output directory was not created: $OutputDir"
}

Write-Host ""
Write-Host "=== Plugin snapshot layer built successfully ==="
Write-Host "Run 'npm run dist:plugins' to build the Plugins edition installer."
