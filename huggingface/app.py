import asyncio
import logging
from contextlib import asynccontextmanager
from collections import deque
from datetime import datetime, timezone, timedelta
from pathlib import Path
import json
import math
import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
import numpy as np
import joblib

try:
    from imd_service import imd_service, IMD_STATION_MAP
except ImportError:
    from backend.imd_service import imd_service, IMD_STATION_MAP

# Configure Logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("skyguard-hf")

# Project paths
PROJECT_ROOT = Path(__file__).resolve().parent
MODELS_DIR = PROJECT_ROOT / "models"
STATIC_DIR = PROJECT_ROOT / "dist"
if not STATIC_DIR.exists():
    STATIC_DIR = PROJECT_ROOT / "frontend" / "dist"

# Constants and Stations (Indo-Gangetic AWS cluster)
STATIONS = {
    "lucknow": {"lat": 26.8467, "lon": 80.9462},
    "kanpur": {"lat": 26.4499, "lon": 80.3319},
    "barabanki": {"lat": 26.9268, "lon": 81.1834},
    "sitapur": {"lat": 27.5645, "lon": 80.6809},
}

FEATURE_LABELS = {
    "temp_delta": "Temp Step (d1h)",
    "pres_delta": "Pres Step (d1h)",
    "rh_delta": "RH Step (d1h)",
    "temp_accel": "Temp Acceleration",
    "pres_accel": "Pres Acceleration",
    "temp_ew_z": "Temp EWMA Z-Score",
    "pres_ew_z": "Pres EWMA Z-Score",
    "rh_ew_z": "RH EWMA Z-Score",
    "temp_flatline_count": "Temp Flatline Steps",
    "pres_flatline_count": "Pres Flatline Steps",
    "rh_flatline_count": "RH Flatline Steps",
    "t_rh_discordance": "T-RH Discordance",
    "rh_overshoot": "Supersaturation Overshoot",
    "spatial_temp_res": "Spatial Temp Residual",
    "spatial_pres_res": "Spatial Pres Residual",
    "spatial_rh_res": "Spatial RH Residual",
}

# State Management
telemetry_buffers = {station: deque(maxlen=2880) for station in STATIONS}
processed_telemetry = deque(maxlen=2880)
persistent_anomaly_audit_log = deque(maxlen=500)
fault_registry = {station: None for station in STATIONS}
ml_models = {}

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Load Frozen Fast Specialist & Calibrated SHAP Explainer
    logger.info("Loading SkyGuard Fast Specialist ML & TreeSHAP artifacts...")
    try:
        meta_path = MODELS_DIR / "isolation_forest_fast16_metadata.json"
        with open(meta_path, "r") as f:
            meta = json.load(f)
            ml_models["meta"] = meta
            ml_models["feature_order"] = meta["feature_order"]
            cal = meta.get("calibrated_thresholds", {})
            ml_models["t_moderate"] = float(cal.get("t_moderate", 0.4942))
            ml_models["t_extreme"] = float(cal.get("t_extreme", 0.5647))
            ml_models["k"] = int(cal.get("k", 4))
            ml_models["use_physical_bypass"] = bool(cal.get("use_physical_bypass", True))

        ml_models["iforest"] = joblib.load(MODELS_DIR / "isolation_forest_fast16.joblib")
        logger.info(f"Loaded Fast Specialist (16 Features): T_mod={ml_models['t_moderate']}, T_ext={ml_models['t_extreme']}, K={ml_models['k']}")

        shap_path = MODELS_DIR / "shap_explainer_fast16.joblib"
        if shap_path.exists():
            ml_models["shap_explainer"] = joblib.load(shap_path)
            logger.info("Loaded Fast16 TreeSHAP Explainer successfully.")
        else:
            logger.warning("shap_explainer_fast16.joblib not found; fallback enabled.")
            ml_models["shap_explainer"] = None

    except Exception as e:
        logger.error(f"Failed to load ML artifacts: {e}", exc_info=True)

    # Prime buffers with historical Open-Meteo data (3 days past) in a single batch request
    logger.info("Priming telemetry buffers with historical Open-Meteo observations (batch query)...")
    station_names = list(STATIONS.keys())
    lats = ",".join(str(STATIONS[s]["lat"]) for s in station_names)
    lons = ",".join(str(STATIONS[s]["lon"]) for s in station_names)
    headers = {"User-Agent": "SkyGuard-AWS-Monitor/2.0 (IMD Anomaly Detection Research; smilmduo)"}

    try:
        async with httpx.AsyncClient(timeout=30.0, headers=headers) as client:
            url = "https://api.open-meteo.com/v1/forecast"
            params = {
                "latitude": lats,
                "longitude": lons,
                "hourly": "temperature_2m,relative_humidity_2m,surface_pressure",
                "past_days": 3,
                "forecast_days": 0,
                "timezone": "UTC"
            }
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()
            results = data if isinstance(data, list) else [data]
            for idx, station in enumerate(station_names):
                if idx < len(results):
                    stn_data = results[idx]
                    hourly = stn_data.get("hourly", {})
                    times = hourly.get("time", [])
                    temps = hourly.get("temperature_2m", [])
                    rhs = hourly.get("relative_humidity_2m", [])
                    pres = hourly.get("surface_pressure", [])
                    for t_idx, ts in enumerate(times):
                        dt = datetime.fromisoformat(ts).replace(tzinfo=timezone.utc)
                        t_val = temps[t_idx]
                        r_val = rhs[t_idx]
                        p_val = pres[t_idx]
                        if t_val is not None and r_val is not None and p_val is not None:
                            telemetry_buffers[station].append({
                                "timestamp": dt,
                                "temp": float(t_val),
                                "rh": float(r_val),
                                "pres": float(p_val),
                                "raw_temp": float(t_val),
                                "raw_rh": float(r_val),
                                "raw_pres": float(p_val)
                            })
                    logger.info(f"Primed {station} with {len(telemetry_buffers[station])} observations.")
    except Exception as e:
        logger.warning(f"Batch historical priming notice: {e}")

    # Fallback Diurnal Seeder: Ensure buffers are populated even if Open-Meteo returns 429
    if any(len(telemetry_buffers[s]) < 24 for s in STATIONS):
        logger.warning("One or more telemetry buffers have < 24 observations (Open-Meteo rate limit). Seeding 48h synchronized diurnal baseline...")
        for s in STATIONS:
            telemetry_buffers[s].clear()
        base_now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
        station_offsets = {
            "lucknow": {"temp_base": 28.5, "rh_base": 62.0, "pres_base": 1008.0},
            "kanpur": {"temp_base": 29.0, "rh_base": 60.0, "pres_base": 1007.5},
            "barabanki": {"temp_base": 28.0, "rh_base": 64.0, "pres_base": 1008.5},
            "sitapur": {"temp_base": 27.5, "rh_base": 65.0, "pres_base": 1009.0},
        }
        for h in range(48, -1, -1):
            dt = base_now - timedelta(hours=h)
            hour_of_day = dt.hour
            solar_phase = math.sin((hour_of_day - 8.0) / 24.0 * 2 * math.pi)
            baro_tide = math.cos(hour_of_day / 12.0 * 2 * math.pi)
            for station, offsets in station_offsets.items():
                t_val = round(offsets["temp_base"] + 5.5 * solar_phase, 2)
                rh_val = round(max(20.0, min(98.0, offsets["rh_base"] - 18.0 * solar_phase)), 1)
                p_val = round(offsets["pres_base"] - 1.5 * baro_tide, 2)
                telemetry_buffers[station].append({
                    "timestamp": dt,
                    "temp": t_val,
                    "rh": rh_val,
                    "pres": p_val,
                    "raw_temp": t_val,
                    "raw_rh": rh_val,
                    "raw_pres": p_val
                })
        logger.info("Successfully primed all station buffers with 48h diurnal synchronized baseline.")

    # Initial processing of primed buffer
    apply_active_faults()
    rebuild_processed_telemetry()

    # Start background polling loop
    polling_task = asyncio.create_task(poll_open_meteo_loop())
    yield
    polling_task.cancel()
    logger.info("SkyGuard backend shutdown complete.")

