@echo off
rem ASR guard: start ASR if port 9881 is not listening.
rem Task FeiyuASR runs this every 10 minutes; log to asr_guard.log.
setlocal
set LOG=%~dp0..\scripts\asr_guard.log
netstat -ano | findstr ":9881 " | findstr LISTENING >nul
if not errorlevel 1 (
  echo [%date% %time%] port alive, skip >> "%LOG%"
  exit /b 0
)
echo [%date% %time%] starting ASR >> "%LOG%"
cd /d %~dp0..\scripts
start "" /min cmd /c "%~dp0..\scripts\start_asr.bat"
exit /b 0
