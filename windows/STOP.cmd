@echo off
chcp 65001 >nul
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\SubWave-Windows.ps1" -Action stop
if errorlevel 1 pause
