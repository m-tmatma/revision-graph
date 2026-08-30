@echo off
rem Double-click this file to install the extension's .vsix into VS Code.
setlocal
cd /d "%~dp0"

where code >nul 2>nul
if errorlevel 1 (
    echo "code" command was not found in PATH.
    echo Open VS Code, run "Shell Command: Install 'code' command in PATH" from the Command Palette, then try again.
    pause
    exit /b 1
)

set "VSIX="
for %%f in (*.vsix) do (
    if not defined VSIX set "VSIX=%%f"
)

if not defined VSIX (
    echo No .vsix file found next to this script.
    pause
    exit /b 1
)

echo Installing %VSIX% ...
call code --install-extension "%VSIX%"
if errorlevel 1 (
    echo Installation failed.
    pause
    exit /b 1
)

echo Done.
pause
