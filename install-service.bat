@echo off
REM ===========================================================================
REM  SIAL WhatsApp Bridge - install as a Windows service via NSSM.  Run as Admin.
REM
REM  - Verifies .env has a real API_KEY (the bridge refuses to start without one).
REM  - Foreground smoke test of "node src\server.js" to catch boot crashes early.
REM  - Grants LocalSystem read+execute on the project (so it can launch the
REM    project-local Chromium) and full control on the session/cache/log dirs.
REM  - Installs + auto-starts the service, then polls /health to confirm it
REM    becomes ready OR shows a QR to scan.
REM ===========================================================================
setlocal EnableDelayedExpansion
cd /d "%~dp0"
set SERVICE_NAME=SIALWhatsAppBridge
set DISPLAY_NAME=SIAL WhatsApp Bridge
set DESCRIPTION=WhatsApp bridge for SIAL Apps (whatsapp-web.js, port 3100)
set PORT=3100
set SYSTEM_SID=*S-1-5-18

echo.
echo ===========================================================================
echo  SIAL WhatsApp Bridge - install Windows service
echo ===========================================================================
echo.

REM ----- 1. Admin + tool checks -----
net session >nul 2>&1
if errorlevel 1 ( echo === Run as Administrator === & pause & exit /b 1 )

where node >nul 2>&1
if errorlevel 1 ( echo === Node.js not found in PATH === & pause & exit /b 1 )
for /f "delims=" %%i in ('where node') do set NODE_EXE=%%i
for /f "delims=" %%i in ('node --version') do set NODE_VER=%%i

set NSSM_EXE=
where nssm >nul 2>&1
if not errorlevel 1 (
  for /f "delims=" %%i in ('where nssm') do set NSSM_EXE=%%i
) else (
  if exist "C:\nssm\nssm.exe"       set NSSM_EXE=C:\nssm\nssm.exe
  if exist "C:\nssm\win64\nssm.exe" set NSSM_EXE=C:\nssm\win64\nssm.exe
  if exist "%~dp0nssm\nssm.exe"     set NSSM_EXE=%~dp0nssm\nssm.exe
)
if "%NSSM_EXE%"=="" ( echo === NSSM not found ^(download from nssm.cc, put nssm.exe in C:\nssm^) === & pause & exit /b 1 )

for /f "delims=" %%i in ('whoami') do set WHOAMI_FULL=%%i
echo Node:    %NODE_EXE%  ^(%NODE_VER%^)
echo NSSM:    %NSSM_EXE%
echo Project: %~dp0
echo User:    %WHOAMI_FULL%
echo.

REM Refuse non-LTS Node (v25 crashes as a service; LTS lines are stable)
echo %NODE_VER% | findstr /R "^v20\. ^v22\. ^v24\." >nul
if errorlevel 1 (
  echo === WARNING: Node %NODE_VER% is not on an LTS line (v20/v22/v24). ===
  echo Non-LTS builds can crash as a Windows service. Install Node 22 LTS.
  choice /C YN /N /M "Continue anyway? (Y/N): "
  if errorlevel 2 exit /b 1
)

REM ----- 2. Files + .env sanity -----
if not exist "%~dp0node_modules\whatsapp-web.js" (
  echo === Dependencies missing - run install-deps.bat first === & pause & exit /b 1
)
if not exist "%~dp0src\server.js" ( echo === src\server.js not found === & pause & exit /b 1 )
if not exist "%~dp0.env" (
  echo === .env missing - run: copy .env.example .env  then set API_KEY === & pause & exit /b 1
)

REM API_KEY must be present, non-empty, and not the placeholder.
set KEY_OK=
findstr /B /C:"API_KEY=" .env >nul 2>&1 && set KEY_OK=1
findstr /B /C:"API_KEY=change-me-to-a-long-random-secret" .env >nul 2>&1 && set KEY_OK=
findstr /R /B /C:"API_KEY=$" .env >nul 2>&1 && set KEY_OK=
if not defined KEY_OK (
  echo === API_KEY is missing, empty, or still the placeholder in .env ===
  echo Set a long random API_KEY (must match WHATSAPP_API_KEY in the SIAL .env).
  notepad .env
  pause & exit /b 1
)

