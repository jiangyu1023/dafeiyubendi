@echo off
cd /d %~dp0
node tools\balance-snapshot.mjs >> %~dp0\state\balance.log 2>&1
