@echo off
cd /d "%~dp0"
rem DSH 端口不再自动探测：SnowLuma 的 5099 也会返回 401，会被误认成 DSH。
rem 需要换端口时，手动改 config.json 的 dsh.baseUrl，或运行：
rem   node tools\sync-dsh-url.mjs --force
echo [1/2] checking DSH at configured baseUrl...
node tools\check-dsh-url.mjs
if errorlevel 1 (
  echo.
  echo DSH 连不上。确认 DeepSeek Harness 已打开，并检查 config.json 的 dsh.baseUrl。
  pause
  exit /b 1
)
echo [2/2] starting bridge...
call start.bat