REM ----- 3. Module pre-flight -----
echo Running module pre-flight check...
node -e "var p=['express','whatsapp-web.js','qrcode','qrcode-terminal','winston','dotenv','puppeteer'];var bad=[];p.forEach(function(m){try{require(m);console.log('  OK   '+m);}catch(e){console.error('  FAIL '+m+' - '+e.message);bad.push(m);}});if(bad.length)process.exit(1);"
if errorlevel 1 (
  echo === A module failed to load - try: rmdir /s /q node_modules ^&^& install-deps.bat ===
  pause & exit /b 1
)
echo Pre-flight: all modules loadable.
echo.

REM ----- 4. Free port + remove any old service -----
set PROJ_DIR=%~dp0
if "%PROJ_DIR:~-1%"=="\" set PROJ_DIR=%PROJ_DIR:~0,-1%

netstat -ano | findstr :%PORT% >nul 2>&1
if not errorlevel 1 (
  for /f "tokens=5" %%p in ('netstat -ano ^| findstr :%PORT%') do (
    if not "%%p"=="0" taskkill /F /PID %%p >nul 2>&1
  )
  taskkill /F /IM node.exe >nul 2>&1
  timeout /t 2 /nobreak >nul
)

REM ----- 5. Foreground smoke test (8s) - catches API_KEY / boot crashes -----
echo ===========================================================================
echo  Smoke test: running "node src\server.js" for 8 seconds...
echo ===========================================================================
set SMOKE_OUT=%TEMP%\wabridge_smoke_out.txt
set SMOKE_ERR=%TEMP%\wabridge_smoke_err.txt
del "%SMOKE_OUT%" "%SMOKE_ERR%" 2>nul

powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Start-Process -FilePath '%NODE_EXE%' -ArgumentList 'src\server.js' -WorkingDirectory '%PROJ_DIR%' -NoNewWindow -PassThru -RedirectStandardOutput '%SMOKE_OUT%' -RedirectStandardError '%SMOKE_ERR%'; Start-Sleep -Seconds 8; if ($p.HasExited) { exit ($p.ExitCode + 100) } else { Stop-Process -Id $p.Id -Force; exit 0 }"
set SMOKE_RC=%ERRORLEVEL%

echo --- stdout ---
if exist "%SMOKE_OUT%" type "%SMOKE_OUT%"
echo --- stderr ---
if exist "%SMOKE_ERR%" type "%SMOKE_ERR%"
echo ---
echo.
taskkill /F /IM node.exe >nul 2>&1
timeout /t 2 /nobreak >nul

if not %SMOKE_RC%==0 (
  set /a NODE_EXIT=%SMOKE_RC% - 100
  echo === Node exited early with code !NODE_EXIT! - fix the error above first. ===
  echo Common: "API_KEY is missing" ^(set it in .env^), or a missing module.
  pause & exit /b 1
)
echo Smoke test passed - the bridge boots cleanly.
echo.

REM ----- 6. Grant LocalSystem access (project RX for Chromium; F on writable dirs) -----
echo Granting SYSTEM permissions (recurses node_modules + .cache - 30-90 sec)...
if not exist "%PROJ_DIR%\logs"         mkdir "%PROJ_DIR%\logs"
if not exist "%PROJ_DIR%\.wwebjs_auth"  mkdir "%PROJ_DIR%\.wwebjs_auth"
if not exist "%PROJ_DIR%\.wwebjs_cache" mkdir "%PROJ_DIR%\.wwebjs_cache"
icacls "%PROJ_DIR%" /grant "%SYSTEM_SID%:(OI)(CI)RX" /T /Q
icacls "%PROJ_DIR%\logs"          /grant "%SYSTEM_SID%:(OI)(CI)F" /T /Q
icacls "%PROJ_DIR%\.wwebjs_auth"  /grant "%SYSTEM_SID%:(OI)(CI)F" /T /Q
icacls "%PROJ_DIR%\.wwebjs_cache" /grant "%SYSTEM_SID%:(OI)(CI)F" /T /Q
echo SYSTEM permissions granted.
echo.

REM ----- 7. Remove old service + install fresh -----
"%NSSM_EXE%" status %SERVICE_NAME% >nul 2>&1
if not errorlevel 1 (
  echo Removing existing service...
  "%NSSM_EXE%" stop %SERVICE_NAME% >nul 2>&1
  "%NSSM_EXE%" remove %SERVICE_NAME% confirm >nul 2>&1
  timeout /t 2 /nobreak >nul
)

