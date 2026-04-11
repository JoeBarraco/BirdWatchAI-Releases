@echo off
REM BirdWatchAI Screensaver — Installer
REM Copies the .scr file to the Windows system directory and opens Screen Saver Settings.

echo BirdWatchAI Screensaver Installer
echo ==================================
echo.

REM Find the .scr file in the same directory as this script
set "SCRIPT_DIR=%~dp0"
set "SCR_FILE="

for %%f in ("%SCRIPT_DIR%..\dist\*.scr") do (
    set "SCR_FILE=%%f"
)

if "%SCR_FILE%"=="" (
    echo ERROR: No .scr file found in dist\
    echo Run "npm run build" first.
    pause
    exit /b 1
)

echo Found: %SCR_FILE%
echo.

REM Copy to System32 (requires admin)
echo Copying to %SystemRoot%\System32...
copy /y "%SCR_FILE%" "%SystemRoot%\System32\" >nul 2>&1
if errorlevel 1 (
    echo.
    echo ERROR: Copy failed. Please run this script as Administrator.
    echo Right-click install.bat and select "Run as administrator".
    pause
    exit /b 1
)

echo Done!
echo.
echo Opening Screen Saver Settings...
rundll32.exe desk.cpl,InstallScreenSaver "%SystemRoot%\System32\BirdWatchAI Screensaver.scr"
echo.
echo BirdWatchAI Screensaver has been installed. Select it from the Screen Saver dropdown.
pause
