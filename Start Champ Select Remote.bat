@echo off
rem Starts the companion (talks to the League client) and the Expo app server, each in its own window.
rem Double-click this file, or the desktop shortcut that points to it.
title Champ Select Remote
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js isn't installed, or Windows can't find it.
  echo Install the LTS version from https://nodejs.org, then run this again.
  pause
  exit /b 1
)

rem First run only: install dependencies.
if not exist "companion\node_modules" (
  echo Installing companion dependencies, this only happens once...
  pushd companion
  call npm install
  popd
)
if not exist "mobile\node_modules" (
  echo Installing app dependencies, this only happens once...
  pushd mobile
  call npm install
  popd
)

start "Champ Select Remote - Companion" /D "%~dp0companion" cmd /k npm start
start "Champ Select Remote - App server (Expo)" /D "%~dp0mobile" cmd /k npx expo start
exit /b 0
