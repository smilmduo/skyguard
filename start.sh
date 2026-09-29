#!/usr/bin/env bash
set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

echo "=============================================================================="
echo "                     SKYGUARD AI - PRODUCTION SYSTEM LAUNCHER                 "
echo "         MoES / IMD Automatic Weather Station Quality Assurance Engine        "
echo "=============================================================================="

# Verify Python & Node
command -v python3 >/dev/null 2>&1 || { echo >&2 "[ERROR] python3 is required but not installed."; exit 1; }
command -v npm >/dev/null 2>&1 || { echo >&2 "[ERROR] npm is required but not installed."; exit 1; }

echo "[1/3] Checking Backend Environment..."
python3 -c "import fastapi, uvicorn, shap, joblib, sklearn, pandas, numpy; print('Backend dependencies: OK')" || {
    echo "Installing backend dependencies..."
    pip install -r backend/requirements.txt
}

echo "[2/3] Checking Frontend Environment..."
if [ ! -d "frontend/node_modules" ]; then
    echo "Installing frontend dependencies..."
    (cd frontend && npm install)
fi

echo "[3/3] Launching Services..."
echo "Starting Backend on http://0.0.0.0:8000..."
uvicorn backend.main:app --host 0.0.0.0 --port 8000 &
BACKEND_PID=$!

sleep 3

echo "Starting Frontend on http://localhost:5173..."
(cd frontend && npm run dev) &
FRONTEND_PID=$!

trap "kill $BACKEND_PID $FRONTEND_PID; exit" INT TERM EXIT

echo "=============================================================================="
echo " SkyGuard AI is running!"
echo " - Dashboard: http://localhost:5173"
echo " - API Docs:  http://localhost:8000/docs"
echo " Press Ctrl+C to terminate all services."
echo "=============================================================================="

wait
