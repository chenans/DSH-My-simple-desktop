<#
.SYNOPSIS
  Signs an already-built .exe (or all .exe in release/) using the
  self-signed certificate or any configured CSC_LINK .pfx.

.DESCRIPTION
  Use this when:
    - You built installers without CSC_LINK set and want to sign them
      after the fact.
    - You want to re-sign with a different certificate.
    - You want to sign the unpacked .exe before electron-builder packs it.

  This script uses signtool.exe (from Windows SDK) or falls back to
  PowerShell's Set-AuthenticodeSignature cmdlet.

.PARAMETER FilePath
  Specific .exe to sign. If omitted, signs all .exe in release\.

.PARAMETER PfxPath
  Path to .pfx certificate. Defaults to build\certs\codesign.pfx.

.PARAMETER Password
  Password for the .pfx. If omitted, prompts.

.EXAMPLE
  .\scripts\sign-exe.ps1
  .\scripts\sign-exe.ps1 -FilePath "release\DSH My Simple Desktop-0.1.17-Setup.exe"
  .\scripts\sign-exe.ps1 -PfxPath "C:\mycert.pfx" -Password "secret"
#>

param(
  [string]$FilePath,
  [string]$PfxPath,
  [string]$Password
)

$ErrorActionPreference = "Stop"

# --- Resolve PFX path ---
if (-not $PfxPath) {
  $PfxPath = Join-Path (Get-Location) "build\certs\codesign.pfx"
}
if (-not (Test-Path $PfxPath)) {
  Write-Error "Certificate .pfx not found: $PfxPath`nRun scripts\create-self-signed-cert.ps1 first."
  exit 1
}

# --- Resolve password ---
if (-not $Password) {
  $securePassword = Read-Host -Prompt "Enter .pfx password" -AsSecureString
} else {
  $securePassword = ConvertTo-SecureString -String $Password -AsPlainText -Force
}

# --- Resolve target files ---
if ($FilePath) {
  $files = @($FilePath)
  if (-not (Test-Path $files[0])) {
    Write-Error "File not found: $($files[0])"
    exit 1
  }
} else {
  $releaseDir = Join-Path (Get-Location) "release"
  if (-not (Test-Path $releaseDir)) {
    Write-Error "release\ directory not found. Build first with 'npm run dist'."
    exit 1
  }
  $files = Get-ChildItem -Path $releaseDir -Filter "*.exe" -Recurse | Select-Object -ExpandProperty FullName
}

if ($files.Count -eq 0) {
  Write-Host "[sign] No .exe files found to sign." -ForegroundColor Yellow
  exit 0
}

Write-Host "[sign] Found $($files.Count) .exe file(s) to sign:" -ForegroundColor Cyan
$files | ForEach-Object { Write-Host "  $_" }

# --- Try signtool.exe first (preferred — supports SHA256 + timestamp) ---
$signtool = $null
$signtoolCandidates = @(
  "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe",
  "${env:ProgramFiles}\Windows Kits\10\bin\*\x64\signtool.exe",
  "${env:ProgramFiles(x86)}\Windows Kits\8.1\bin\x64\signtool.exe"
) | ForEach-Object { Get-Item $_ -ErrorAction SilentlyContinue } | Sort-Object FullName -Descending | Select-Object -First 1

if ($signtoolCandidates) {
  $signtool = $signtoolCandidates.FullName
  Write-Host "[sign] Using signtool.exe: $signtool"
}

# --- Sign each file ---
$success = 0
$failed = 0

foreach ($f in $files) {
  Write-Host ""
  Write-Host "[sign] Signing: $f" -ForegroundColor Cyan

  if ($signtool) {
    # signtool approach — preferred (SHA256 + RFC3161 timestamp)
    $tmpPfx = $PfxPath
    $args = @(
      "sign",
      "/fd", "sha256",
      "/td", "sha256",
      "/tr", "http://timestamp.digicert.com",
      "/f", $tmpPfx,
      "/p", (ConvertFrom-SecureString $securePassword -AsPlainText),
      $f
    )
    & $signtool $args 2>&1 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -eq 0) {
      Write-Host "  [OK] Signed successfully" -ForegroundColor Green
      $success++
    } else {
      Write-Host "  [FAIL] signtool exited with code $LASTEXITCODE" -ForegroundColor Red
      $failed++
    }
  } else {
    # PowerShell fallback — Set-AuthenticodeSignature
    Write-Host "[sign] signtool.exe not found, using PowerShell Set-AuthenticodeSignature" -ForegroundColor Yellow
    $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($PfxPath, $securePassword)
    $signature = Set-AuthenticodeSignature -FilePath $f -Certificate $cert -HashAlgorithm SHA256
    if ($signature.Status -eq "Valid") {
      Write-Host "  [OK] Signed successfully" -ForegroundColor Green
      $success++
    } else {
      Write-Host "  [FAIL] Status: $($signature.Status) - $($signature.StatusMessage)" -ForegroundColor Red
      $failed++
    }
  }
}

# --- Summary ---
Write-Host ""
Write-Host "=== Signing Summary ===" -ForegroundColor Cyan
Write-Host "  Success: $success" -ForegroundColor Green
if ($failed -gt 0) {
  Write-Host "  Failed:  $failed" -ForegroundColor Red
  exit 1
}
Write-Host "  All files signed." -ForegroundColor Green

# --- Verify signature ---
Write-Host ""
Write-Host "[verify] Checking signatures..." -ForegroundColor Cyan
foreach ($f in $files) {
  $sig = Get-AuthenticodeSignature -FilePath $f
  $status = $sig.Status
  $signer = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { "(none)" }
  $color = if ($status -eq "Valid") { "Green" } else { "Yellow" }
  Write-Host "  $f" -ForegroundColor $color
  Write-Host "    Status: $status | Signer: $signer" -ForegroundColor $color
}
