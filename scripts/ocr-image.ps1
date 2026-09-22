# ocr-image.ps1 - local OCR for screenshots using the built-in Windows OCR engine
# (Windows.Media.Ocr / WinRT). Zero third-party dependencies.
#
# Why: read_image in this harness only exposes a file reference, not pixels, so text
# must be extracted locally to be usable. WinRT OCR ships with Windows and supports
# zh-Hans-CN + en here.
#
# Usage:
#   powershell -NoProfile -File scripts\ocr-image.ps1 -Path shot.png
#   powershell -NoProfile -File scripts\ocr-image.ps1 -Path shot.png -Upscale 2
#   powershell -NoProfile -File scripts\ocr-image.ps1 -Path shot.png -Words
#   powershell -NoProfile -File scripts\ocr-image.ps1 -Path shot.png -TextOnly
#   powershell -NoProfile -File scripts\ocr-image.ps1 -Path shot.png -Out out.txt
#
# NOTE: keep this file ASCII-only. This harness runs Windows PowerShell 5.1, which
# decodes BOM-less .ps1 as ANSI/GBK; non-ASCII text breaks parsing. Small UI text is
# often missed at scale 1, so pass -Upscale 2 or 3.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [int]$Upscale = 1,
  [string]$Lang = '',
  [switch]$Words,
  [switch]$TextOnly,
  [string]$Out = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
function Await($op, [Type]$resultType) {
  $m = $asTaskGeneric.MakeGenericMethod($resultType)
  $task = $m.Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  return $task.Result
}

[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null

if (-not [System.IO.Path]::IsPathRooted($Path)) { $Path = Join-Path (Get-Location) $Path }
if (-not (Test-Path -LiteralPath $Path)) { throw "image not found: $Path" }

$work = $Path
$tmp = $null
if ($Upscale -gt 1) {
  $img = [System.Drawing.Image]::FromFile($Path)
  $nw = [int]($img.Width * $Upscale)
  $nh = [int]($img.Height * $Upscale)
  $bmp = New-Object System.Drawing.Bitmap($nw, $nh)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($img, 0, 0, $nw, $nh)
  $g.Dispose()
  $img.Dispose()
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("ocr-up-" + [guid]::NewGuid().ToString('N') + ".png")
  $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $work = $tmp
}

try {
  $engine = $null
  if ($Lang) {
    $l = New-Object Windows.Globalization.Language($Lang)
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($l)
  } else {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  }
  if ($null -eq $engine) { throw "OCR engine unavailable (no language pack?)" }

  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($work)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $soft = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result = Await ($engine.RecognizeAsync($soft)) ([Windows.Media.Ocr.OcrResult])

  $lines = @()
  foreach ($line in $result.Lines) {
    # enumerate words one by one: indexing a WinRT IVectorView with [0] handed back
    # the whole collection here (PowerShell 5.1), which then made $r.X an Object[].
    $minX = [double]::MaxValue; $minY = [double]::MaxValue
    $maxR = 0.0; $maxB = 0.0
    $wordList = @()
    foreach ($wd in $line.Words) {
      $r = $wd.BoundingRect
      if ($r.X -lt $minX) { $minX = [double]$r.X }
      if ($r.Y -lt $minY) { $minY = [double]$r.Y }
      if (($r.X + $r.Width) -gt $maxR) { $maxR = [double]($r.X + $r.Width) }
      if (($r.Y + $r.Height) -gt $maxB) { $maxB = [double]($r.Y + $r.Height) }
      $wordList += $wd
    }
    $x = 0; $y = 0; $w = 0; $h = 0
    if ($wordList.Count -gt 0) {
      $x = [int]($minX / $Upscale); $y = [int]($minY / $Upscale)
      $w = [int](($maxR - $minX) / $Upscale); $h = [int](($maxB - $minY) / $Upscale)
    }
    $lines += [pscustomobject]@{ X = $x; Y = $y; W = $w; H = $h; Text = $line.Text; Words = $wordList }
  }

  $sb = New-Object System.Text.StringBuilder
  [void]$sb.AppendLine(("OCR engine={0} upscale={1} lines={2}" -f $engine.RecognizerLanguage.LanguageTag, $Upscale, $lines.Count))
  if (-not $TextOnly) {
    foreach ($l in $lines) { [void]$sb.AppendLine(("L y={0} x={1} w={2} h={3} | {4}" -f $l.Y, $l.X, $l.W, $l.H, $l.Text)) }
    if ($Words) {
      foreach ($l in $lines) {
        foreach ($wd in $l.Words) {
          $r = $wd.BoundingRect
          [void]$sb.AppendLine(("W y={0} x={1} w={2} h={3} | {4}" -f [int]($r.Y / $Upscale), [int]($r.X / $Upscale), [int]($r.Width / $Upscale), [int]($r.Height / $Upscale), $wd.Text))
        }
      }
    }
    [void]$sb.AppendLine("TEXT-BEGIN")
  }
  foreach ($l in $lines) { [void]$sb.AppendLine($l.Text) }
  if (-not $TextOnly) { [void]$sb.AppendLine("TEXT-END") }
  $text = $sb.ToString()

  if ($Out) {
    if (-not [System.IO.Path]::IsPathRooted($Out)) { $Out = Join-Path (Get-Location) $Out }
    $dir = Split-Path -Parent $Out
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [System.IO.File]::WriteAllText($Out, $text, (New-Object System.Text.UTF8Encoding($false)))
    Write-Output ("OCR-SAVED {0} ({1} bytes)" -f $Out, (Get-Item -LiteralPath $Out).Length)
  }
  Write-Output $text
} finally {
  if ($tmp -and (Test-Path -LiteralPath $tmp)) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
}
