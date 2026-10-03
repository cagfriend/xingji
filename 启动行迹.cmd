@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "TRIP_NODE=node"
where node >nul 2>nul
if errorlevel 1 (
  if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" (
    set "TRIP_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
  ) else (
    echo Node.js was not found. Please install Node.js 22 or later.
    pause
    exit /b 1
  )
)

call :ready
if not errorlevel 1 goto open_browser

start "" /min "%TRIP_NODE%" "%~dp0server.mjs"
for /l %%I in (1,1,20) do (
  ping 127.0.0.1 -n 2 >nul
  call :ready
  if not errorlevel 1 goto open_browser
)

echo The local service did not start within 20 seconds.
echo Check the project files, then try again.
pause
exit /b 1

:open_browser
start "" "http://127.0.0.1:4317/"
endlocal
exit /b 0

:ready
powershell -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:4317/; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; exit 1" >nul 2>&1
exit /b %errorlevel%
