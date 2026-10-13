@echo off
rem Start Spritespeak locally: installs dependencies on first run, then opens
rem the app in your browser (only reachable from this computer).
cd /d "%~dp0"

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)

if not exist node_modules\ (
  echo Installing dependencies, this takes a minute the first time...
  call npm.cmd ci
  if errorlevel 1 (
    echo Installing dependencies failed.
    pause
    exit /b 1
  )
)

echo Starting Spritespeak... (close this window or press Ctrl+C to stop it)
call npm.cmd run dev -- --open
if errorlevel 1 pause
