<#
.SYNOPSIS
  Generates a self-signed code-signing certificate and exports it as .pfx
  for use with electron-builder.

.DESCRIPTION
  This script creates a self-signed code-signing certificate in the Current
  User certificate store, then exports it to build/certs/codesign.pfx.

  The .pfx file can be used by electron-builder via the CSC_LINK environment
  variable (path to .pfx) and CSC_KEY_PASSWORD (the export password).

  IMPORTANT — limitations of self-signed certificates:
    - Windows SmartScreen WILL still show a warning for self-signed exes
      because the certificate is not in the Trusted Root chain.
    - To make the certificate trusted on YOUR machine (for testing), the
      script also installs it into the Trusted Root store.
    - For other users, they would need to manually install the .cer file
      into their Trusted Root store — or you distribute via AD Group Policy.
    - For public distribution without SmartScreen warnings, you need a
      commercial code-signing certificate (OV/EV) or Azure Trusted Signing.

.PARAMETER Force
  Overwrite existing certificate and .pfx if present.

.PARAMETER Password
  The password for the .pfx export. If not provided, a prompt will appear.

.EXAMPLE
  .\scripts\create-self-signed-cert.ps1
  .\scripts\create-self-signed-cert.ps1 -Force
  .\scripts\create-self-signed-cert.ps1 -Password "MySecret123"
#>

param(
  [switch]$Force,
  [string]$Password
)

$ErrorActionPreference = "Stop"

$certSubject = "CN=DSH Desktop Self-Signed"
$certFriendlyName = "DSH Desktop Code Signing"
$pfxPath = Join-Path (Get-Location) "build\certs\codesign.pfx"
$cerPath = Join-Path (Get-Location) "build\certs\codesign.cer"

# --- Check for existing cert ---
$existing = Get-ChildItem -Path "Cert:\CurrentUser\My" -CodeSigningCert -ErrorAction SilentlyContinue |
  Where-Object { $_.Subject -eq $certSubject }

if ($existing -and -not $Force) {
  Write-Host "[cert] Self-signed code-signing certificate already exists:" -ForegroundColor Yellow
  Write-Host "  Thumbprint: $($existing.Thumbprint)"
  Write-Host "  Subject:    $($existing.Subject)"
  Write-Host ""
  Write-Host "  .pfx path:  $pfxPath" (if (Test-Path $pfxPath) { "(exists)" } else { "(missing — re-run with -Force)" })
  Write-Host ""
  Write-Host "  Use -Force to recreate." -ForegroundColor Yellow
  exit 0
}

# --- Remove old cert if Force ---
if ($existing -and $Force) {
  Write-Host "[cert] Removing existing certificate (thumbprint: $($existing.Thumbprint))..."
  # Also remove from Trusted Root if present
  $rootCert = Get-ChildItem -Path "Cert:\CurrentUser\Root" -ErrorAction SilentlyContinue |
    Where-Object { $_.Subject -eq $certSubject }
  if ($rootCert) {
    Remove-Item -Path "Cert:\CurrentUser\Root\$($rootCert.Thumbprint)" -Force
  }
  Remove-Item -Path "Cert:\CurrentUser\My\$($existing.Thumbprint)" -Force
}

# --- Create output directory ---
$certDir = Split-Path $pfxPath -Parent
if (-not (Test-Path $certDir)) {
  New-Item -ItemType Directory -Force -Path $certDir | Out-Null
}

# --- Generate self-signed certificate ---
Write-Host "[cert] Creating self-signed code-signing certificate..."
Write-Host "  Subject: $certSubject"

$certParams = @{
  Type              = "CodeSigningCert"
  Subject           = $certSubject
  FriendlyName      = $certFriendlyName
  KeyUsage          = "DigitalSignature"
  KeyAlgorithm      = "RSA"
  KeyLength         = 2048
  HashAlgorithm     = "SHA256"
  NotAfter          = (Get-Date).AddYears(3)
  CertStoreLocation = "Cert:\CurrentUser\My"
}

$cert = New-SelfSignedCertificate @certParams

if (-not $cert) {
  Write-Error "Failed to create self-signed certificate."
  exit 1
}

Write-Host "[cert] Certificate created: thumbprint=$($cert.Thumbprint)" -ForegroundColor Green

# --- Export .cer (public key, for distribution to other machines) ---
Export-Certificate -Cert $cert -FilePath $cerPath -Force | Out-Null
Write-Host "[cert] Exported .cer: $cerPath"

# --- Export .pfx (private key, for signing) ---
if (-not $Password) {
  $securePassword = Read-Host -Prompt "Enter password for .pfx export" -AsSecureString
} else {
  $securePassword = ConvertTo-SecureString -String $Password -AsPlainText -Force
}

Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $securePassword -Force | Out-Null
Write-Host "[cert] Exported .pfx: $pfxPath" -ForegroundColor Green

# --- Install into Trusted Root (current user) so THIS machine trusts it ---
# This eliminates "Unknown Publisher" on the local machine for testing.
$rootStore = Get-Item -Path "Cert:\CurrentUser\Root"
$rootStore.Open("ReadWrite")
$rootStore.Add($cert)
$rootStore.Close()
Write-Host "[cert] Installed into Trusted Root (CurrentUser) — local machine will trust this cert" -ForegroundColor Green

# --- Print usage instructions ---
Write-Host ""
Write-Host "=== Usage with electron-builder ===" -ForegroundColor Cyan
Write-Host "Set these environment variables before running 'npm run dist':"
Write-Host ""
Write-Host '  $env:CSC_LINK = "' + $pfxPath + '"'
Write-Host '  $env:CSC_KEY_PASSWORD = "<your-password>"'
Write-Host ""
Write-Host "Or add to your PowerShell profile / .env for persistence."
Write-Host ""
Write-Host "=== Distributing to other machines ===" -ForegroundColor Cyan
Write-Host "For other users to trust this certificate:"
Write-Host "  1. Share build/certs/codesign.cer with them"
Write-Host "  2. They double-click it -> Install Certificate -> Local Machine -> Place all certificates in the following store -> Trusted Root Certification Authorities"
Write-Host "  3. Or use AD Group Policy to push the .cer to all domain machines"
Write-Host ""
Write-Host "WARNING: Self-signed certs will NOT bypass Windows SmartScreen for" -ForegroundColor Yellow
Write-Host "         users who haven't installed the .cer. For public distribution,"
Write-Host "         use a commercial cert or Azure Trusted Signing."
