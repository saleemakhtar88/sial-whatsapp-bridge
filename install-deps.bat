@echo off
REM ===========================================================================
REM  SIAL WhatsApp Bridge - robust dependency installer
REM
REM  - Downloads puppeteer's Chromium into a PROJECT-LOCAL cache (.cache\puppeteer)
REM    so the Windows service (LocalSystem) can find it later.
REM  - Stops the service / kills node.exe first to free file locks.
REM  - Wipes a partial install and retries with an alternate Chrome mirror.
REM  - Creates .env from .env.example if missing.
REM
REM  Safe to re-run. Run as Administrator if the service is already registered.
REM ===========================================================================
setlocal EnableDelayedExpansion
cd /d "%~dp0"
set SERVICE_NAME=SIALWhatsAppBridge
set PUPPETEER_CACHE_DIR=%~dp0.cache\puppeteer

echo.
echo ===========================================================================
echo  SIAL WhatsApp Bridge - install dependencies (auto-recovering)
echo ===========================================================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo === Node.js not found. Install Node.js LTS from https://nodejs.org/ first. ===
  pause & exit /b 1
)
for /f "delims=" %%i in ('node --version') do echo Node version: %%i

REM ----- Free file locks -----
sc query %SERVICE_NAME% >nul 2>&1
if not errorlevel 1 (
  echo Stopping %SERVICE_NAME% so file locks are released...
  net stop %SERVICE_NAME% >nul 2>&1
)
taskkill /F /IM node.exe >nul 2>&1

REM ----- Detect partial install -----
set NEED_WIPE=
if exist node_modules (
  if not exist "node_modules\puppeteer\package.json"       set NEED_WIPE=1
  if not exist "node_modules\whatsapp-web.js\package.json"  set NEED_WIPE=1
  if not exist "node_modules\express\package.json"          set NEED_WIPE=1
)
if defined NEED_WIPE (
  echo Partial install detected. Cleaning node_modules...
  rmdir /s /q node_modules 2>nul
  if exist node_modules (
    echo === Could not delete node_modules - close Explorer/VS Code here, then re-run. ===
    pause & exit /b 1
  )
)

REM ----- Wipe an incomplete project-local Chrome download -----
set CHROME_OK=
if exist "%PUPPETEER_CACHE_DIR%\chrome" (
  for /d %%d in ("%PUPPETEER_CACHE_DIR%\chrome\win64-*") do (
    if exist "%%d\chrome-win64\chrome.exe" set CHROME_OK=1
  )
  if not defined CHROME_OK (
    echo Incomplete Chrome download found. Wiping...
    rmdir /s /q "%PUPPETEER_CACHE_DIR%\chrome" 2>nul
  )
)

REM ----- .env -----
if not exist ".env" (
  echo Creating .env from .env.example ...
  copy /y ".env.example" ".env" >nul
  echo.
  echo *** IMPORTANT: edit .env and set a real API_KEY ^(a long random string^). ***
  echo *** It must MATCH WHATSAPP_API_KEY in the SIAL app's .env.              ***
  echo.
)

REM ----- npm retry settings for flaky networks -----
call npm config set fetch-retries 5 >nul 2>&1
call npm config set fetch-retry-mintimeout 20000 >nul 2>&1
call npm config set fetch-retry-maxtimeout 120000 >nul 2>&1

echo.
echo ===========================================================================
echo  Attempt 1/2 - npm install (downloads ~250 MB Chromium into .cache\puppeteer)
echo ===========================================================================
echo.
call npm install
if not errorlevel 1 goto :success

echo.
echo === Attempt 1 failed. Cleaning up + trying alternate Chrome mirror... ===
rmdir /s /q node_modules 2>nul
rmdir /s /q "%PUPPETEER_CACHE_DIR%" 2>nul
set PUPPETEER_DOWNLOAD_BASE_URL=https://npmmirror.com/mirrors/chrome-for-testing
echo.
echo ===========================================================================
echo  Attempt 2/2 - npm install via npmmirror.com Chrome mirror
echo ===========================================================================
echo.
call npm install
if not errorlevel 1 goto :success

echo.
echo ===========================================================================
echo  === Install failed after 2 attempts ===
echo ===========================================================================
echo Likely causes:
echo   1. No outbound network to npm registry / Chrome storage
echo   2. Antivirus blocking node.exe / file writes. Try AV exclusions:
echo        powershell -Command "Add-MpPreference -ExclusionPath '%~dp0'"
echo   3. Disk full or permission issue
echo Full npm log at: %%LOCALAPPDATA%%\npm-cache\_logs\
echo.
pause & exit /b 1

:success
echo.
echo ===========================================================================
echo  === Done - dependencies + project-local Chromium installed ===
echo.
echo  Next steps:
echo    1. Make sure .env has a real API_KEY     (notepad .env)
echo    2. install-service.bat                   (Administrator - registers service)
echo.
echo  Or test in foreground first:
echo    node src\server.js      then open  http://localhost:3100/qr
echo ===========================================================================
echo.
pause
endlocal & exit /b 0
