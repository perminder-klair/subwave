@echo off
chcp 65001 >nul
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\SubWave-Windows.ps1" -Action menu
if errorlevel 1 pause
endlocal
