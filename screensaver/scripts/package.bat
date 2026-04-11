@echo off
REM BirdWatchAI Screensaver — Package for distribution
REM Creates a ZIP file ready for upload to GitHub Releases.
REM Requires: npm run build to have been run first.

setlocal

echo.
echo  BirdWatchAI Screensaver Packager
echo  =================================
echo.

pushd "%~dp0..\dist\win-unpacked" 2>nul
if errorlevel 1 (
    echo  ERROR: Build not found at dist\win-unpacked
    echo  Run "npm run build" first.
    pause
    exit /b 1
)
set "BUILD_DIR=%CD%"
popd

set "SCRIPT_DIR=%~dp0"
set "DIST_DIR=%~dp0..\dist"
set "PKG_DIR=%TEMP%\BirdWatchAI-Screensaver-Package"
set "ZIP_NAME=BirdWatchAI_Screensaver_1.0.0.zip"

REM ── Clean up previous package ────────────────────────────────
if exist "%PKG_DIR%" rmdir /s /q "%PKG_DIR%"
mkdir "%PKG_DIR%\BirdWatchAI Screensaver"

echo [1/3] Copying build files...
xcopy "%BUILD_DIR%" "%PKG_DIR%\BirdWatchAI Screensaver\app\" /s /e /i /q /y >nul
echo       Done.

echo [2/3] Copying installer scripts...
copy /y "%SCRIPT_DIR%Launcher.cs" "%PKG_DIR%\BirdWatchAI Screensaver\" >nul
copy /y "%SCRIPT_DIR%install-dist.bat" "%PKG_DIR%\BirdWatchAI Screensaver\install.bat" >nul
copy /y "%SCRIPT_DIR%uninstall.bat" "%PKG_DIR%\BirdWatchAI Screensaver\uninstall.bat" >nul

REM Create a simple readme for end users
(
echo BirdWatchAI Screensaver
echo =======================
echo.
echo A Windows screensaver that displays the BirdWatchAI community bird
echo gallery with beautiful transitions. Supports multi-monitor setups.
echo.
echo INSTALL:
echo   Right-click install.bat and select "Run as administrator"
echo.
echo UNINSTALL:
echo   Right-click uninstall.bat and select "Run as administrator"
echo.
echo CONFIGURE:
echo   After installing, open Screen Saver Settings and click "Settings..."
echo   Or: Settings ^> Personalization ^> Lock screen ^> Screen saver settings
echo.
echo Requires Windows 10/11 ^(64-bit^)
) > "%PKG_DIR%\BirdWatchAI Screensaver\README.txt"

echo       Done.

echo [3/3] Creating ZIP...

REM Use PowerShell to create the ZIP (available on Windows 10+)
powershell -NoProfile -Command "Compress-Archive -Path '%PKG_DIR%\BirdWatchAI Screensaver' -DestinationPath '%DIST_DIR%\%ZIP_NAME%' -Force"
if errorlevel 1 (
    echo  ERROR: Failed to create ZIP.
    pause
    exit /b 1
)

echo       Done.
echo.
echo  ============================================
echo   Package created!
echo  ============================================
echo.
echo   %DIST_DIR%\%ZIP_NAME%
echo.
echo   Upload this file to GitHub Releases.
echo.

REM Clean up temp
rmdir /s /q "%PKG_DIR%" >nul 2>&1

pause
