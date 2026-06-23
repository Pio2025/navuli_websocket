@echo off
title Navuli Chat Server
echo ========================================
echo  Navuli Chat Server  (Socket.IO / Node)
echo ========================================
echo.
cd /d "%~dp0"
echo Starting on port 3000 ...
echo Press Ctrl+C to stop.
echo.
node server.js
pause
