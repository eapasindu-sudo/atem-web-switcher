@echo off
cd /d "%~dp0"
title ATEM Web Switcher
where node >nul 2>nul || (echo Node.js is not installed. Download it from https://nodejs.org and run this again. & pause & exit /b)
if not exist node_modules call npm install
node server.js
pause
