@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js fehlt. Bitte zuerst https://nodejs.org/ installieren.
  pause
  exit /b 1
)
echo FootPredict starten: http://localhost:3000
start "" http://localhost:3000
node server.js
pause
