@echo off
REM BirdWatchAI Screensaver — Installer
REM Installs the unpacked Electron build to LocalAppData and registers it
REM as the active Windows screensaver via the registry.
REM No admin rights required.

setlocal enabledelayedexpansion

echo.
echo  BirdWatchAI Screensaver Installer
echo  ==================================
echo.

REM Resolve BUILD_DIR to an absolute path (eliminates ..\  issues)
pushd "%~dp0..\dist\win-unpacked" 2>nul
if errorlevel 1 (
    echo  ERROR: Build not found.
    echo  Run "npm run build" first from the screensaver directory.
    pause
    exit /b 1
)
set "BUILD_DIR=%CD%"
popd

set "INSTALL_DIR=%LOCALAPPDATA%\BirdWatchAI Screensaver"

REM ── Step 1: Clean up old broken .scr files from System32 ─────
echo [1/4] Cleaning up old System32 entries...
del /q "%SystemRoot%\System32\BirdWatchAI*Screensaver*.scr" >nul 2>&1
del /q "%SystemRoot%\System32\PBirdWatchAI*Screensaver*.scr" >nul 2>&1
echo       Done.

REM ── Step 2: Find the .scr in the build ───────────────────────
echo [2/4] Checking build...
set "SCR_NAME="
for %%f in ("%BUILD_DIR%\*.scr") do set "SCR_NAME=%%~nxf"

if not defined SCR_NAME (
    echo  ERROR: No .scr file found in %BUILD_DIR%
    echo  Run "npm run build" first.
    pause
    exit /b 1
)
echo       Found: %SCR_NAME%

REM ── Step 3: Copy build to install directory ──────────────────
echo [3/4] Installing to %INSTALL_DIR%...

if exist "%INSTALL_DIR%" rmdir /s /q "%INSTALL_DIR%" >nul 2>&1

xcopy "%BUILD_DIR%" "%INSTALL_DIR%\" /s /e /i /q /y >nul 2>&1
if errorlevel 1 (
    echo  ERROR: Failed to copy files to %INSTALL_DIR%
    pause
    exit /b 1
)
echo       Done.

REM ── Step 4: Register as the active screensaver ───────────────
echo [4/4] Registering screensaver...

set "SCR_PATH=%INSTALL_DIR%\%SCR_NAME%"

reg add "HKCU\Control Panel\Desktop" /v SCRNSAVE.EXE /t REG_SZ /d "%SCR_PATH%" /f >nul 2>&1
reg add "HKCU\Control Panel\Desktop" /v ScreenSaveActive /t REG_SZ /d 1 /f >nul 2>&1

echo       Done.
echo.
echo  ============================================
echo   BirdWatchAI Screensaver installed!
echo  ============================================
echo.
echo   Location: %INSTALL_DIR%
echo.
echo   Opening Screen Saver Settings so you
echo   can set your preferred wait time...
echo.

rundll32.exe desk.cpl,InstallScreenSaver "%SCR_PATH%"

pause
