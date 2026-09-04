@echo off
cd /d "%~dp0"
echo Starting Emulingo...
start "" http://localhost:5173
npm.cmd run dev
