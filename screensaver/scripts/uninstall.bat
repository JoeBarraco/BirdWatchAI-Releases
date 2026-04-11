@echo off
REM BirdWatchAI Screensaver — Uninstaller
REM Removes the launcher from System32, cleans up registry, and deletes installed files.
REM Requires: Administrator (to remove from System32)

setlocal

echo.
echo  BirdWatchAI Screensaver Uninstaller
echo  ====================================
echo.

set "INSTALL_DIR=%LOCALAPPDATA%\BirdWatchAI Screensaver"
set "LAUNCHER_NAME=BirdWatchAI.scr"

REM ── Remove launcher from System32 ────────────────────────────
echo [1/3] Removing launcher from System32...
del /q "%SystemRoot%\System32\%LAUNCHER_NAME%" >nul 2>&1
del /q "%SystemRoot%\System32\BirdWatchAI*Screensaver*.scr" >nul 2>&1
del /q "%SystemRoot%\System32\PBirdWatchAI*Screensaver*.scr" >nul 2>&1
echo       Done.

REM ── Remove registry entries ──────────────────────────────────
echo [2/3] Removing registry entries...

REM Only clear SCRNSAVE.EXE if it's ours
for /f "tokens=2*" %%a in ('reg query "HKCU\Control Panel\Desktop" /v SCRNSAVE.EXE 2^>nul') do set "CURRENT=%%b"
echo %CURRENT% | findstr /i "BirdWatchAI" >nul 2>&1
if not errorlevel 1 (
    reg delete "HKCU\Control Panel\Desktop" /v SCRNSAVE.EXE /f >nul 2>&1
)

REM Remove our registry keys (both HKCU and HKLM)
reg delete "HKCU\Software\BirdWatchAI\Screensaver" /f >nul 2>&1
reg delete "HKLM\Software\BirdWatchAI\Screensaver" /f >nul 2>&1
echo       Done.

REM ── Remove installed files ───────────────────────────────────
echo [3/3] Removing installed files...
if exist "%INSTALL_DIR%" (
    rmdir /s /q "%INSTALL_DIR%" >nul 2>&1
    echo       Removed %INSTALL_DIR%
) else (
    echo       Install directory not found — skipped.
)

echo.
echo  BirdWatchAI Screensaver has been uninstalled.
echo.
pause
