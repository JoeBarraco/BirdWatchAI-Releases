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

set "SCRIPT_DIR=%~dp0"
set "BUILD_DIR=%SCRIPT_DIR%..\dist\win-unpacked"
set "INSTALL_DIR=%LOCALAPPDATA%\BirdWatchAI Screensaver"

REM ── Step 0: Clean up old broken .scr files from System32 ──────
echo [1/4] Cleaning up old System32 entries...
del /q "%SystemRoot%\System32\BirdWatchAI*Screensaver*.scr" >nul 2>&1
del /q "%SystemRoot%\System32\PBirdWatchAI*Screensaver*.scr" >nul 2>&1
echo       Done.

REM ── Step 1: Verify the build exists ───────────────────────────
echo [2/4] Checking build directory...
if not exist "%BUILD_DIR%" (
    echo.
    echo  ERROR: Build not found at:
    echo    %BUILD_DIR%
    echo.
    echo  Run "npm run build" first.
    pause
    exit /b 1
)

REM Find the .scr file in the build
set "SCR_NAME="
for %%f in ("%BUILD_DIR%\*.scr") do set "SCR_NAME=%%~nxf"

if "%SCR_NAME%"=="" (
    echo.
    echo  ERROR: No .scr file found in build directory.
    echo  Run "npm run build" first (the postbuild step renames .exe to .scr).
    pause
    exit /b 1
)

echo       Found: %SCR_NAME%

REM ── Step 2: Copy build to install directory ───────────────────
echo [3/4] Installing to %INSTALL_DIR%...

REM Remove previous install if it exists
if exist "%INSTALL_DIR%" (
    rmdir /s /q "%INSTALL_DIR%" >nul 2>&1
)

REM xcopy the full unpacked directory
xcopy "%BUILD_DIR%" "%INSTALL_DIR%\" /s /e /i /q /y >nul 2>&1
if errorlevel 1 (
    echo.
    echo  ERROR: Failed to copy files to %INSTALL_DIR%
    pause
    exit /b 1
)

echo       Done.

REM ── Step 3: Register as the active screensaver via registry ───
echo [4/4] Registering screensaver...

set "SCR_PATH=%INSTALL_DIR%\%SCR_NAME%"

REM Set as active screensaver
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

REM Open Screen Saver Settings dialog
rundll32.exe desk.cpl,InstallScreenSaver "%SCR_PATH%"

pause
