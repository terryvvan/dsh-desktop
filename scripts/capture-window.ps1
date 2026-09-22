<#
本机截图工具（零依赖：.NET System.Drawing + user32 P/Invoke，不装任何第三方东西）。

用途：把桌面端窗口 / 整屏截下来，落到工作区文件，然后用 read_image 自己看
（配合 scripts\crop-image.ps1 拆块，就能在超过我识图分辨率上限时逐块精读）。

## 用法
# 列出候选窗口（进程名 + 标题 + 句柄 + 位置）
pwsh -NoProfile -File scripts\capture-window.ps1 -List

# 截桌面端主窗口（默认进程名 DeepSeekHarness）
pwsh -NoProfile -File scripts\capture-window.ps1 -Process DeepSeekHarness -Out .tmp-screen\app.png

# 截整屏（含多显示器虚拟桌面）
pwsh -NoProfile -File scripts\capture-window.ps1 -All -Out .tmp-screen\screen.png

# 用 PrintWindow 抓（窗口被遮挡也能抓，但 Electron 可能抓到黑图）
pwsh -NoProfile -File scripts\capture-window.ps1 -Process DeepSeekHarness -PrintWindow -Out .tmp-screen\pw.png

## 输出
打印 RESULT 行：文件、宽x高、unique 颜色数（很小时说明抓到了纯色/黑图，脚本会自动换另一种方式重抓一次）。
#>
[CmdletBinding()]
param(
  [string]$Process = 'DeepSeekHarness',
  [string]$Title = '',
  [string]$Out = '',
  [switch]$All,
  [switch]$PrintWindow,
  [switch]$List,
  [int]$DelayMs = 500
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public struct RECT { public int Left, Top, Right, Bottom; }
public class Win32Cap {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int max);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@

try { [Win32Cap]::SetProcessDPIAware() | Out-Null } catch { }

function Get-Title([IntPtr]$h) {
  $len = [Win32Cap]::GetWindowTextLength($h)
  if ($len -le 0) { return '' }
  $sb = New-Object System.Text.StringBuilder ($len + 2)
  [void][Win32Cap]::GetWindowText($h, $sb, $sb.Capacity)
  return $sb.ToString()
}

if ($List) {
  $procs = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 }
  foreach ($p in $procs) {
    $r = New-Object RECT
    [void][Win32Cap]::GetWindowRect($p.MainWindowHandle, [ref]$r)
    Write-Output ("WIN pid={0} proc={1} title='{2}' rect={3},{4},{5},{6} visible={7}" -f $p.Id, $p.ProcessName, (Get-Title $p.MainWindowHandle), $r.Left, $r.Top, ($r.Right - $r.Left), ($r.Bottom - $r.Top), [Win32Cap]::IsWindowVisible($p.MainWindowHandle))
  }
  return
}

if (-not $Out) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $Out = Join-Path (Join-Path (Get-Location) '.tmp-screen') ("shot-" + $stamp + ".png")
}
if (-not [System.IO.Path]::IsPathRooted($Out)) { $Out = Join-Path (Get-Location) $Out }
$outDir = Split-Path -Parent $Out
if ($outDir -and -not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

function Save-Bitmap($bmp, [string]$file) {
  $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  # 采样统计颜色数，判断是不是黑图/纯色
  $colors = New-Object 'System.Collections.Generic.HashSet[int]'
  $sx = [Math]::Max(1, [int]($bmp.Width / 40)); $sy = [Math]::Max(1, [int]($bmp.Height / 40))
  for ($x = 0; $x -lt $bmp.Width; $x += $sx) {
    for ($y = 0; $y -lt $bmp.Height; $y += $sy) { [void]$colors.Add($bmp.GetPixel($x, $y).ToArgb()) }
  }
  Write-Output ("RESULT {0} {1}x{2} sampledColors={3}" -f $file, $bmp.Width, $bmp.Height, $colors.Count)
  return $colors.Count
}

function Capture-Rect([int]$x, [int]$y, [int]$w, [int]$h) {
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)))
  $g.Dispose()
  return $bmp
}

if ($All) {
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = Capture-Rect $vs.X $vs.Y $vs.Width $vs.Height
  $n = Save-Bitmap $bmp $Out
  if ($n -le 2) { Write-Output "WARN 抓到纯色图（可能被锁屏/黑屏挡住）" }
  $bmp.Dispose()
  return
}

# 找目标窗口
$target = $null
if ($Title) {
  $target = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and (Get-Title $_.MainWindowHandle) -match $Title } | Select-Object -First 1
} else {
  $target = Get-Process -Name $Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
}
if (-not $target) { throw "没找到窗口：进程 '$Process' 标题正则 '$Title'。用 -List 看有哪些。" }

$h = $target.MainWindowHandle
[void][Win32Cap]::ShowWindow($h, 9)      # SW_RESTORE
[void][Win32Cap]::SetForegroundWindow($h)
Start-Sleep -Milliseconds $DelayMs

$r = New-Object RECT
[void][Win32Cap]::GetWindowRect($h, [ref]$r)
$w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
if ($w -le 0 -or $hh -le 0) { throw "窗口尺寸异常：${w}x${hh}" }

if ($PrintWindow) {
  $bmp = New-Object System.Drawing.Bitmap($w, $hh)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  [void][Win32Cap]::PrintWindow($h, $hdc, 2)   # PW_RENDERFULLCONTENT
  $g.ReleaseHdc($hdc)
  $g.Dispose()
  $n = Save-Bitmap $bmp $Out
  if ($n -le 2) {
    Write-Output "NOTE PrintWindow 抓到纯色图，改用屏幕拷贝重抓"
    $bmp.Dispose()
    $bmp = Capture-Rect $r.Left $r.Top $w $hh
    [void](Save-Bitmap $bmp $Out)
  }
  $bmp.Dispose()
} else {
  $bmp = Capture-Rect $r.Left $r.Top $w $hh
  $n = Save-Bitmap $bmp $Out
  if ($n -le 2) {
    Write-Output "NOTE 屏幕拷贝抓到纯色图（窗口可能被遮挡），改用 PrintWindow 重抓"
    $bmp.Dispose()
    $bmp = New-Object System.Drawing.Bitmap($w, $hh)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    [void][Win32Cap]::PrintWindow($h, $hdc, 2)
    $g.ReleaseHdc($hdc); $g.Dispose()
    [void](Save-Bitmap $bmp $Out)
  }
  $bmp.Dispose()
}
Write-Output ("WINDOW pid={0} proc={1} rect={2},{3},{4},{5}" -f $target.Id, $target.ProcessName, $r.Left, $r.Top, $w, $hh)