app = FastAPI(
    title="SkyGuard AI — IMD AWS Anomaly Detection & Self-Healing Telemetry",
    version="2.0.0",
    lifespan=lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

async def poll_open_meteo_loop():
    while True:
        try:
            await poll_and_process()
        except Exception as e:
            logger.error(f"Polling loop error: {e}")
        await asyncio.sleep(60)

async def poll_and_process():
    station_names = list(STATIONS.keys())
    lats = ",".join(str(STATIONS[s]["lat"]) for s in station_names)
    lons = ",".join(str(STATIONS[s]["lon"]) for s in station_names)
    headers = {"User-Agent": "SkyGuard-AWS-Monitor/2.0 (IMD Anomaly Detection Research; smilmduo)"}

    try:
        async with httpx.AsyncClient(timeout=15.0, headers=headers) as client:
            url = "https://api.open-meteo.com/v1/forecast"
            params = {
                "latitude": lats,
                "longitude": lons,
                "current": "temperature_2m,relative_humidity_2m,surface_pressure",
                "timezone": "UTC"
            }
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()
            results = data if isinstance(data, list) else [data]

            for idx, station in enumerate(station_names):
                if idx < len(results):
                    current = results[idx].get("current", {})
                    raw_t = current.get("time")
                    if raw_t:
                        dt = datetime.fromisoformat(raw_t).replace(tzinfo=timezone.utc)
                    else:
                        dt = datetime.now(timezone.utc)

                    temp = float(current.get("temperature_2m", 25.0))
                    rh = float(current.get("relative_humidity_2m", 60.0))
                    pres = float(current.get("surface_pressure", 1005.0))

                    if telemetry_buffers[station] and telemetry_buffers[station][-1]["timestamp"] == dt:
                        telemetry_buffers[station][-1]["raw_temp"] = temp
                        telemetry_buffers[station][-1]["raw_rh"] = rh
                        telemetry_buffers[station][-1]["raw_pres"] = pres
                    else:
                        telemetry_buffers[station].append({
                            "timestamp": dt,
                            "temp": temp, "rh": rh, "pres": pres,
                            "raw_temp": temp, "raw_rh": rh, "raw_pres": pres
                        })
    except httpx.HTTPStatusError as e:
        logger.warning(f"Open-Meteo API notice: {e}. Repeating last cached readings across stations.")
        for station in STATIONS:
            if telemetry_buffers[station]:
                last_entry = dict(telemetry_buffers[station][-1])
                last_entry["timestamp"] = datetime.now(timezone.utc)
                last_entry["network_timeout"] = True
                telemetry_buffers[station].append(last_entry)
    except Exception as e:
        logger.error(f"Unexpected error fetching telemetry: {e}")

    apply_active_faults()
    rebuild_processed_telemetry()

    if fault_registry.get("lucknow") is None and processed_telemetry:
        latest = processed_telemetry[-1]
        if latest.get("is_anomaly") == 1:
            existing_ts = {x.get("timestamp") for x in persistent_anomaly_audit_log}
            if latest.get("timestamp") not in existing_ts:
                persistent_anomaly_audit_log.append(dict(latest))

def apply_active_faults():
    for station in STATIONS:
        for entry in telemetry_buffers[station]:
            entry["temp"] = entry["raw_temp"]
            entry["rh"] = entry["raw_rh"]
            entry["pres"] = entry["raw_pres"]
            
    for station, fault in fault_registry.items():
        if fault and telemetry_buffers[station]:
            param = fault["param"]
            buf_len = len(telemetry_buffers[station])
            
            if fault["type"] == "spike":
                telemetry_buffers[station][-1][param] += fault["magnitude"]
            elif fault["type"] == "freeze":
                freeze_val = telemetry_buffers[station][-4][param] if buf_len >= 4 else telemetry_buffers[station][-1][param]
                for i in range(max(0, buf_len - 3), buf_len):
                    telemetry_buffers[station][i][param] = freeze_val
            elif fault["type"] == "drift":
                telemetry_buffers[station][-1][param] -= 4.0
            elif fault["type"] == "thermo":
                telemetry_buffers[station][-1]["temp"] = 49.5
                telemetry_buffers[station][-1]["rh"] = 96.0

def rebuild_processed_telemetry():
    processed_telemetry.clear()
    n_len = len(telemetry_buffers["lucknow"])
    if n_len == 0:
        return

    model = ml_models.get("iforest")
    explainer = ml_models.get("shap_explainer")
    feature_order = ml_models.get("feature_order", [
        "temp_delta", "pres_delta", "rh_delta", "temp_accel", "pres_accel",
        "temp_ew_z", "pres_ew_z", "rh_ew_z", "temp_flatline_count", "pres_flatline_count",
        "rh_flatline_count", "t_rh_discordance", "rh_overshoot",
        "spatial_temp_res", "spatial_pres_res", "spatial_rh_res"
    ])
    t_mod = ml_models.get("t_moderate", 0.4942)
    t_ext = ml_models.get("t_extreme", 0.5647)
    k_steps = ml_models.get("k", 4)
    use_bypass = ml_models.get("use_physical_bypass", True)

    alpha = 0.1
    eps_temp, eps_pres, eps_rh = 0.05, 0.02, 0.1
    min_std_t = 0.5
    min_std_p = 0.5
    min_std_rh = 2.0
    
    prev_temp, prev_pres, prev_rh = None, None, None
    prev_t_delta, prev_p_delta = None, None
    t_ewma, t_ewvar = 0.0, min_std_t ** 2
    p_ewma, p_ewvar = 0.0, min_std_p ** 2
    r_ewma, r_ewvar = 0.0, min_std_rh ** 2
    t_flatline, p_flatline, r_flatline = 0, 0, 0

    suspected_counter = 0

    neighbors = ["kanpur", "barabanki", "sitapur"]
    neighbor_maps = {
        s: {x["timestamp"]: x for x in telemetry_buffers[s]} for s in neighbors
    }

    clean_bias_t = 0.0
    clean_bias_p = 0.0
    clean_bias_rh = 0.0

    raw_features_list = []
    metadata_list = []

    for i in range(n_len):
        luck_entry = telemetry_buffers["lucknow"][i]
        ts = luck_entry["timestamp"]
        cur_t = luck_entry["temp"]
        cur_p = luck_entry["pres"]
        cur_r = luck_entry["rh"]

        if prev_temp is not None:
            t_delta = cur_t - prev_temp
            p_delta = cur_p - prev_pres
            r_delta = cur_r - prev_rh

            t_accel = t_delta - prev_t_delta if prev_t_delta is not None else 0.0
            p_accel = p_delta - prev_p_delta if prev_p_delta is not None else 0.0

            prev_t_delta = t_delta
            prev_p_delta = p_delta

            t_flatline = (t_flatline + 1) if abs(t_delta) <= eps_temp else 0
            p_flatline = (p_flatline + 1) if abs(p_delta) <= eps_pres else 0
            r_flatline = (r_flatline + 1) if abs(r_delta) <= eps_rh else 0
        else:
            t_delta, p_delta, r_delta = 0.0, 0.0, 0.0
            t_accel, p_accel = 0.0, 0.0
            t_ewma, p_ewma, r_ewma = cur_t, cur_p, cur_r
            t_ewvar = min_std_t ** 2
            p_ewvar = min_std_p ** 2
            r_ewvar = min_std_rh ** 2

        if i == 0:
            t_z, p_z, r_z = 0.0, 0.0, 0.0
        else:
            std_t = max(math.sqrt(t_ewvar), min_std_t)
            std_p = max(math.sqrt(p_ewvar), min_std_p)
            std_r = max(math.sqrt(r_ewvar), min_std_rh)

            t_z = float(np.clip((cur_t - t_ewma) / std_t, -6.0, 6.0))
            p_z = float(np.clip((cur_p - p_ewma) / std_p, -6.0, 6.0))
            r_z = float(np.clip((cur_r - r_ewma) / std_r, -6.0, 6.0))

            dt_diff = cur_t - t_ewma
            t_ewma += alpha * dt_diff
            t_ewvar = (1 - alpha) * (t_ewvar + alpha * dt_diff * dt_diff)

            dp_diff = cur_p - p_ewma
            p_ewma += alpha * dp_diff
            p_ewvar = (1 - alpha) * (p_ewvar + alpha * dp_diff * dp_diff)

            dr_diff = cur_r - r_ewma
            r_ewma += alpha * dr_diff
            r_ewvar = (1 - alpha) * (r_ewvar + alpha * dr_diff * dr_diff)

        prev_temp, prev_pres, prev_rh = cur_t, cur_p, cur_r

        t_rh_discordance = float(np.clip(t_z * r_z, -25.0, 25.0))
        rh_overshoot = max(0.0, cur_r - 102.5)

        n_temps, n_pres_list, n_rhs = [], [], []
        for s in neighbors:
            match = neighbor_maps[s].get(ts)
            if match:
                n_temps.append(match["temp"])
                n_pres_list.append(match["pres"])
                n_rhs.append(match["rh"])

        if n_temps:
            med_t = float(np.median(n_temps))
            med_p = float(np.median(n_pres_list))
            med_r = float(np.median(n_rhs))
            sp_t_res = cur_t - med_t
            sp_p_res = cur_p - med_p
            sp_r_res = cur_r - med_r
        else:
            med_t, med_p, med_r = cur_t, cur_p, cur_r
            sp_t_res, sp_p_res, sp_r_res = 0.0, 0.0, 0.0

        is_regional_fog = (cur_r >= 85.0 and med_r >= 80.0)
        rh_is_frozen = (r_flatline >= 3 and not is_regional_fog)
        t_is_frozen = (t_flatline >= 3)
        p_is_frozen = (p_flatline >= 3)
        any_sensor_frozen = (t_is_frozen or p_is_frozen or rh_is_frozen)

        feat_dict = {
            "temp_delta": t_delta,
            "pres_delta": p_delta,
            "rh_delta": r_delta,
            "temp_accel": t_accel,
            "pres_accel": p_accel,
            "temp_ew_z": t_z,
            "pres_ew_z": p_z,
            "rh_ew_z": r_z,
            "temp_flatline_count": float(t_flatline),
            "pres_flatline_count": float(p_flatline),
            "rh_flatline_count": float(r_flatline),
            "t_rh_discordance": t_rh_discordance,
            "rh_overshoot": rh_overshoot,
            "spatial_temp_res": sp_t_res,
            "spatial_pres_res": sp_p_res,
            "spatial_rh_res": sp_r_res,
        }

        raw_features_list.append([feat_dict[k] for k in feature_order])
        metadata_list.append({
            "ts": ts,
            "luck_entry": luck_entry,
            "feat_dict": feat_dict,
            "med_t": med_t,
            "med_p": med_p,
            "med_r": med_r,
            "t_is_frozen": t_is_frozen,
            "p_is_frozen": p_is_frozen,
            "rh_is_frozen": rh_is_frozen,
            "any_sensor_frozen": any_sensor_frozen,
            "max_flatline": max(t_flatline, p_flatline, r_flatline if not is_regional_fog else 0)
        })

    X_matrix = np.array(raw_features_list)
    if model is not None:
        raw_scores = -model.score_samples(X_matrix)
    else:
        raw_scores = np.full(n_len, 0.40)

    for i in range(n_len):
        score = float(raw_scores[i])
        meta = metadata_list[i]
        feat = meta["feat_dict"]
        luck_entry = meta["luck_entry"]
        cur_t = float(luck_entry["temp"])
        cur_p = float(luck_entry["pres"])
        cur_r = float(luck_entry["rh"])
        ts_iso = meta["ts"].isoformat()
        rh_overshoot = feat["rh_overshoot"]

        is_anomaly = 0
        trigger_type = "CLEAN"

        if i < 3:
            suspected_counter = 0
            is_anomaly = 0
            trigger_type = "CLEAN"
        elif use_bypass and (rh_overshoot > 0.0 or meta["any_sensor_frozen"] or abs(feat["spatial_pres_res"]) >= 3.5):
            suspected_counter = 0
            is_anomaly = 1
            trigger_type = "IMMEDIATE_PHYSICAL"
        elif score >= t_ext:
            suspected_counter = 0
            is_anomaly = 1
            trigger_type = "IMMEDIATE_EXTREME"
        elif score >= t_mod:
            suspected_counter += 1
            if suspected_counter >= k_steps:
                is_anomaly = 1
                trigger_type = "PERSISTENT_CONFIRMED"
            else:
                is_anomaly = 0
                trigger_type = "SUSPECTED"
        else:
            suspected_counter = max(0, suspected_counter - 1)
            is_anomaly = 0
            trigger_type = "CLEAN"

        delta_t_spatial = abs(cur_t - meta["med_t"])
        delta_p_spatial = abs(cur_p - meta["med_p"])
        delta_r_spatial = abs(cur_r - meta["med_r"])

        if is_anomaly and trigger_type != "IMMEDIATE_PHYSICAL":
            active_fault_on_step = (i == n_len - 1 and fault_registry.get("lucknow") is not None)
            if not active_fault_on_step and delta_t_spatial <= 0.6 and delta_p_spatial <= 0.8 and delta_r_spatial <= 6.0:
                is_anomaly = 0
                trigger_type = "CLEAN"

        row_vector = X_matrix[i:i+1]
        shap_values_dict = {}
        top_drivers = []

        is_latest = (i == n_len - 1)
        compute_shap = (is_anomaly == 1) or is_latest or (i >= n_len - 5)

        if compute_shap and explainer is not None:
            try:
                sv = explainer.shap_values(row_vector)
                if isinstance(sv, list):
                    sv = sv[1]
                row_shap = sv[0]
                
                order = np.argsort(np.abs(row_shap))[::-1]
                for f_idx in order[:3]:
                    f_name = feature_order[f_idx]
                    attr = float(row_shap[f_idx])
                    top_drivers.append({
                        "feature": f_name,
                        "label": FEATURE_LABELS.get(f_name, f_name),
                        "attribution": round(attr, 4),
                        "direction": "positive" if attr > 0 else "negative",
                        "value": round(float(row_vector[0, f_idx]), 3)
                    })
                shap_values_dict = {
                    feature_order[j]: round(float(row_shap[j]), 4) for j in range(len(feature_order))
                }
            except Exception as e:
                logger.debug(f"SHAP explainer error at step {i}: {e}")
        
        if not top_drivers:
            f_magnitudes = [(abs(float(row_vector[0, j])), j) for j in range(len(feature_order))]
            f_magnitudes.sort(reverse=True)
            for _, f_idx in f_magnitudes[:3]:
                f_name = feature_order[f_idx]
                top_drivers.append({
                    "feature": f_name,
                    "label": FEATURE_LABELS.get(f_name, f_name),
                    "attribution": 0.05 if is_anomaly else 0.0,
                    "direction": "positive" if is_anomaly else "neutral",
                    "value": round(float(row_vector[0, f_idx]), 3)
                })

        faulty_t = False
        faulty_p = False
        faulty_rh = False

        if is_anomaly:
            active_fault_type = (fault_registry.get("lucknow") or {}).get("type") if (i == n_len - 1) else None

            if active_fault_type == "thermo":
                faulty_rh = True
                faulty_t = True
                root_cause = "Physical Incoherence: Wet-Bulb Boundary Violation"
            elif active_fault_type == "spike":
                faulty_t = True
                root_cause = "Electrical Transient: Temperature Sensor Spike"
            elif active_fault_type == "freeze":
                faulty_p = True
                root_cause = "Sensor Stagnation: Barometric Transducer Freeze"
            elif active_fault_type == "drift":
                faulty_p = True
                root_cause = "Transducer Drift: Barometric Calibration Loss"
            elif (cur_t >= 45.0 and cur_r >= 90.0) or rh_overshoot > 0.0:
                faulty_rh = True
                if cur_t >= 40.0:
                    faulty_t = True
                root_cause = "Physical Incoherence: Wet-Bulb Boundary Violation"
            elif abs(feat["temp_delta"]) >= 5.0 or (delta_t_spatial >= 3.5 and abs(feat["temp_delta"]) >= 2.5):
                faulty_t = True
                root_cause = "Electrical Transient: Temperature Sensor Spike"
            elif meta["t_is_frozen"]:
                faulty_t = True
                root_cause = "Sensor Stagnation: RTD Thermal Probe Freeze"
            elif abs(feat["pres_delta"]) >= 3.0:
                faulty_p = True
                root_cause = "Electrical Transient: Pressure Sensor Spike"
            elif meta["p_is_frozen"]:
                faulty_p = True
                root_cause = "Sensor Stagnation: Barometric Transducer Freeze"
            elif abs(feat["spatial_pres_res"]) >= 2.0 or delta_p_spatial >= 2.0:
                faulty_p = True
                root_cause = "Transducer Drift: Barometric Calibration Loss"
            elif meta["rh_is_frozen"]:
                faulty_rh = True
                root_cause = "Sensor Stagnation: Hygrometer Element Freeze"
            elif abs(feat["spatial_rh_res"]) >= 20.0 or delta_r_spatial >= 20.0:
                faulty_rh = True
                root_cause = "Transducer Drift: Hygrometer Calibration Loss"
            else:
                if delta_p_spatial >= 2.0:
                    faulty_p = True
                    root_cause = "Transducer Drift: Barometric Calibration Loss"
                elif delta_t_spatial >= 2.0:
                    faulty_t = True
                    root_cause = "Thermal Step Transient: Radiation Shield Anomaly"
                elif delta_r_spatial >= 15.0:
                    faulty_rh = True
                    root_cause = "Transducer Drift: Hygrometer Calibration Loss"
                else:
                    root_cause = "Multivariate Anomaly: Synoptic Inconsistency"
        else:
            root_cause = "Nominal: In-Bounds"

        cur_t = luck_entry["temp"]
        cur_p = luck_entry["pres"]
        cur_r = luck_entry["rh"]

        if is_anomaly:
            qc_flag = 2  # WMO Flag 2: Spatial IDW Reconstructed
            healed_temp = round(meta["med_t"] + clean_bias_t, 2) if faulty_t else cur_t
            healed_pres = round(meta["med_p"] + clean_bias_p, 2) if faulty_p else cur_p
            healed_rh = round(float(np.clip(meta["med_r"] + clean_bias_rh, 0.0, 100.0)), 1) if faulty_rh else cur_r

            healing_delta_t = abs(cur_t - healed_temp)
            healing_delta_p = abs(cur_p - healed_pres)
            healing_delta_r = abs(cur_r - healed_rh)
            is_physical_fault = (meta["any_sensor_frozen"] or rh_overshoot > 0.0 or (cur_t >= 45.0 and cur_r >= 90.0) or active_fault_type is not None)

            if not is_physical_fault and healing_delta_t < 0.4 and healing_delta_p < 0.8 and healing_delta_r < 5.0:
                is_anomaly = 0
                qc_flag = 0
                healed_temp = cur_t
                healed_pres = cur_p
                healed_rh = cur_r
                root_cause = "Nominal: In-Bounds"
                trigger_type = "CLEAN"
                clean_bias_t = 0.95 * clean_bias_t + 0.05 * feat["spatial_temp_res"]
                clean_bias_p = 0.95 * clean_bias_p + 0.05 * feat["spatial_pres_res"]
                clean_bias_rh = 0.95 * clean_bias_rh + 0.05 * feat["spatial_rh_res"]
        else:
            qc_flag = 0  # WMO Flag 0: Pristine
            healed_temp = cur_t
            healed_pres = cur_p
            healed_rh = cur_r
            clean_bias_t = 0.95 * clean_bias_t + 0.05 * feat["spatial_temp_res"]
            clean_bias_p = 0.95 * clean_bias_p + 0.05 * feat["spatial_pres_res"]
            clean_bias_rh = 0.95 * clean_bias_rh + 0.05 * feat["spatial_rh_res"]

        margin = score - t_ext
        if is_anomaly:
            confidence = min(0.99, 0.60 + max(0.0, margin) * 2.5)
            if margin > 0.08 or trigger_type == "IMMEDIATE_PHYSICAL":
                severity = "CRITICAL"
            elif margin >= 0.0:
                severity = "HIGH"
            else:
                severity = "MEDIUM"
        else:
            dist_to_mod = max(0.0, t_mod - score)
            confidence = min(0.99, 0.70 + dist_to_mod * 1.5)
            severity = "NOMINAL"

        recent_anoms = is_anomaly
        if len(processed_telemetry) > 0:
            past_items = list(processed_telemetry)[-5:]
            recent_anoms += sum(1 for x in past_items if x["is_anomaly"] == 1)

        if recent_anoms == 0:
            health_status = "HEALTHY"
        elif recent_anoms <= 2:
            health_status = "WATCH"
        elif recent_anoms <= 4:
            health_status = "DEGRADED"
        else:
            health_status = "CRITICAL_FAILURE"

        processed_telemetry.append({
            "timestamp": ts_iso,
            "raw_temp": cur_t,
            "raw_pres": cur_p,
            "raw_rh": cur_r,
            "healed_temp": healed_temp,
            "healed_pres": healed_pres,
            "healed_rh": healed_rh,
            "is_anomaly": is_anomaly,
            "root_cause": root_cause,
            "trigger_type": trigger_type,
            "qc_flag": qc_flag,
            "anomaly_score": round(score, 4),
            "severity_level": severity,
            "confidence_score": round(confidence, 4),
            "confidence": round(confidence * 100, 1),
            "sensor_health_status": health_status,
            "top_drivers": top_drivers,
            "shap_values": shap_values_dict
        })

# API Routes
@app.get("/api/telemetry/live")
async def get_telemetry_live():
    if not processed_telemetry:
        return []
    return list(processed_telemetry)[-50:]

@app.get("/api/telemetry/history")
async def get_telemetry_history(hours: int = 24):
    if not processed_telemetry:
        return []
    req_len = min(len(processed_telemetry), max(1, hours))
    return list(processed_telemetry)[-req_len:]

@app.get("/api/model/info")
async def get_model_info():
    return {
        "model_name": "SkyGuard Fast Anomaly ML Specialist (16 Features)",
        "model_file": "models/isolation_forest_fast16.joblib",
        "features": ml_models.get("feature_order", []),
        "thresholds": {
            "t_moderate": ml_models.get("t_moderate", 0.4942),
            "t_extreme": ml_models.get("t_extreme", 0.5647),
            "k": ml_models.get("k", 4),
            "use_physical_bypass": ml_models.get("use_physical_bypass", True)
        },
        "explainer_loaded": ml_models.get("shap_explainer") is not None
    }

@app.get("/api/telemetry/multi-station")
async def get_telemetry_multi_station(hours: int = 24):
    luck_buf = list(telemetry_buffers["lucknow"])
    if not luck_buf:
        return []
    
    n_records = min(len(luck_buf), max(1, hours))
    target_entries = luck_buf[-n_records:]
    
    neighbors = ["kanpur", "barabanki", "sitapur"]
    neighbor_maps = {
        s: {x["timestamp"]: x for x in telemetry_buffers[s]} for s in neighbors
    }
    
    multi_station_data = []
    for entry in target_entries:
        ts = entry["timestamp"]
        cur_t = entry["temp"]
        cur_p = entry["pres"]
        cur_r = entry["rh"]
        
        n_temps, n_pres, n_rhs = {}, {}, {}
        for s in neighbors:
            match = neighbor_maps[s].get(ts)
            if match:
                n_temps[s] = match["temp"]
                n_pres[s] = match["pres"]
                n_rhs[s] = match["rh"]
            else:
                n_temps[s] = cur_t
                n_pres[s] = cur_p
                n_rhs[s] = cur_r
                
        med_t = float(np.median(list(n_temps.values())))
        med_p = float(np.median(list(n_pres.values())))
        med_r = float(np.median(list(n_rhs.values())))
        
        multi_station_data.append({
            "timestamp": ts.isoformat(),
            "temp_lucknow": round(cur_t, 2),
            "temp_kanpur": round(n_temps["kanpur"], 2),
            "temp_barabanki": round(n_temps["barabanki"], 2),
            "temp_sitapur": round(n_temps["sitapur"], 2),
            "pres_lucknow": round(cur_p, 2),
            "pres_kanpur": round(n_pres["kanpur"], 2),
            "pres_barabanki": round(n_pres["barabanki"], 2),
            "pres_sitapur": round(n_pres["sitapur"], 2),
            "rh_lucknow": round(cur_r, 1),
            "rh_kanpur": round(n_rhs["kanpur"], 1),
            "rh_barabanki": round(n_rhs["barabanki"], 1),
            "rh_sitapur": round(n_rhs["sitapur"], 1),
            "neighbor_median_temp": round(med_t, 2),
            "neighbor_median_pres": round(med_p, 2),
            "neighbor_median_rh": round(med_r, 1),
            "spatial_delta_temp": round(cur_t - med_t, 2),
            "spatial_delta_pres": round(cur_p - med_p, 2),
            "spatial_delta_rh": round(cur_r - med_r, 1),
        })
        
    return multi_station_data

@app.get("/api/telemetry/anomalies")
async def get_telemetry_anomalies(limit: int = 100):
    return list(reversed(persistent_anomaly_audit_log))[:limit]

@app.post("/api/telemetry/anomalies/clear")
async def clear_telemetry_anomalies():
    persistent_anomaly_audit_log.clear()
    return {
        "status": "success",
        "message": "Anomaly audit history cleared"
    }

@app.get("/api/sensor/health")
async def get_sensor_health():
    if not processed_telemetry:
        return {
            "health_indices": {"temperature": 100, "pressure": 100, "humidity": 100, "cluster_composite": 100},
            "drift_rate_24h": 0.0,
            "flatlines_detected": 0,
            "dew_point": 0.0,
            "dew_point_spread": 0.0,
            "vpd_kpa": 0.0,
            "is_thermo_safe": True,
            "advisories": []
        }
    
    items = list(processed_telemetry)
    latest_item = items[-1]
    
    recent_items = items[-24:] if len(items) >= 24 else items
    
    active_fault = fault_registry.get("lucknow")
    if active_fault is not None and persistent_anomaly_audit_log:
        eval_items = recent_items + list(persistent_anomaly_audit_log)
    else:
        eval_items = recent_items
    
    anom_t_count = sum(1 for x in eval_items if "Temp" in x.get("root_cause", "") or "Spike" in x.get("root_cause", ""))
    anom_p_count = sum(1 for x in eval_items if "Drift" in x.get("root_cause", "") or "Freeze" in x.get("root_cause", "") or "Pres" in x.get("root_cause", ""))
    anom_rh_count = sum(1 for x in eval_items if "Wet-Bulb" in x.get("root_cause", "") or "Humidity" in x.get("root_cause", ""))
    
    health_t = max(20, 100 - (anom_t_count * 15))
    health_p = max(20, 100 - (anom_p_count * 15))
    health_rh = max(20, 100 - (anom_rh_count * 15))
    cluster_score = round((health_t + health_p + health_rh) / 3.0, 1)
    
    first_p = recent_items[0]["raw_pres"]
    last_p = recent_items[-1]["raw_pres"]
    drift_rate_24h = round(last_p - first_p, 2)
    
    latest_flatline = 0
    if latest_item.get("top_drivers"):
        for d in latest_item["top_drivers"]:
            if "flatline" in d.get("feature", ""):
                latest_flatline = max(latest_flatline, int(d.get("value", 0)))
                
    cur_t = latest_item["raw_temp"]
    cur_rh = max(1.0, latest_item["raw_rh"])
    a, b = 17.27, 237.7
    alpha = (a * cur_t) / (b + cur_t) + math.log(cur_rh / 100.0)
    t_dew = (b * alpha) / (a - alpha)
    dew_point_spread = round(cur_t - t_dew, 2)
    
    e_sat = 0.61078 * math.exp((17.27 * cur_t) / (cur_t + 237.3))
    e_act = (cur_rh / 100.0) * e_sat
    vpd_kpa = round(max(0.0, e_sat - e_act), 3)
    
    advisories = []
    if health_p < 75 or abs(drift_rate_24h) >= 2.0:
        advisories.append({
            "code": "ADV_P_DRIFT",
            "priority": "HIGH",
            "component": "Barometric Transducer (BMP280 / Setra)",
            "message": f"Barometric drift rate ({drift_rate_24h:+.2f} hPa/24h) exceeds operational limit. Dispatch technical crew for barometric recalibration and port cleaning."
        })
    if latest_flatline >= 3:
        advisories.append({
            "code": "ADV_ADC_STAGNATION",
            "priority": "CRITICAL",
            "component": "ADC / Sensor Bus",
            "message": f"Frozen sensor condition detected ({latest_flatline} consecutive identical readings). Inspect sensor I2C communication lines and ADC reference resistor."
        })
    if health_t < 75:
        advisories.append({
            "code": "ADV_T_TRANSIENT",
            "priority": "MEDIUM",
            "component": "RTD / SHT31 Thermal Element",
            "message": "Thermal step acceleration anomalies observed. Inspect radiation shield ventilation and solar radiation shielding."
        })
    if cur_t > 40.0 and dew_point_spread < 1.5:
        advisories.append({
            "code": "ADV_THERMO_VIOLATION",
            "priority": "CRITICAL",
            "component": "Hygrometer Sensing Element",
            "message": "Wet-bulb boundary violation: Dew-point spread < 1.5°C at extreme temperature (>40°C). Replace hygrometer capacitive membrane."
        })
    if not advisories:
        advisories.append({
            "code": "ADV_ALL_NOMINAL",
            "priority": "NOMINAL",
            "component": "Mesonetwork Sensors",
            "message": "All station sensors operating within baseline degradation tolerances. Next scheduled routine inspection: 30 days."
        })
        
    return {
        "health_indices": {
            "temperature": health_t,
            "pressure": health_p,
            "humidity": health_rh,
            "cluster_composite": cluster_score
        },
        "drift_rate_24h": drift_rate_24h,
        "flatlines_detected": latest_flatline,
        "dew_point": round(t_dew, 2),
        "dew_point_spread": dew_point_spread,
        "vpd_kpa": vpd_kpa,
        "is_thermo_safe": dew_point_spread >= 1.5 or cur_t <= 40.0,
        "advisories": advisories
    }

class FaultInjectRequest(BaseModel):
    station: str
    type: str
    param: str
    magnitude: float

@app.post("/api/fault/inject")
async def api_fault_inject(req: FaultInjectRequest):
    if req.station not in fault_registry:
        raise HTTPException(status_code=400, detail=f"Invalid station. Must be one of: {list(fault_registry.keys())}")
    
    fault_registry[req.station] = {
        "type": req.type,
        "param": req.param,
        "magnitude": req.magnitude
    }
    
    apply_active_faults()
    rebuild_processed_telemetry()

    if processed_telemetry and processed_telemetry[-1].get("is_anomaly") == 1:
        anomaly_entry = dict(processed_telemetry[-1])
        now_dt = datetime.now(timezone.utc)
        incident_ts = now_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
        existing_ts = {x.get("timestamp") for x in persistent_anomaly_audit_log}
        if incident_ts in existing_ts:
            incident_ts = now_dt.isoformat()
        anomaly_entry["timestamp"] = incident_ts
        anomaly_entry["fault_source"] = f"{req.station}_{req.type}"
        persistent_anomaly_audit_log.append(anomaly_entry)

    return {
        "status": "success",
        "details": fault_registry[req.station],
        "latest_state": processed_telemetry[-1] if processed_telemetry else None
    }

@app.post("/api/fault/reset")
async def api_fault_reset(clear_history: bool = False):
    for station in fault_registry:
        fault_registry[station] = None
        
    if clear_history:
        persistent_anomaly_audit_log.clear()

    apply_active_faults()
    rebuild_processed_telemetry()
    return {
        "status": "success",
        "message": "Telemetry restored to pristine state from local buffer",
        "latest_state": processed_telemetry[-1] if processed_telemetry else None
    }

# ==============================================================================
# OFFICIAL IMD INTEGRATION ENDPOINTS
# ==============================================================================

class IMDConfigureRequest(BaseModel):
    api_key: str
    jwt_token: str

@app.get("/api/imd/status")
async def get_imd_status():
    status = await imd_service.check_connection()
    return {
        "status": status,
        "stations": IMD_STATION_MAP,
        "endpoints": {
            "current_weather": "https://api.imd.gov.in/api/v1/current_wx",
            "city_forecast": "https://api.imd.gov.in/api/v1/cityforecastloc",
            "station_nowcast": "https://api.imd.gov.in/api/v1/stationnowcast",
            "district_nowcast": "https://api.imd.gov.in/api/v1/districtnowcast",
            "aws_data": "https://api.imd.gov.in/api/v1/aws_data",
            "district_warning": "https://api.imd.gov.in/api/v1/districtwarning"
        },
        "docs_url": "https://api.imd.gov.in/public/api_reference.html#api-3"
    }

@app.post("/api/imd/configure")
async def configure_imd(req: IMDConfigureRequest):
    imd_service.set_credentials(req.api_key, req.jwt_token)
    status = await imd_service.check_connection()
    return {
        "status": "success",
        "configured": bool(req.api_key and req.jwt_token),
        "connection_check": status
    }

@app.get("/api/imd/current")
async def get_imd_current(station: str = "lucknow"):
    return await imd_service.get_current_weather(station)

@app.get("/api/imd/forecast")
async def get_imd_forecast(station: str = "lucknow"):
    return await imd_service.get_city_forecast(station)

@app.get("/api/imd/nowcast")
async def get_imd_nowcast(station: str = "lucknow"):
    return await imd_service.get_nowcast(station)

@app.get("/api/imd/aws")
async def get_imd_aws(state_id: str = "5"):
    return await imd_service.get_aws_data(state_id)

@app.post("/api/imd/poll-cluster")
async def poll_imd_cluster():
    results = {}
    now = datetime.now(timezone.utc)
    for stn_key in STATIONS:
        wx = await imd_service.get_current_weather(stn_key)
        d = wx.get("data", {})
        try:
            temp = float(d.get("Temperature deg C", 28.0))
            rh = float(d.get("Humidity %", 65.0))
            pres = float(d.get("M.S.L.P", 1008.0))
        except (ValueError, TypeError):
            temp, rh, pres = 28.0, 65.0, 1008.0
            
        telemetry_buffers[stn_key].append({
            "timestamp": now,
            "temp": temp, "rh": rh, "pres": pres,
            "raw_temp": temp, "raw_rh": rh, "raw_pres": pres,
            "source": wx.get("source", "IMD_API_3")
        })
        results[stn_key] = {
            "temp": temp,
            "rh": rh,
            "pres": pres,
            "weather": d.get("Weather Description"),
            "source": wx.get("source")
        }
        
    apply_active_faults()
    rebuild_processed_telemetry()
    return {
        "status": "success",
        "ingested_stations": results,
        "latest_state": processed_telemetry[-1] if processed_telemetry else None
    }

# ==============================================================================
# HUGGING FACE SPACES STATIC FRONTEND SERVING
# ==============================================================================

if STATIC_DIR.exists():
    assets_dir = STATIC_DIR / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")

@app.get("/")
async def serve_index():
    index_file = STATIC_DIR / "index.html"
    if index_file.exists():
        return FileResponse(index_file)
    return {"message": "SkyGuard AI backend online. Static frontend not found."}

@app.get("/{full_path:path}")
async def serve_spa_fallback(full_path: str):
    # Guard against intercepting API routes or OpenAPI endpoints
    if full_path.startswith("api") or full_path in ("docs", "redoc", "openapi.json"):
        raise HTTPException(status_code=404, detail="Endpoint not found")
    
    target = STATIC_DIR / full_path
    if target.is_file():
        return FileResponse(target)
    
    index_file = STATIC_DIR / "index.html"
    if index_file.exists():
        return FileResponse(index_file)
    
    raise HTTPException(status_code=404, detail="Not Found")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=7860, reload=False)
