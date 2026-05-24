@echo off
REM Stop + remove the SIALWhatsAppBridge Windows service. Run as Administrator.
REM Your saved WhatsApp session (.wwebjs_auth) is kept, so reinstalling won't
REM force a re-scan.
setlocal
cd /d "%~dp0"
set SERVICE_NAME=SIALWhatsAppBridge

net session >nul 2>&1
if errorlevel 1 ( echo === Run as Administrator === & pause & exit /b 1 )

set NSSM_EXE=
where nssm >nul 2>&1 && for /f "delims=" %%i in ('where nssm') do set NSSM_EXE=%%i
if "%NSSM_EXE%"=="" if exist "C:\nssm\nssm.exe"       set NSSM_EXE=C:\nssm\nssm.exe
if "%NSSM_EXE%"=="" if exist "C:\nssm\win64\nssm.exe" set NSSM_EXE=C:\nssm\win64\nssm.exe

echo Stopping + removing %SERVICE_NAME% ...
if not "%NSSM_EXE%"=="" (
  "%NSSM_EXE%" stop %SERVICE_NAME% >nul 2>&1
  "%NSSM_EXE%" remove %SERVICE_NAME% confirm
) else (
  net stop %SERVICE_NAME% >nul 2>&1
  sc delete %SERVICE_NAME%
)
echo.
echo Done. (.wwebjs_auth session kept - reinstalling won't need a re-scan.)
pause
endlocal
