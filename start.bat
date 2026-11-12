@echo off
cd /d "%~dp0"
py -3 server.py
if errorlevel 1 (
  echo.
  echo Could not start Orbit. Install Python 3.9+ and try again.
  pause
)
