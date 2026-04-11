@echo off
REM BirdWatchAI Screensaver — End-user Installer
REM For use from the distributed ZIP package.
REM Requires: Administrator

setlocal enabledelayedexpansion

echo.
echo  BirdWatchAI Screensaver Installer
echo  ==================================
echo.

REM ── Check admin ──────────────────────────────────────────────
net session >nul 2>&1
if errorlevel 1 (
    echo  This installer needs Administrator privileges.
    echo  Right-click install.bat and select "Run as administrator".
    echo.
    pause
    exit /b 1
)

REM ── Resolve paths ────────────────────────────────────────────
REM In the ZIP package, the app/ folder is next to this script
pushd "%~dp0app" 2>nul
if errorlevel 1 (
    REM Fallback: try the dev build path
    pushd "%~dp0..\dist\win-unpacked" 2>nul
    if errorlevel 1 (
        echo  ERROR: App files not found.
        echo  Make sure the app\ folder is in the same directory as this script.
        pause
        exit /b 1
    )
)
set "BUILD_DIR=%CD%"
popd

set "SCRIPT_DIR=%~dp0"
set "INSTALL_DIR=%ProgramFiles%\BirdWatchAI Screensaver"
set "LAUNCHER_NAME=BirdWatchAI.scr"

REM ── Step 1: Clean up old entries ─────────────────────────────
echo [1/5] Cleaning up old installations...
taskkill /f /im "%LAUNCHER_NAME%" >nul 2>&1
taskkill /f /im "BirdWatchAI Screensaver.scr" >nul 2>&1
taskkill /f /im "BirdWatchAI Screensaver.exe" >nul 2>&1
ping -n 2 127.0.0.1 >nul
del /q "%SystemRoot%\System32\BirdWatchAI*Screensaver*.scr" >nul 2>&1
del /q "%SystemRoot%\System32\PBirdWatchAI*Screensaver*.scr" >nul 2>&1
del /q "%SystemRoot%\System32\%LAUNCHER_NAME%" >nul 2>&1
echo       Done.

REM ── Step 2: Find the .scr in the build ───────────────────────
echo [2/5] Checking app files...
set "SCR_NAME="
for %%f in ("%BUILD_DIR%\*.scr") do set "SCR_NAME=%%~nxf"

if not defined SCR_NAME (
    echo  ERROR: No .scr file found in app directory.
    pause
    exit /b 1
)
echo       Found: %SCR_NAME%

REM ── Step 3: Copy to Program Files ───────────────────────────
echo [3/5] Installing to %INSTALL_DIR%...

if exist "%INSTALL_DIR%" rmdir /s /q "%INSTALL_DIR%"

xcopy "%BUILD_DIR%" "%INSTALL_DIR%\" /s /e /i /q /y
if errorlevel 1 (
    echo  ERROR: Failed to copy files to %INSTALL_DIR%
    pause
    exit /b 1
)
echo       Done.

REM ── Step 4: Compile launcher stub ────────────────────────────
echo [4/5] Compiling launcher for System32...

set "SCR_PATH=%INSTALL_DIR%\%SCR_NAME%"
set "CSC="

for /f "delims=" %%c in ('dir /s /b "%SystemRoot%\Microsoft.NET\Framework64\csc.exe" 2^>nul') do set "CSC=%%c"
if not defined CSC (
    for /f "delims=" %%c in ('dir /s /b "%SystemRoot%\Microsoft.NET\Framework\csc.exe" 2^>nul') do set "CSC=%%c"
)

if not defined CSC (
    echo  WARNING: C# compiler not found. Skipping System32 launcher.
    echo  The screensaver is installed but won't appear in the dropdown.
    goto :register
)

set "LAUNCHER_SRC=%SCRIPT_DIR%Launcher.cs"
set "LAUNCHER_OUT=%TEMP%\%LAUNCHER_NAME%"

echo       Compiler: %CSC%
"%CSC%" /nologo /optimize /platform:x64 /target:winexe /out:"%LAUNCHER_OUT%" "%LAUNCHER_SRC%"
if errorlevel 1 (
    echo  WARNING: Compilation failed. Skipping System32 launcher.
    goto :register
)

copy /y "%LAUNCHER_OUT%" "%SystemRoot%\System32\%LAUNCHER_NAME%"
if errorlevel 1 (
    echo  WARNING: Could not copy launcher to System32.
    goto :register
)
del /q "%LAUNCHER_OUT%" >nul 2>&1

if not exist "%SystemRoot%\System32\%LAUNCHER_NAME%" (
    echo  WARNING: Launcher not found in System32 after copy.
    echo  Windows Defender may have quarantined it.
    goto :register
)
echo       Verified: %SystemRoot%\System32\%LAUNCHER_NAME%

REM ── Step 5: Register in the registry ─────────────────────────
:register
echo [5/5] Registering screensaver...

reg add "HKLM\Software\BirdWatchAI\Screensaver" /v Path /t REG_SZ /d "%SCR_PATH%" /f >nul 2>&1

echo       Done.
echo.
echo  ============================================
echo   BirdWatchAI Screensaver installed!
echo  ============================================
echo.
echo   Location: %INSTALL_DIR%
echo.
echo   Opening Screen Saver Settings...
echo.

rundll32.exe shell32.dll,Control_RunDLL desk.cpl,,1

pause
