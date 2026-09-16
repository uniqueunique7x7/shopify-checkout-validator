@echo off
rem ============================================================
rem  Shopify Validator - one-click installer
rem
rem  Installs everything the app needs:
rem    1. Python virtual environment + backend packages
rem    2. Node frontend dependencies
rem    3. Production build of the dashboard
rem
rem  When it finishes, start the app with:  start.bat
rem ============================================================
cd /d "%~dp0"

set "PY_CMD=py -3"
%PY_CMD% --version >nul 2>nul
if errorlevel 1 (
    set "PY_CMD=python"
    python --version >nul 2>nul
    if errorlevel 1 goto :no_python
)
echo [install] Using Python: %PY_CMD%

rem ---- 1. Python virtual environment --------------------------
if not exist ".venv\Scripts\python.exe" (
    echo [install] Creating virtual environment...
    %PY_CMD% -m venv .venv
    if errorlevel 1 goto :fail
)

echo [install] Upgrading pip...
".venv\Scripts\python.exe" -m pip install --upgrade pip --quiet
if errorlevel 1 goto :fail

echo [install] Installing backend packages...
".venv\Scripts\python.exe" -m pip install -r backend\requirements.txt
if errorlevel 1 goto :fail

rem ---- 2. Node dependencies ------------------------------------
where node >nul 2>nul
if errorlevel 1 goto :no_node

echo [install] Installing frontend dependencies (npm install)...
pushd frontend
call npm install
if errorlevel 1 (
    popd
    goto :fail
)

rem ---- 3. Production build -------------------------------------
echo [install] Building dashboard (production)...
call npm run build
if errorlevel 1 (
    popd
    goto :fail
)
popd

echo.
echo ============================================================
echo  All done. Start the app with:  start.bat
echo    Dashboard: http://localhost:3000
echo    API docs : http://127.0.0.1:8080/docs
echo ============================================================
pause
exit /b 0

:no_python
echo.
echo [ERROR] Python 3 was not found.
echo         Install it from https://www.python.org/downloads/
echo         (tick "Add python.exe to PATH" during setup).
pause
exit /b 1

:no_node
echo.
echo [ERROR] Node.js was not found.
echo         Install it from https://nodejs.org/
pause
exit /b 1

:fail
echo.
echo [ERROR] A step above failed. Read the error and try again.
pause
exit /b 1
