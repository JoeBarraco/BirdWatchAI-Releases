@echo off
REM BirdWatchAI Screensaver — Uninstaller
REM Removes the screensaver from the registry and deletes installed files.

setlocal

echo.
echo  BirdWatchAI Screensaver Uninstaller
echo  ====================================
echo.

set "INSTALL_DIR=%LOCALAPPDATA%\BirdWatchAI Screensaver"

REM ── Remove registry entry ─────────────────────────────────────
echo [1/3] Removing screensaver registration...

REM Read current screensaver path
for /f "tokens=2*" %%a in ('reg query "HKCU\Control Panel\Desktop" /v SCRNSAVE.EXE 2^>nul') do set "CURRENT=%%b"

REM Only clear if it's ours
echo %CURRENT% | findstr /i "BirdWatchAI" >nul 2>&1
if not errorlevel 1 (
    reg delete "HKCU\Control Panel\Desktop" /v SCRNSAVE.EXE /f >nul 2>&1
    echo       Registry entry removed.
) else (
    echo       Not currently active — skipped.
)

REM ── Remove installed files ────────────────────────────────────
echo [2/3] Removing installed files...
if exist "%INSTALL_DIR%" (
    rmdir /s /q "%INSTALL_DIR%" >nul 2>&1
    echo       Removed %INSTALL_DIR%
) else (
    echo       Install directory not found — skipped.
)

REM ── Clean up any leftover System32 entries ────────────────────
echo [3/3] Cleaning up System32...
del /q "%SystemRoot%\System32\BirdWatchAI*Screensaver*.scr" >nul 2>&1
del /q "%SystemRoot%\System32\PBirdWatchAI*Screensaver*.scr" >nul 2>&1
echo       Done.

echo.
echo  BirdWatchAI Screensaver has been uninstalled.
echo.
pause
