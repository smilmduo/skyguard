"""
SkyGuard AI — IMD AWS Anomaly Detection & Self-Healing Telemetry
Unified backend entry point delegating to app.py
"""

try:
    from backend.app import app
except ImportError:
    from app import app

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)
