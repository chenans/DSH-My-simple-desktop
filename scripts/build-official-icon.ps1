# Generates app icons from assets/app-logo.png (2048x2048 square).
# Simply resizes the source to target sizes — no rounding, no padding.
# Produces icon.png / icon.ico (multi-size) / tray-icon.png / icon-preview.png.
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = "Stop"
$base = (Get-Location).Path
$srcPath = Join-Path $base "assets\app-logo.png"

if (-not (Test-Path $srcPath)) {
  Write-Error "Source image not found: $srcPath"
  exit 1
}

New-Item -ItemType Directory -Force -Path "assets" | Out-Null

# Load source image
$srcBmp = [System.Drawing.Bitmap]::new($srcPath)

# ── Helper: resize to target size ──────────────────────────────────────
function Resize-To($bmp, $size) {
  $out = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($out)
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.DrawImage($bmp, 0, 0, $size, $size)
  $g.Dispose()
  return $out
}

Write-Output "Source: $($srcBmp.Width)x$($srcBmp.Height)"

# ── icon.png (256px) ───────────────────────────────────────────────────
Write-Output "Generating icon.png (256x256)..."
$icon256 = Resize-To $srcBmp 256
$icon256.Save((Join-Path $base "assets\icon.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$icon256.Dispose()

# ── icon-preview.png (1024px) ──────────────────────────────────────────
Write-Output "Generating icon-preview.png (1024x1024)..."
$prev = Resize-To $srcBmp 1024
$prev.Save((Join-Path $base "assets\icon-preview.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$prev.Dispose()

# ── tray-icon.png (32px) ───────────────────────────────────────────────
Write-Output "Generating tray-icon.png (32x32)..."
$tray = Resize-To $srcBmp 32
$tray.Save((Join-Path $base "assets\tray-icon.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$tray.Dispose()

# ── icon.ico (multi-size) ──────────────────────────────────────────────
Write-Output "Generating icon.ico..."
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$pngs = @{}
foreach ($s in $sizes) {
  Write-Output "  ${s}x${s}..."
  $b = Resize-To $srcBmp $s
  $ms = New-Object System.IO.MemoryStream
  $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngs[$s] = $ms.ToArray()
  $b.Dispose()
}
$ms0 = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms0)
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
foreach ($s in $sizes) {
  $data = $pngs[$s]
  $bw.Write([byte]($s -band 0xFF)); $bw.Write([byte]($s -band 0xFF))
  $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([uint16]1); $bw.Write([uint16]32)
  $bw.Write([uint32]$data.Length); $bw.Write([uint32]$offset)
  $offset += $data.Length
}
foreach ($s in $sizes) { $bw.Write($pngs[$s]) }
$bw.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $base "assets\icon.ico"), $ms0.ToArray())

$srcBmp.Dispose()

Write-Output ""
Write-Output "Done!"
Write-Output ("icon.png: " + (Get-Item assets\icon.png).Length + " bytes")
Write-Output ("icon.ico: " + (Get-Item assets\icon.ico).Length + " bytes")
Write-Output ("icon-preview.png: " + (Get-Item assets\icon-preview.png).Length + " bytes")
Write-Output ("tray-icon.png: " + (Get-Item assets\tray-icon.png).Length + " bytes")
