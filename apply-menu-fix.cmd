@echo off
chcp 65001 >nul
setlocal EnableExtensions
set "ROOT=F:\v\project\dsh-desktop"
set "RES=%ROOT%\dist\win-unpacked\resources"
set "NEW=%RES%\app.asar.new"
set "CUR=%RES%\app.asar"
set "EXE=%ROOT%\dist\win-unpacked\DeepSeekHarness.exe"
set "LOG=%ROOT%\menu-fix-log.txt"

echo ==== DSH 菜单栏看门狗修复  %DATE% %TIME% ==== > "%LOG%"

if not exist "%NEW%" goto nonew

echo [1/6] 关闭 DeepSeekHarness.exe（含子进程） >> "%LOG%"
taskkill /IM DeepSeekHarness.exe /F /T >> "%LOG%" 2>&1

echo [2/6] 等待文件锁释放（最多 60 秒） >> "%LOG%"
set /a wait=0
:waitloop
timeout /t 1 /nobreak >nul
tasklist /FI "IMAGENAME eq DeepSeekHarness.exe" 2>nul | find /I "DeepSeekHarness.exe" >nul
if not errorlevel 1 goto waitmore
goto trycopy
:waitmore
set /a wait+=1
if %wait% LSS 60 goto waitloop

:trycopy
echo     已等待 %wait% 秒，开始覆盖 >> "%LOG%"
echo [3/6] 覆盖 app.asar（最多 60 次） >> "%LOG%"
set /a n=0
:retry
set /a n+=1
copy /y "%NEW%" "%CUR%" >> "%LOG%" 2>&1
if errorlevel 1 goto copyfail
goto verify

:copyfail
if %n% GEQ 60 goto copyfailed
timeout /t 1 /nobreak >nul
goto retry

:copyfailed
echo [x] 覆盖失败：连续 %n% 次都被占用。 >> "%LOG%"
echo     请先在任务管理器里结束所有 DeepSeekHarness.exe，再重跑本脚本。 >> "%LOG%"
echo [x] FAILED after %n% tries — see menu-fix-log.txt
pause
exit /b 1

:verify
echo [4/6] 校验文件大小 >> "%LOG%"
for %%A in ("%NEW%") do set "SZN=%%~zA"
for %%A in ("%CUR%") do set "SZC=%%~zA"
echo     期望(新) %SZN% 字节 / 实际(app.asar) %SZC% 字节 >> "%LOG%"
if not "%SZN%"=="%SZC%" goto sizemismatch

echo [5/6] 启动桌面端 >> "%LOG%"
start "" "%EXE%"
echo [6/6] 成功：app.asar 已更新为 %SZC% 字节，桌面端已重启。 >> "%LOG%"
echo OK: app.asar updated to %SZC% bytes, app restarted.
timeout /t 4 /nobreak >nul
exit /b 0

:sizemismatch
echo [x] 大小不一致，说明没有真正覆盖成功。 >> "%LOG%"
echo [x] SIZE MISMATCH — see menu-fix-log.txt
pause
exit /b 1

:nonew
echo [x] 找不到 %NEW% >> "%LOG%"
echo [x] 缺少 app.asar.new — 请先运行：node scripts\patch-app-asar.mjs --apply
pause
exit /b 1
