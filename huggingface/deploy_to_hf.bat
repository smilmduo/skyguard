@echo off
setlocal
echo =======================================================
echo     SkyGuard AI - Deploy to Hugging Face Spaces
echo =======================================================
cd /d "%~dp0"

python deploy_to_hf.py %*
pause
