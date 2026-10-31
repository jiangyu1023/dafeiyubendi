@echo off
rem Resident ASR service for incoming QQ voice messages (bridge calls 127.0.0.1:9881/asr).
set MODELSCOPE_CACHE=%~dp0..\voice\gpt-sovits\modelscope_cache
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1
set PATH=%~dp0..\tools\ffmpeg;%PATH%
"%~dp0..\voice\gpt-sovits\venv\Scripts\python.exe" "%~dp0..\scripts\asr_server.py" 9881 >> "%~dp0..\scripts\asr.log" 2>&1
