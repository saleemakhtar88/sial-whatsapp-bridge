@echo off
REM Show the bridge service state + /health + recent log lines.
setlocal
cd /d "%~dp0"
set SERVICE_NAME=SIALWhatsAppBridge
set PORT=3100

echo === Service state ===
sc query %SERVICE_NAME% | findstr /C:"STATE" 2>nul || echo (service not installed)
echo.
echo === Health (http://localhost:%PORT%/health) ===
powershell -NoProfile -Command "try{ Invoke-RestMethod http://localhost:%PORT%/health -TimeoutSec 4 | ConvertTo-Json }catch{ 'unreachable: ' + $_.Exception.Message }"
echo.
echo === logs\stdout.log (last 15 lines) ===
if exist "%~dp0logs\stdout.log" powershell -NoProfile -Command "Get-Content '%~dp0logs\stdout.log' -Tail 15"
echo.
echo === logs\stderr.log (last 15 lines) ===
if exist "%~dp0logs\stderr.log" powershell -NoProfile -Command "Get-Content '%~dp0logs\stderr.log' -Tail 15"
echo.
pause
endlocal
