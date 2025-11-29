@echo off
REM Build single-file EXE using PyInstaller
REM 1) Install pyinstaller if needed:
REM    pip install pyinstaller

REM 2) Run this script from project root:
REM    build_exe.bat

pyinstaller --onefile --add-data "frontend;frontend" server.py

echo.
echo Build complete. EXE is in the "dist" folder (server.exe).
pause
