@echo off
rem ============================================================
rem  Shopify Validator - one-click launcher
rem
rem    start.bat          production build (fast pages, default)
rem    start.bat dev      next dev with Turbopack (while editing)
rem
rem  Backend  : http://127.0.0.1:8080/docs
rem  Dashboard: http://localhost:3000
rem ============================================================
cd /d "%~dp0"

set "MODE=%~1"
set "PYTHON=%~dp0.venv\Scripts\python.exe"

if not exist "%PYTHON%" goto :no_venv
if not exist "frontend\node_modules" goto :install_deps
if /i "%MODE%"=="dev" goto :skip_build
if exist "frontend\.next-build\BUILD_ID" goto :skip_build

echo [setup] No production build found - building now...
pushd frontend
call npm run build
popd
if errorlevel 1 goto :build_failed

:skip_build
echo [start] Backend on http://127.0.0.1:8080 ...
start "Shopify Validator API" /min cmd /k "%PYTHON% -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8080"

timeout /t 3 /nobreak >nul

if /i "%MODE%"=="dev" goto :start_dev
echo [start] Dashboard (production) on http://localhost:3000 ...
pushd frontend
call npm run start
popd
goto :done

:start_dev
echo [start] Dashboard (dev) on http://localhost:3000 ...
pushd frontend
call npm run dev
popd
goto :done

:install_deps
echo [setup] Installing frontend dependencies...
pushd frontend
call npm install
popd
if errorlevel 1 goto :build_failed
if /i "%MODE%"=="dev" goto :skip_build
if exist "frontend\.next-build\BUILD_ID" goto :skip_build
echo [setup] No production build found - building now...
pushd frontend
call npm run build
popd
if errorlevel 1 goto :build_failed
goto :skip_build

:no_venv
echo [ERROR] Virtual environment not found:
echo         %PYTHON%
echo.
echo Create it once with:
echo     python -m venv .venv
echo     .\.venv\Scripts\activate.bat
echo     pip install -r backend\requirements.txt
pause
exit /b 1

:build_failed
echo [ERROR] npm install or build failed.
pause
exit /b 1

:done
echo.
echo Frontend stopped. Close the "Shopify Validator API" window to stop the backend.
pause
