@echo off
REM Pull the latest bridge code from GitHub and restart the service.
REM Run as Administrator (net stop/start need admin).
setlocal
cd /d "%~dp0"
set SERVICE_NAME=SIALWhatsAppBridge

net session >nul 2>&1
if errorlevel 1 ( echo === Run as Administrator === & pause & exit /b 1 )
where git >nul 2>&1
if errorlevel 1 ( echo === Git not found in PATH === & pause & exit /b 1 )
if not exist ".git" ( echo === This folder is not a git clone === & pause & exit /b 1 )

echo Current commit:
git log -1 --oneline
echo.
for /f "delims=" %%h in ('git hash-object package.json') do set PKG_BEFORE=%%h

echo Stopping %SERVICE_NAME% ...
net stop %SERVICE_NAME%
echo.
echo Pulling latest from origin...
git pull --ff-only
if errorlevel 1 (
  echo.
  echo === git pull failed - restarting service so the bridge stays up ===
  net start %SERVICE_NAME%
  pause & exit /b 1
)
echo.
echo New commit:
git log -1 --oneline
echo.

for /f "delims=" %%h in ('git hash-object package.json') do set PKG_AFTER=%%h
if not "%PKG_BEFORE%"=="%PKG_AFTER%" (
  echo package.json changed - running npm install...
  call npm install
)

echo Starting %SERVICE_NAME% ...
net start %SERVICE_NAME%
timeout /t 3 /nobreak >nul
echo.
echo Done. Health:
powershell -NoProfile -Command "try{ Invoke-RestMethod http://localhost:3100/health -TimeoutSec 4 | ConvertTo-Json }catch{ 'unreachable' }"
echo.
pause
endlocal
