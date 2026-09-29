# 🚀 SkyGuard AI — Production Deployment Guide (Render + Vercel)

This manual provides the step-by-step guide to deploying the **SkyGuard AI** production stack:
- **Frontend:** Deployed to **Vercel** (Global Edge CDN, $<50\text{ ms}$ latency worldwide, instant page loads, $0\text{ cold start}$).
- **Backend:** Deployed to **Render** (FastAPI engine, 16-feature Fast Specialist Isolation Forest, TreeSHAP explainer, Open-Meteo & IMD gateways).
- **Zero Cold Start Automation:** Continuous 10-minute automated health-check keep-alive, keeping the free Render tier awake $24/7$ without delays.

---

## 🏗️ Architecture Overview

```
                      ┌────────────────────────────────────────┐
                      │             User / Evaluator           │
                      └───────────────────┬────────────────────┘
                                          │
                   ┌──────────────────────┴──────────────────────┐
                   │                                             │
                   ▼ (Instant Page Load <50ms)                   ▼ (/api/* REST Requests)
    ┌──────────────────────────────┐              ┌──────────────────────────────┐
    │     Vercel Edge Network      │              │      Render Cloud Engine     │
    │   (React 19 + Recharts UI)   │              │   (FastAPI + ML + TreeSHAP)  │
    │  https://skyguard.vercel.app │              │ https://skyguard.onrender.com│
    └──────────────────────────────┘              └──────────────┬───────────────┘
                                                                 ▲
                                                                 │ (Ping every 10 min)
                                                  ┌──────────────┴───────────────┐
                                                  │    Free Uptime Keep-Alive    │
                                                  │  (UptimeRobot / Cron-Job)    │
                                                  └──────────────────────────────┘
```

---

## 📦 Prepared Configuration Files in Repository

The necessary deployment configuration files have been prepared:
1. [**`frontend/vercel.json`**](file:///c:/Users/Aman%20Mishra/Desktop/SkyGuard/frontend/vercel.json) — Configures Vercel Vite build, SPA routing, and reverse-proxy `/api` rewrites.
2. [**`frontend/src/App.jsx`**](file:///c:/Users/Aman%20Mishra/Desktop/SkyGuard/frontend/src/App.jsx) — Dynamic `API_BASE` configuration (`import.meta.env.VITE_API_URL`).
3. [**`render.yaml`**](file:///c:/Users/Aman%20Mishra/Desktop/SkyGuard/render.yaml) & [**`deployment/render/render.yaml`**](file:///c:/Users/Aman%20Mishra/Desktop/SkyGuard/deployment/render/render.yaml) — Render Infrastructure-as-Code Blueprint.
4. [**`deployment/huggingface/app.py`**](file:///c:/Users/Aman%20Mishra/Desktop/SkyGuard/deployment/huggingface/app.py) & [**`requirements.txt`**](file:///c:/Users/Aman%20Mishra/Desktop/SkyGuard/deployment/huggingface/requirements.txt) — Standalone FastAPI server with all 16-feature models and IMD integration.

---

## 🛠️ Step 1: Push Code to GitHub

If your SkyGuard repository is not yet on GitHub:

1. Open a terminal in the SkyGuard directory:
   ```bash
   cd SkyGuard
   git init
   git add .
   git commit -m "feat: SkyGuard AI full-stack production release"
   ```
2. Create a new repository on [GitHub](https://github.com/new) named `SkyGuard`.
3. Link and push to your GitHub repository:
   ```bash
   git remote add origin https://github.com/<YOUR_GITHUB_USERNAME>/SkyGuard.git
   git branch -M main
   git push -u origin main
   ```

---

## ⚡ Step 2: Deploy Backend to Render (FastAPI + ML)

1. Go to [**dashboard.render.com**](https://dashboard.render.com) (sign up for free using your GitHub account).
2. Click **New +** $\rightarrow$ **Web Service**.
3. Select **Build and deploy from a Git repository** $\rightarrow$ Connect your **`SkyGuard`** repository.
4. Configure the Web Service settings:
   * **Name:** `skyguard-backend` (or your preferred name)
   * **Region:** `Oregon (US West)` or `Singapore`
   * **Branch:** `main`
   * **Root Directory:** `deployment/huggingface`
   * **Runtime:** `Python 3`
   * **Build Command:** `pip install -r requirements.txt`
   * **Start Command:** `uvicorn app:app --host 0.0.0.0 --port $PORT`
   * **Instance Type:** `Free`
5. In **Advanced Settings**, add an Environment Variable:
   * `PYTHON_VERSION` = `3.11.9`
6. Click **Create Web Service**.
7. Render will build the environment, install scikit-learn, shap, fastapi, and load the 16-feature Isolation Forest models.
8. Once live, copy your backend URL:
   `https://skyguard-backend-es6k.onrender.com` (verify it works by visiting `https://skyguard-backend-es6k.onrender.com/api/model/info`).

---

## 🌐 Step 3: Deploy Frontend to Vercel (React 19 + Recharts)

1. Go to [**vercel.com/new**](https://vercel.com/new) (sign up / log in with your GitHub account).
2. Under **Import Git Repository**, select **`SkyGuard`**.
3. Configure the project settings:
   * **Project Name:** `skyguard`
   * **Framework Preset:** `Vite`
   * **Root Directory:** Click **Edit** $\rightarrow$ select `frontend` $\rightarrow$ click **Continue**.
   * **Build Command:** `npm run build`
   * **Output Directory:** `dist`
4. Expand **Environment Variables**:
   * **Key:** `VITE_API_URL`
   * **Value:** `https://skyguard-backend-es6k.onrender.com` *(paste your Render URL from Step 2)*
5. Click **Deploy**.
6. Vercel will build and deploy the React 19 application in $\approx 30$ seconds.
7. Your app is live at: `https://skyguard.vercel.app` (or your custom Vercel subdomain).

---

## ⏱️ Step 4: Eliminate Cold Starts (100% Free Keep-Alive)

On Render's Free Tier, services spin down after 15 minutes of inactivity. To ensure **0 cold start**:

1. Go to [**UptimeRobot.com**](https://uptimerobot.com) (free account) or [cron-job.org](https://cron-job.org).
2. Click **+ Add New Monitor**.
3. Fill in the details:
   * **Monitor Type:** `HTTP(s)`
   * **Friendly Name:** `SkyGuard Backend KeepAlive`
   * **URL (or IP):** `https://skyguard-backend-es6k.onrender.com/api/model/info`
   * **Monitoring Interval:** Every **10 minutes**
4. Click **Create Monitor**.

### Why this works:
* A lightweight HTTP request to `/api/model/info` takes $< 10\text{ ms}$ and consumes negligible CPU.
* Because a ping arrives every 10 minutes, Render never hits the 15-minute inactivity timeout.
* Render grants **750 free hours/month**, while a 31-day month has $24 \times 31 = 744$ hours. Your backend stays awake **24/7 with zero cold start**.

---

## ✅ Verification Checklist

- [ ] `https://skyguard-backend-es6k.onrender.com/api/model/info` returns 200 OK with model parameters.
- [ ] `https://skyguard.vercel.app` loads instantly ($< 50\text{ ms}$) on any desktop/mobile browser.
- [ ] The **Live Telemetry Stream** chart animates with multi-station observations.
- [ ] Clicking **Inject Fault** (e.g. $+8^\circ\text{C}$ spike) instantly triggers TreeSHAP attribution and activates WMO Flag 2 surgical spatial reconstruction.
- [ ] UptimeRobot monitor shows **100% Up** with 10-minute intervals.
