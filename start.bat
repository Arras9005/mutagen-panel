@echo off
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js not found. Install Node 18 or newer first.
  pause
  exit /b 1
)
if not exist config.json (
  copy config.example.json config.json >nul
  echo config.json created. Edit it, save, then run start.bat again.
  notepad config.json
  pause
  exit /b 0
)
if not exist node_modules\ssh2 (
  echo Installing dependencies, first run only...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)
call npm start
pause