echo Installing service "%SERVICE_NAME%"...
"%NSSM_EXE%" install %SERVICE_NAME% "%NODE_EXE%" "src\server.js"
if errorlevel 1 ( echo === NSSM install failed === & pause & exit /b 1 )

"%NSSM_EXE%" set %SERVICE_NAME% AppDirectory "%PROJ_DIR%"
"%NSSM_EXE%" set %SERVICE_NAME% DisplayName  "%DISPLAY_NAME%"
"%NSSM_EXE%" set %SERVICE_NAME% Description  "%DESCRIPTION%"
"%NSSM_EXE%" set %SERVICE_NAME% Start        SERVICE_AUTO_START
"%NSSM_EXE%" set %SERVICE_NAME% AppStdout    "%PROJ_DIR%\logs\stdout.log"
"%NSSM_EXE%" set %SERVICE_NAME% AppStderr    "%PROJ_DIR%\logs\stderr.log"
"%NSSM_EXE%" set %SERVICE_NAME% AppStdoutCreationDisposition 4
"%NSSM_EXE%" set %SERVICE_NAME% AppStderrCreationDisposition 4
"%NSSM_EXE%" set %SERVICE_NAME% AppRotateFiles  1
"%NSSM_EXE%" set %SERVICE_NAME% AppRotateOnline 1
"%NSSM_EXE%" set %SERVICE_NAME% AppRotateBytes  10485760
"%NSSM_EXE%" set %SERVICE_NAME% AppExit Default Restart
"%NSSM_EXE%" set %SERVICE_NAME% AppRestartDelay 5000
"%NSSM_EXE%" set %SERVICE_NAME% AppThrottle 10000
"%NSSM_EXE%" set %SERVICE_NAME% AppStopMethodConsole 20000

del "%PROJ_DIR%\logs\stdout.log" "%PROJ_DIR%\logs\stderr.log" 2>nul
echo.
echo Starting service...
"%NSSM_EXE%" start %SERVICE_NAME% >nul 2>&1
timeout /t 5 /nobreak >nul

sc query %SERVICE_NAME% | findstr /C:"RUNNING" >nul
if errorlevel 1 (
  echo === Service did not reach RUNNING. Last log lines: ===
  if exist "%PROJ_DIR%\logs\stderr.log" type "%PROJ_DIR%\logs\stderr.log"
  if exist "%PROJ_DIR%\logs\stdout.log" type "%PROJ_DIR%\logs\stdout.log"
  echo.
  echo If you see a Chromium / browser launch error, re-run install-deps.bat.
  pause & exit /b 1
)

REM ----- 8. Poll /health (up to ~40s) for ready OR a QR -----
echo Service RUNNING. Waiting for WhatsApp to initialize (up to 40s)...
set HEALTH_OK=
for /l %%n in (1,1,8) do (
  if not defined HEALTH_OK (
    timeout /t 5 /nobreak >nul
    for /f "delims=" %%h in ('powershell -NoProfile -Command "try{(Invoke-RestMethod http://localhost:%PORT%/health -TimeoutSec 4) | ConvertTo-Json -Compress}catch{''}"') do set HEALTH=%%h
    echo   !HEALTH!
    echo !HEALTH! | findstr /C:"\"ready\":true" >nul && set HEALTH_OK=ready
    echo !HEALTH! | findstr /C:"\"hasQr\":true" >nul && set HEALTH_OK=qr
  )
)

echo.
echo ===========================================================================
if "%HEALTH_OK%"=="ready" (
  echo  DONE - bridge is RUNNING and already linked to WhatsApp.
) else if "%HEALTH_OK%"=="qr" (
  echo  DONE - bridge is RUNNING and waiting to be linked.
  echo  Scan the QR:  http://localhost:%PORT%/qr
  echo  ...or from the SIAL payslip page: the status shows "scan QR to link".
) else (
  echo  Service is RUNNING but WhatsApp hasn't reported ready/QR yet.
  echo  Give it another minute, then check:  http://localhost:%PORT%/health
  echo  If it never shows ready or hasQr, the Chromium launch likely failed -
  echo  re-run install-deps.bat (it puts Chromium in .cache so SYSTEM can use it).
)
echo ===========================================================================
echo.
pause
endlocal & exit /b 0
