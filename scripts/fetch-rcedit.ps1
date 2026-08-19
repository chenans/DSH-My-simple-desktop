# Fetches the official rcedit-x64.exe into build/rcedit/ (used by afterPack).
# Source: the winCodeSign package from electron-builder-binaries (mirror-safe).
$ErrorActionPreference = "Stop"
$tmp = Join-Path $env:TEMP "wcs-extract"
$arc = Join-Path $env:TEMP "winCodeSign-2.6.0.7z"
$mirror = "https://npmmirror.com/mirrors/electron-builder-binaries"
$sevenZip = Join-Path (Get-Location) "node_modules\7zip-bin\win\x64\7za.exe"

if (-not (Test-Path "build\rcedit\rcedit-x64.exe")) {
  New-Item -ItemType Directory -Force -Path "build\rcedit" | Out-Null
  Remove-Item $tmp, $arc -Recurse -Force -ErrorAction SilentlyContinue
  Invoke-WebRequest -Uri "$mirror/winCodeSign-2.6.0/winCodeSign-2.6.0.7z" -OutFile $arc -UseBasicParsing
  & $sevenZip x -bd -y $arc "-o$tmp" | Out-Null   # darwin symlink errors are expected & harmless
  Copy-Item "$tmp\rcedit-x64.exe" "build\rcedit\rcedit-x64.exe" -Force
  Write-Output "rcedit-x64.exe ready"
} else {
  Write-Output "rcedit already present"
}
