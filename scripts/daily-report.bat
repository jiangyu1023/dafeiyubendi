@echo off
cd /d %~dp0
node tools\daily-report-send.mjs >> %~dp0\state\daily-report.log 2>&1
