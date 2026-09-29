---
title: SkyGuard AI
emoji: 🛡️
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
license: mit
short_description: MoES/IMD AWS Anomaly Detection, TreeSHAP XAI & Self-Healing Telemetry
---

# 🛡️ SkyGuard AI — Production Meteorological Telemetry & Anomaly Engine

**Smart India Hackathon (SIH) — Problem Statement ID 26073**  
**Target Organization:** Ministry of Earth Sciences (MoES) / India Meteorological Department (IMD)  
**System Classification:** Autonomous Real-Time Meteorological Anomaly Detection, XAI Diagnostics & Self-Healing Telemetry Engine  
**Operational Mesonetwork:** Indo-Gangetic AWS Cluster — Lucknow Central (`26.8467° N, 80.9462° E`), Kanpur (`26.4499° N, 80.3319° E`), Barabanki (`26.9268° N, 81.1834° E`), Sitapur (`27.5645° N, 80.6809° E`)

---

## 🚀 System Architecture

SkyGuard AI is deployed as a unified, high-throughput containerized application on Hugging Face Spaces:
- **FastAPI Core Engine (`app.py`):** Vectorized inference, continuous Open-Meteo polling, and official IMD API gateway integration.
- **Physics-Informed ML Specialist (16 Features):** 200-tree Isolation Forest with calibrated dual-threshold state machine ($T_{\text{mod}}=0.4942, T_{\text{ext}}=0.5647, K=4$).
- **Sub-2ms TreeSHAP Attribution:** Exact local Shapley feature attribution for transparent root-cause triage (Spike, Freeze, Drift, Thermodynamic Incoherence, Synoptic).
- **Dual-Path Self-Healing:** Spatial Inverse Distance Weighting (IDW) with 24h baseline offset, temporal cubic spline fallback, tagged with WMO quality flags (0–3).
- **Interactive Operator Dashboard (React 19 + Recharts):** Real-time telemetry monitoring, fault injection sandbox, sensor health indices (0–100), and automated maintenance advisories.

---

## 📊 Verified Operational Performance Benchmarks

| Metric / Dimension | Verified Benchmark | Operational Baseline Standard |
| :--- | :--- | :--- |
| **Operational False Alarm Rate (FAR)** | **0.3934% (0.003934)** | Strictly $\le 0.50\%$ IMD ceiling |
| **Acute Event Detection Recall** | **92.63%** (88 / 95 events) | Controlled multi-category benchmark |
| — *Hardware Stagnation / Freezes* | **100.0%** (16 / 16 events) | Flatline gates + state machine |
| — *Thermodynamic Violations* | **100.0%** (10 / 10 events) | Clausius-Clapeyron wet-bulb invariant |
| — *Cross-Sensor Jitter / Discordance* | **100.0%** (26 / 26 events) | $T$-$RH$ discordance feature |
| — *Electrical Step Spikes* | **83.72%** (36 / 43 events) | Kinematic acceleration detection |
| **Temperature Reconstruction MAE** | **0.6945°C** (RMSE: 0.8255°C) | Strictly within WMO $\pm 1.0^\circ\text{C}$ instrument standard |
| **Relative Humidity Reconstruction MAE** | **2.257%** (RMSE: 2.864%) | Strictly within WMO $\pm 5.0\%$ instrument standard |
| **Pressure Reconstruction MAE** | **3.651 hPa** (RMSE: 4.258 hPa) | Regional inter-station mesonet baseline |
| **TreeSHAP Inference Latency** | **< 2 ms** | Pre-computed tree structures |

---

## 🛠️ API Reference Endpoints

- `GET /` — Interactive React 19 Operator Dashboard
- `GET /docs` — Interactive OpenAPI / Swagger UI documentation
- `GET /api/model/info` — Verified model parameters, feature orders, and thresholds
- `GET /api/telemetry/live` — Streaming 50 most recent processed observations
- `GET /api/telemetry/history?hours=24` — Rolling multi-hour time-series with raw vs healed readings
- `GET /api/telemetry/multi-station?hours=24` — Time-aligned 4-station regional cluster data
- `GET /api/telemetry/anomalies` — Forensic audit history of detected anomalies
- `GET /api/sensor/health` — Dynamic 0–100 health scores, drift integrals, and advisories
- `POST /api/fault/inject` — Interactive fault injection (spike, freeze, drift, thermo)
- `POST /api/fault/reset` — Restore telemetry buffer to pristine physical state
- `GET /api/imd/status` — Official IMD API gateway connectivity status
- `POST /api/imd/poll-cluster` — Ingest live IMD AWS observations across the cluster

---

## 💡 Running Locally via Docker

```bash
docker build -t skyguard-hf .
docker run -p 7860:7860 skyguard-hf
```

Visit `http://localhost:7860` in your web browser.
