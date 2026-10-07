@echo off
REM One-click start for Windows. Double-click this file.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install the LTS version from https://nodejs.org ^(v20 or v22 recommended^), then run this again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing dependencies ^(first run only^)...
  call npm install --no-audit --no-fund
  if errorlevel 1 ( echo Install failed. See README "Troubleshooting". & pause & exit /b 1 )
)
if not exist .env copy .env.example .env >nul
start "" cmd /c "timeout /t 4 >nul & start http://localhost:3000/app"
call npm start
pause
