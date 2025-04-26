@echo off
chcp 950
title Node.js Installation
setlocal EnableDelayedExpansion

rem Check if Node.js is installed
where node >nul 2>&1
if %errorlevel% equ 0 (
  echo Node.js is already installed, version:
  node -v
  ) else (
  echo Installing Node.js...
  
  rem Install Node.js LTS using winget
  winget install OpenJS.NodeJS.LTS
  if %errorlevel% neq 0 (
    echo Node.js installation failed
    timeout /t 10
    pause
    exit /b 1
  )
  
  echo Node.js installation completed
  echo Updating environment variables...
  
  rem Refresh PATH
  set "PATH=%PATH%;%ProgramFiles%\nodejs"
  
  timeout /t 3
  start "" "%~f0"
)

rem Verify installation
echo Verifying Node.js installation...
node -v
if %errorlevel% neq 0 (
  echo Node.js is not properly installed
  echo Please restart your computer and try again
  timeout /t 3
  pause
  exit /b 1
)

rem update files
echo downloading files...
echo Downloading app.js...
powershell -Command "(New-Object Net.WebClient).DownloadFile('https://raw.githubusercontent.com/SoRcKwYo/wsbot/main/app.js', 'app.js')"
if not exist "package.json" (
  echo Downloading package.json...
  powershell -Command "(New-Object Net.WebClient).DownloadFile('https://raw.githubusercontent.com/SoRcKwYo/wsbot/main/package.json', 'package.json')"
)

rem update html
if not exist "public" mkdir public
echo Downloading index.html...
powershell -Command "(New-Object Net.WebClient).DownloadFile('https://raw.githubusercontent.com/SoRcKwYo/wsbot/main/public/index.html', 'public/index.html')"

rem Check if package.json exists
echo Verifying npm packages...
if not exist "node_modules" (
  echo Installing packages...
  npm i package.json
  if %errorlevel% neq 0 (
    echo Package installation failed
    timeout /t 3
    pause
    exit /b 1
  )
  echo Packages installed successfully
  echo Restarting script...
  timeout /t 3
  start "" "%~f0"
  exit /b 0
)

rem start
echo Starting application...
start /B npm start

rem Wait for server to be ready
:WAIT_LOOP
timeout /t 2 >nul
powershell -Command "try { $response = Invoke-WebRequest -Uri 'http://localhost:3333' -Method HEAD; exit 0 } catch { exit 1 }"
if %errorlevel% neq 0 (
  echo Waiting for server to start...
  goto WAIT_LOOP
)

echo Server is ready!
echo Opening browser...
start http://localhost:3333
pause
