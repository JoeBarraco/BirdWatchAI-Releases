@echo off
REM BirdWatchAI Screensaver — Installer
REM 1. Copies the Electron build to Program Files
REM 2. Compiles a tiny launcher .scr and places it in System32
REM 3. Registers the screensaver path in the registry
REM
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
pushd "%~dp0..\dist\win-unpacked" 2>nul
if errorlevel 1 (
    echo  ERROR: Build not found at dist\win-unpacked
    echo  Run "npm run build" first from the screensaver directory.
    pause
    exit /b 1
)
set "BUILD_DIR=%CD%"
popd

set "SCRIPT_DIR=%~dp0"
set "INSTALL_DIR=%ProgramFiles%\BirdWatchAI Screensaver"
set "LAUNCHER_NAME=BirdWatchAI.scr"

REM ── Step 1: Clean up old entries ─────────────────────────────
echo [1/5] Cleaning up old installations...
del /q "%SystemRoot%\System32\BirdWatchAI*Screensaver*.scr" >nul 2>&1
del /q "%SystemRoot%\System32\PBirdWatchAI*Screensaver*.scr" >nul 2>&1
del /q "%SystemRoot%\System32\%LAUNCHER_NAME%" >nul 2>&1
echo       Done.

REM ── Step 2: Find the .scr in the build ───────────────────────
echo [2/5] Checking build...
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
echo [3/5] Installing to %INSTALL_DIR%...

if exist "%INSTALL_DIR%" rmdir /s /q "%INSTALL_DIR%"

xcopy "%BUILD_DIR%" "%INSTALL_DIR%\" /s /e /i /y
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

REM Find csc.exe from .NET Framework (ships with Windows)
for /f "delims=" %%c in ('dir /s /b "%SystemRoot%\Microsoft.NET\Framework64\csc.exe" 2^>nul') do set "CSC=%%c"
if not defined CSC (
    for /f "delims=" %%c in ('dir /s /b "%SystemRoot%\Microsoft.NET\Framework\csc.exe" 2^>nul') do set "CSC=%%c"
)

if not defined CSC (
    echo  WARNING: C# compiler not found. Skipping System32 launcher.
    echo  The screensaver is installed but won't appear in the dropdown.
    goto :register
)

REM Compile the launcher (64-bit PE with version info for System32)
set "LAUNCHER_SRC=%SCRIPT_DIR%Launcher.cs"
set "LAUNCHER_OUT=%TEMP%\%LAUNCHER_NAME%"

echo       Compiler: %CSC%
"%CSC%" /nologo /optimize /platform:x64 /target:winexe /out:"%LAUNCHER_OUT%" "%LAUNCHER_SRC%"
if errorlevel 1 (
    echo  WARNING: Compilation failed. Skipping System32 launcher.
    goto :register
)

REM Copy launcher to System32
copy /y "%LAUNCHER_OUT%" "%SystemRoot%\System32\%LAUNCHER_NAME%"
if errorlevel 1 (
    echo  WARNING: Could not copy launcher to System32.
    goto :register
)
del /q "%LAUNCHER_OUT%" >nul 2>&1

REM Verify the file actually landed in System32
if not exist "%SystemRoot%\System32\%LAUNCHER_NAME%" (
    echo  WARNING: Launcher not found in System32 after copy.
    echo  Windows Defender may have quarantined it.
    goto :register
)
echo       Verified: %SystemRoot%\System32\%LAUNCHER_NAME%

REM ── Step 5: Register in the registry ─────────────────────────
:register
echo [5/5] Registering screensaver...

REM Store the real path in HKLM so ALL users can find the Electron app
reg add "HKLM\Software\BirdWatchAI\Screensaver" /v Path /t REG_SZ /d "%SCR_PATH%" /f >nul 2>&1

echo       Done.
echo.
echo  ============================================
echo   BirdWatchAI Screensaver installed!
echo  ============================================
echo.
echo   App location : %INSTALL_DIR%
echo   Launcher     : %SystemRoot%\System32\%LAUNCHER_NAME%
echo.
echo   Opening Screen Saver Settings...
echo.

rundll32.exe shell32.dll,Control_RunDLL desk.cpl,,1

pause
