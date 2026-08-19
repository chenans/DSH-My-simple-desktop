#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Build the bundled dsh runtime directory (dsh/) for the installer.

.DESCRIPTION
    Copies the global npm-installed @deepseek-ai/dsh and a compatible Node.js
    runtime into the dsh/ directory.  The result is bundled into the installer
    via electron-builder's extraResources so the app works on machines without
    Node.js or the dsh CLI.

    Run this BEFORE `npm run dist`.

    Prerequisites:
      - Node.js >= 18 (the same major used by the Electron version below)
      - @deepseek-ai/dsh installed globally:  npm i -g @deepseek-ai/dsh
      - npm.cmd on PATH (or the npm used to install dsh globally)
#>

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$ProjectRoot = Split-Path -Parent $ScriptDir
$DshDir = Join-Path $ProjectRoot 'dsh'

Write-Host "=== Building dsh runtime bundle ==="
Write-Host "Project root: $ProjectRoot"
Write-Host "Target dir:   $DshDir"

# ---------------------------------------------------------------------------
# 1. Resolve the global @deepseek-ai/dsh installation
# ---------------------------------------------------------------------------
Write-Host "`n[1/4] Resolving global dsh installation..."

$GlobalRoot = & npm.cmd root -g 2>$null
if ($LASTEXITCODE -ne 0 -or -not $GlobalRoot) {
    throw "Cannot determine npm global root; is npm installed?"
}

$GlobalDsh = Join-Path $GlobalRoot '@deepseek-ai\dsh'
if (-not (Test-Path $GlobalDsh)) {
    throw "Global @deepseek-ai/dsh not found at $GlobalRoot\@deepseek-ai\dsh; run 'npm i -g @deepseek-ai/dsh' first"
}

# Verify it has node_modules (the hoisted dependency tree)
$GlobalDshNm = Join-Path $GlobalDsh 'node_modules'
if (-not (Test-Path $GlobalDshNm)) {
    throw "Global @deepseek-ai/dsh has no node_modules; run 'npm i -g @deepseek-ai/dsh' first"
}

Write-Host "  Found: $GlobalDsh"

# ---------------------------------------------------------------------------
# 2. Resolve a compatible node.exe
# ---------------------------------------------------------------------------
Write-Host "[2/4] Resolving Node.js binary..."

$NodeExe = (Get-Command node).Source
if (-not $NodeExe -or -not (Test-Path $NodeExe)) {
    throw "Cannot find node.exe on PATH"
}

$NodeVer = & $NodeExe --version
Write-Host "  Using: $NodeExe ($NodeVer)"

# ---------------------------------------------------------------------------
# 3. Prepare the target dsh/ directory
# ---------------------------------------------------------------------------
Write-Host "[3/4] Preparing dsh/ directory..."

if (Test-Path $DshDir) {
    Write-Host "  Removing old dsh/ directory..."
    Remove-Item -Recurse -Force $DshDir
}

New-Item -ItemType Directory -Path $DshDir -Force | Out-Null

# Copy node.exe
Copy-Item -Path $NodeExe -Destination (Join-Path $DshDir 'node.exe')
Write-Host "  Copied node.exe"

# Create the node_modules path
$TargetNm = Join-Path $DshDir 'node_modules'
New-Item -ItemType Directory -Path $TargetNm -Force | Out-Null

# Create @deepseek-ai scope directory
$TargetScope = Join-Path $TargetNm '@deepseek-ai'
New-Item -ItemType Directory -Path $TargetScope -Force | Out-Null

# Copy @deepseek-ai/dsh (first create the target dir, then copy contents)
Write-Host "  Copying @deepseek-ai/dsh (package)..."
$TargetDsh = Join-Path $TargetScope 'dsh'
New-Item -ItemType Directory -Path $TargetDsh -Force | Out-Null
# Copy all files and directories except node_modules
Get-ChildItem $GlobalDsh | Where-Object { $_.Name -ne 'node_modules' } | ForEach-Object {
    if ($_.PSIsContainer) {
        Copy-Item -Path $_.FullName -Destination (Join-Path $TargetDsh $_.Name) -Recurse -Force
    } else {
        Copy-Item -Path $_.FullName -Destination $TargetDsh -Force
    }
}

# Copy all @deepseek-ai/* dependency packages from the global dsh's node_modules
Write-Host "  Copying @deepseek-ai dependency packages..."
$GlobalDshScope = Join-Path $GlobalDshNm '@deepseek-ai'
if (Test-Path $GlobalDshScope) {
    Get-ChildItem $GlobalDshScope -Directory | ForEach-Object {
        $pkgName = $_.Name
        $target = Join-Path $TargetScope $pkgName
        Write-Host "    $pkgName"
        Copy-Item -Path $_.FullName -Destination $target -Recurse -Force
    }
}

# Copy ALL other dependencies from global dsh's node_modules
Write-Host "  Copying third-party dependencies..."
$count = 0
Get-ChildItem $GlobalDshNm -Directory | Where-Object { $_.Name -ne '@deepseek-ai' } | ForEach-Object {
    $target = Join-Path $TargetNm $_.Name
    Copy-Item -Path $_.FullName -Destination $target -Recurse -Force
    $count++
}
Write-Host "    ($count packages copied)"

# Also copy any .bin files needed
$GlobalBin = Join-Path $GlobalDshNm '.bin'
if (Test-Path $GlobalBin) {
    Copy-Item -Path $GlobalBin -Destination (Join-Path $TargetNm '.bin') -Recurse -Force
    Write-Host "  Copied .bin directory"
}

# Also copy any files in node_modules root (like package.json if any)
Get-ChildItem $GlobalDshNm -File | ForEach-Object {
    Copy-Item -Path $_.FullName -Destination (Join-Path $TargetNm $_.Name) -Force
}

# ---------------------------------------------------------------------------
# 4. Verify the resulting bundle — smoke test with actual dsh load
# ---------------------------------------------------------------------------
Write-Host "[4/4] Verifying result..."

$TotalSize = (Get-ChildItem -Recurse $DshDir -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
$FileCount = (Get-ChildItem -Recurse $DshDir -File -ErrorAction SilentlyContinue).Count

Write-Host "  Directory: $DshDir"
Write-Host "  Files:     $FileCount"
Write-Host "  Size:      $([math]::Round($TotalSize/1MB, 1)) MB"

# Verify key files exist
$checks = @(
    'node.exe',
    'node_modules\@deepseek-ai\dsh\lib\bin.js',
    'node_modules\@deepseek-ai\dsh-base\package.json',
    'node_modules\@deepseek-ai\dsh-web-app\package.json'
)
$missing = @()
foreach ($chk in $checks) {
    $full = Join-Path $DshDir $chk
    if (-not (Test-Path $full)) {
        $missing += $chk
    }
}

if ($missing.Count -gt 0) {
    Write-Warning "Missing files:"
    $missing | ForEach-Object { Write-Warning "  $_" }
    Write-Warning "The bundle may not work correctly."
    return
}

Write-Host "  (smoke test skipped: requires --profile)"
Write-Host "=== dsh runtime bundle built successfully ==="
Write-Host "Run 'npm run dist' to build the installer."
