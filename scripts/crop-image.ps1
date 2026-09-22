<#
本机图片拆分/裁剪工具（零依赖：只用 Windows 自带 .NET System.Drawing，不调用任何第三方视觉 API、不依赖插件）。

用途：当一张图（尤其截图）超过我自身识图的分辨率上限（read_image 会把图缩到总面积 ≈640,000 px 再交给我看，
超限后小字会被抹平）时，先用本脚本把图切成每块都远小于上限的瓦片，再逐个识别。

## 判据
- 宽 × 高 > 640,000 ⇒ 超限，需要拆。
- 16:10 截图的安全块 ≈ 1012×632；本脚本默认 MaxPixels=600000，留安全余量。

## 用法（例子）
# 1) 只看信息：尺寸、MP、自动拆几块
pwsh -NoProfile -File scripts\crop-image.ps1 -Path shot.png -Info

# 2) 自动网格拆块（每块 ≤600000 px，带 40px 重叠防切断文字）
pwsh -NoProfile -File scripts\crop-image.ps1 -Path shot.png -Auto -Overlap 40

# 3) 指定几行几列
pwsh -NoProfile -File scripts\crop-image.ps1 -Path shot.png -Cols 3 -Rows 3

# 4) 只裁剪一块（粗读定位后精读局部）：box = x,y,w,h
pwsh -NoProfile -File scripts\crop-image.ps1 -Path shot.png -Box "1200,300,900,400" -Scale 2 -Out .tmp-vision\zoom.png

# 5) 对角坐标写法（截图量出来的 x1,y1,x2,y2）
pwsh -NoProfile -File scripts\crop-image.ps1 -Path shot.png -Region "1200,300,2100,700" -Out .tmp-vision\zoom.png

# 6) 整图等比缩放成一块能直读的（保留全貌用）
pwsh -NoProfile -File scripts\crop-image.ps1 -Path shot.png -Fit -Out .tmp-vision\overview.png

## 输出
- 瓦片写入 -OutDir（默认 <工作区>\.tmp-vision\crop-<时间戳>\），文件名 <Prefix>-r{行}c{列}.png。
- 每块都会打印一行清单：`TILE <文件> <宽>x<高> src=(x,y,w,h)`，据此可以把读到的内容映射回原图坐标。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [switch]$Info,
  [switch]$Auto,
  [int]$Cols = 0,
  [int]$Rows = 0,
  [string]$Box = '',
  [string]$Region = '',
  [double]$Scale = 1,
  [int]$MaxPixels = 600000,
  [int]$Overlap = 0,
  [switch]$Fit,
  [string]$Out = '',
  [string]$OutDir = '',
  [string]$Prefix = 'tile'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path -LiteralPath $Path)) { throw "找不到图片：$Path" }
$src = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $Path).Path)
$W = $src.Width; $H = $src.Height; $mp = [Math]::Round(($W * $H) / 1e6, 3)

function Write-Tile([System.Drawing.Image]$img, [string]$file, [string]$note) {
  $img.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output ("TILE {0} {1}x{2} {3}" -f $file, $img.Width, $img.Height, $note)
}

function New-Canvas([int]$w, [int]$h) {
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  return @{ bmp = $bmp; g = $g }
}

function Crop-Scaled([int]$x, [int]$y, [int]$w, [int]$h, [double]$scale) {
  $ow = [int][Math]::Max(1, [Math]::Round($w * $scale)); $oh = [int][Math]::Max(1, [Math]::Round($h * $scale))
  $c = New-Canvas $ow $oh
  $dst = New-Object System.Drawing.Rectangle(0, 0, $ow, $oh)
  $sr = New-Object System.Drawing.Rectangle($x, $y, $w, $h)
  $c.g.DrawImage($src, $dst, $sr, [System.Drawing.GraphicsUnit]::Pixel)
  $c.g.Dispose()
  return $c.bmp
}

