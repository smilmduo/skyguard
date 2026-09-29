@echo off
echo ==============================================================================
echo                      SKYGUARD AI - PRODUCTION SYSTEM LAUNCHER
echo          MoES / IMD Automatic Weather Station Quality Assurance Engine
echo ==============================================================================

:: Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python is not installed or not in PATH.
    pause
    exit /b 1
)

:: Check Node
node --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is not installed or not in PATH.
    pause
    exit /b 1
)

echo.
echo [1/3] Verifying Backend Dependencies...
python -c "import fastapi, uvicorn, shap, joblib, sklearn, pandas, numpy; print('Backend dependencies: OK')"
if errorlevel 1 (
    echo Installing backend dependencies...
    pip install -r backend\requirements.txt
)

echo.
echo [2/3] Verifying Frontend Dependencies...
if not exist "frontend\node_modules\" (
    echo Installing frontend dependencies...
    cd frontend && npm install && cd ..
)

echo.
echo [3/3] Launching SkyGuard AI Services...
echo - Starting Backend API on http://localhost:8000
start "SkyGuard Backend (Port 8000)" cmd /k "cd /d %~dp0 && uvicorn backend.main:app --host 0.0.0.0 --port 8000"

timeout /t 3 >nul

echo - Starting Frontend Dashboard on http://localhost:5173
start "SkyGuard Frontend (Port 5173)" cmd /k "cd /d %~dp0\frontend && npm run dev"

echo.
echo ==============================================================================
echo  SkyGuard AI is starting!
echo  - Dashboard: http://localhost:5173
echo  - API Docs:  http://localhost:8000/docs
echo ==============================================================================
pause
