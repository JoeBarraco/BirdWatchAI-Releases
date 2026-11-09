@echo off
REM BirdWatchAI Community Feed — Package for distribution
REM Creates a ZIP file ready for upload to GitHub Releases.
REM Requires: npm run build to have been run first.
REM
REM The launcher stub is compiled HERE rather than on the user's machine at
REM install time. That is what makes it signable: a binary produced by csc on
REM someone else's PC can never carry our signature. install.bat still knows
REM how to compile one as a fallback.

setlocal

echo.
echo  BirdWatchAI Community Feed Packager
echo  ===================================
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
set "PKG_DIR=%TEMP%\BirdWatchAI-Community-Feed-Package"
set "PKG_ROOT=%PKG_DIR%\BirdWatchAI Community Feed"
set "ZIP_NAME=BirdWatchAI_Community_Feed_1.3.0.zip"
set "LAUNCHER_NAME=BirdWatchAI.scr"

REM ── Clean up previous package ────────────────────────────────
if exist "%PKG_DIR%" rmdir /s /q "%PKG_DIR%"
mkdir "%PKG_ROOT%"

echo [1/5] Copying build files...
xcopy "%BUILD_DIR%" "%PKG_ROOT%\app\" /s /e /i /q /y >nul
echo       Done.

echo [2/5] Copying installer scripts...
copy /y "%SCRIPT_DIR%Launcher.cs" "%PKG_ROOT%\" >nul
copy /y "%SCRIPT_DIR%install-dist.bat" "%PKG_ROOT%\install.bat" >nul
copy /y "%SCRIPT_DIR%uninstall.bat" "%PKG_ROOT%\uninstall.bat" >nul
echo       Done.

echo [3/5] Compiling launcher stub...
set "CSC="
for /f "delims=" %%c in ('dir /s /b "%SystemRoot%\Microsoft.NET\Framework64\csc.exe" 2^>nul') do set "CSC=%%c"
if not defined CSC (
    for /f "delims=" %%c in ('dir /s /b "%SystemRoot%\Microsoft.NET\Framework\csc.exe" 2^>nul') do set "CSC=%%c"
)

if not defined CSC (
    echo       WARNING: C# compiler not found. The ZIP will ship without a
    echo       prebuilt launcher; install.bat will compile one on the target
    echo       machine instead, and it will be unsigned.
) else (
    "%CSC%" /nologo /optimize /platform:x64 /target:winexe /out:"%PKG_ROOT%\%LAUNCHER_NAME%" "%SCRIPT_DIR%Launcher.cs"
    if errorlevel 1 (
        echo       WARNING: Launcher compilation failed; install.bat will compile one.
        del /q "%PKG_ROOT%\%LAUNCHER_NAME%" >nul 2>&1
    ) else (
        echo       Built %LAUNCHER_NAME%
    )
)

echo [4/5] Signing...
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%sign.ps1" "%PKG_ROOT%\%LAUNCHER_NAME%"
if errorlevel 1 (
    echo  ERROR: Signing failed.
    pause
    exit /b 1
)

echo [5/5] Creating ZIP...

REM Create a simple readme for end users
(
echo BirdWatchAI Community Feed
echo ==========================
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
echo   Sign in there with your birdwatchai.com community account to include
echo   feeders from your private communities.
echo.
echo Requires Windows 10/11 ^(64-bit^)
) > "%PKG_ROOT%\README.txt"

REM Use PowerShell to create the ZIP (available on Windows 10+)
powershell -NoProfile -Command "Compress-Archive -Path '%PKG_ROOT%' -DestinationPath '%DIST_DIR%\%ZIP_NAME%' -Force"
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