try {
  if ($Info) {
    Write-Output ("INFO {0} {1}x{2} = {3} MP" -f (Split-Path -Leaf $Path), $W, $H, $mp)
    if ($W * $H -gt 640000) { Write-Output "VERDICT 超限：必须拆块后再读（read_image 会缩到 ≈0.64MP，小字会被抹平）" }
    else { Write-Output "VERDICT 未超限：可直接 read_image 整图读" }
    $bestC = 0; $bestR = 0; $bestN = [int]::MaxValue
    for ($c = 1; $c -le 10; $c++) {
      for ($r = 1; $r -le 10; $r++) {
        $tw = [Math]::Ceiling($W / $c); $th = [Math]::Ceiling($H / $r)
        if ($tw * $th -le $MaxPixels) { $n = $c * $r; if ($n -lt $bestN) { $bestN = $n; $bestC = $c; $bestR = $r } }
      }
    }
    if ($bestN -eq [int]::MaxValue) { Write-Output "GRID 无法在 MaxPixels=$MaxPixels 内拆块（图太大）" }
    else { Write-Output ("GRID 自动拆块建议：{0} 列 × {1} 行 = {2} 块，每块 {3}x{4}" -f $bestC, $bestR, $bestN, [Math]::Ceiling($W / $bestC), [Math]::Ceiling($H / $bestR)) }
    return
  }

  if (-not $OutDir) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $OutDir = Join-Path (Join-Path (Get-Location) '.tmp-vision') ("crop-" + $stamp)
  }
  if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
  $OutDirFull = (Resolve-Path -LiteralPath $OutDir).Path

  # 单块模式：-Box / -Region / -Fit
  if ($Box -or $Region -or $Fit) {
    if ($Fit) {
      $sc = [Math]::Min(1.0, [Math]::Sqrt($MaxPixels / ($W * $H)))
      $bmp = Crop-Scaled 0 0 $W $H $sc
      $target = if ($Out) { $Out } else { Join-Path $OutDirFull ("{0}-fit.png" -f $Prefix) }
      if (-not [System.IO.Path]::IsPathRooted($target)) { $target = Join-Path (Get-Location) $target }
      $dir = Split-Path -Parent $target; if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
      Write-Tile $bmp $target ("src=(0,0,$W,$H) scale=$([Math]::Round($sc,3))")
      return
    }
    if ($Region) {
      $p = $Region -split ','; if ($p.Count -ne 4) { throw "-Region 需要 x1,y1,x2,y2" }
      $x1 = [int]$p[0]; $y1 = [int]$p[1]; $x2 = [int]$p[2]; $y2 = [int]$p[3]
      $bx = $x1; $by = $y1; $bw = $x2 - $x1; $bh = $y2 - $y1
    }
    else {
      $p = $Box -split ','; if ($p.Count -ne 4) { throw "-Box 需要 x,y,w,h" }
      $bx = [int]$p[0]; $by = [int]$p[1]; $bw = [int]$p[2]; $bh = [int]$p[3]
    }
    if ($bw -le 0 -or $bh -le 0) { throw "裁剪区域宽高必须为正：$bw x $bh" }
    if ($bx -lt 0) { $bx = 0 }; if ($by -lt 0) { $by = 0 }
    if ($bx + $bw -gt $W) { $bw = $W - $bx }; if ($by + $bh -gt $H) { $bh = $H - $by }
    $bmp = Crop-Scaled $bx $by $bw $bh $Scale
    $target = if ($Out) { $Out } else { Join-Path $OutDirFull ("{0}-x{1}y{2}.png" -f $Prefix, $bx, $by) }
    if (-not [System.IO.Path]::IsPathRooted($target)) { $target = Join-Path (Get-Location) $target }
    $dir = Split-Path -Parent $target; if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $note = "src=($bx,$by,$bw,$bh) scale=$Scale"
    if ($bw * $bh -gt 640000) { $note += "  [警告：该块仍超过 0.64MP，建议再拆]" }
    Write-Tile $bmp $target $note
    return
  }

  # 网格模式
  $c = $Cols; $r = $Rows
  if ($c -le 0 -or $r -le 0) {
    $bestC = 1; $bestR = 1; $bestN = [int]::MaxValue
    for ($cc = 1; $cc -le 10; $cc++) {
      for ($rr = 1; $rr -le 10; $rr++) {
        $tw = [Math]::Ceiling($W / $cc); $th = [Math]::Ceiling($H / $rr)
        if ($tw * $th -le $MaxPixels) { $n = $cc * $rr; if ($n -lt $bestN) { $bestN = $n; $bestC = $cc; $bestR = $rr } }
      }
    }
    $c = $bestC; $r = $bestR
  }
  $tw = [Math]::Ceiling($W / $c); $th = [Math]::Ceiling($H / $r)
  Write-Output ("GRID {0} 列 × {1} 行，每块约 {2}x{3}，overlap={4}" -f $c, $r, $tw, $th, $Overlap)
  for ($ri = 0; $ri -lt $r; $ri++) {
    for ($ci = 0; $ci -lt $c; $ci++) {
      $x = [int]([Math]::Max(0, $ci * $tw - $(if ($ci -gt 0) { $Overlap } else { 0 })))
      $y = [int]([Math]::Max(0, $ri * $th - $(if ($ri -gt 0) { $Overlap } else { 0 })))
      $x2 = [int]([Math]::Min($W, ($ci + 1) * $tw + $(if ($ci -lt $c - 1) { $Overlap } else { 0 })))
      $y2 = [int]([Math]::Min($H, ($ri + 1) * $th + $(if ($ri -lt $r - 1) { $Overlap } else { 0 })))
      $bw = $x2 - $x; $bh = $y2 - $y
      $bmp = Crop-Scaled $x $y $bw $bh $Scale
      $file = Join-Path $OutDirFull ("{0}-r{1}c{2}.png" -f $Prefix, ($ri + 1), ($ci + 1))
      Write-Tile $bmp $file ("src=($x,$y,$bw,$bh) scale=$Scale")
      $bmp.Dispose()
    }
  }
  Write-Output ("OUTDIR {0}" -f $OutDirFull)
}
finally {
  if ($src) { $src.Dispose() }
}
