@echo off
chcp 65001 >nul
title Feiyu Restore
echo ================================
echo  Feiyu - one-click restore
echo ================================
echo.

cd /d %~dp0

echo [1/5] check DSH url...
node tools\check-dsh-url.mjs --quiet
if errorlevel 1 (
  echo   DSH unreachable: open DeepSeek Harness and check config.json dsh.baseUrl
  echo   ^(continuing; bridge will retry^)
)

echo [2/5] QQ gateway...
call :probe 3000
if errorlevel 1 (
  echo   SnowLuma is NOT started by this script (EULA). Please start it yourself:
  echo     double-click launcher.bat in your SnowLuma folder, then scan the QR code.
  pause
  echo   waiting for port 3000 (start SnowLuma manually)...
  call :waitport 3000 180
) else (
  echo   already running
)

echo [3/5] bridge + panel...
call :probe 3100
if errorlevel 1 (
  start "" /min "%~dp0\start-bridge.bat"
)
call :probe 3200
if errorlevel 1 (
  start "" /min node tools\console-panel.mjs
)
call :waitport 3100 60
call :waitport 3200 10

echo [4/5] ASR...
call :probe 9881
if errorlevel 1 (
  start "" /min "%~dp0..\scripts\start-asr.bat"
  call :waitport 9881 15
) else (
  echo   already running
)

echo.
echo ================================
echo  result:
for %%P in (3000 3100 3200 9881) do (
  call :probe %%P
  if errorlevel 1 (echo   port %%P  OFFLINE) else (echo   port %%P  online)
)
echo ================================
echo  open http://127.0.0.1:3200
echo.
exit /b 0

:probe
powershell -NoProfile -Command "try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('127.0.0.1',%1);$c.Close();exit 0}catch{exit 1}" >nul 2>&1
exit /b %errorlevel%

:waitport
setlocal
set PORT=%1
set MAX=%2
set /a N=0
:waitloop
powershell -NoProfile -Command "try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('127.0.0.1',%PORT%);$c.Close();exit 0}catch{exit 1}" >nul 2>&1
if not errorlevel 1 (
  echo   port %PORT% ready
  endlocal & exit /b 0
)
set /a N+=1
if %N% GEQ %MAX% (
  echo   port %PORT% timeout ^(%MAX%s^)
  endlocal & exit /b 1
)
ping -n 2 127.0.0.1 >nul
goto waitloop
