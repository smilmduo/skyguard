"""
IMD (India Meteorological Department) Weather Forecasting & Telemetry Service
Integration for SkyGuard AI (SIH PS 26073 - MoES / IMD AWS Anomaly Detection)

Official Reference: https://api.imd.gov.in/public/api_reference.html#api-3
Endpoints Supported:
- API-3: Current Weather API (/api/v1/current_wx)
- API-1 / API-2: City Weather Forecast 7 Days (/api/v1/cityforecastloc)
- API-4 / API-7: District & Station Nowcast (/api/v1/districtnowcast, /api/v1/stationnowcast)
- API-9: AWS / ARG Telemetry Data (/api/v1/aws_data)
- API-6: District Weather Warnings (/api/v1/districtwarning)
"""

import os
import logging
from datetime import datetime, timezone, timedelta
from typing import Dict, Any, Optional, List
import httpx

logger = logging.getLogger(__name__)

# Official IMD Base URL
IMD_BASE_URL = "https://api.imd.gov.in/api/v1"

# Indo-Gangetic AWS Cluster Station Directory Mapping
IMD_STATION_MAP = {
    "lucknow": {
        "imd_id": "42182",
        "name": "LUCKNOW / AMAUSI",
        "district": "LUCKNOW",
        "district_id": "573",
        "aws_call_sign": "LKN",
        "lat": 26.8467,
        "lon": 80.9462,
        "state_id": "5"  # Uttar Pradesh
    },
    "kanpur": {
        "imd_id": "42379",
        "name": "KANPUR / CHAKERI",
        "district": "KANPUR NAGAR",
        "district_id": "556",
        "aws_call_sign": "KNP",
        "lat": 26.4499,
        "lon": 80.3319,
        "state_id": "5"
    },
    "barabanki": {
        "imd_id": "42189",
        "name": "BARABANKI",
        "district": "BARABANKI",
        "district_id": "553",
        "aws_call_sign": "BBK",
        "lat": 26.9268,
        "lon": 81.1834,
        "state_id": "5"
    },
    "sitapur": {
        "imd_id": "42178",
        "name": "SITAPUR",
        "district": "SITAPUR",
        "district_id": "597",
        "aws_call_sign": "STP",
        "lat": 27.5645,
        "lon": 80.6809,
        "state_id": "5"
    }
}

# WMO SYNOP Weather Code Table (01 - 99)
WMO_WEATHER_CODES = {
    "00": "Cloud development not observed or not observable",
    "01": "Clouds generally dissolving or becoming less developed",
    "02": "State of sky on the whole unchanged",
    "03": "Clouds generally forming or developing",
    "04": "Visibility reduced by smoke (forest fires, industrial smoke)",
    "05": "Haze",
    "06": "Widespread dust in suspension in the air",
    "07": "Dust or sand raised by wind",
    "08": "Well-developed dust/sand whirls",
    "09": "Duststorm or sandstorm within sight",
    "10": "Mist",
    "11": "Patches of shallow fog / ice fog",
    "12": "Continuous shallow fog / ice fog",
    "13": "Lightning visible, no thunder heard",
    "14": "Precipitation within sight, virga",
    "15": "Precipitation within sight, distant (>5 km)",
    "16": "Precipitation within sight, near station",
    "17": "Thunderstorm, no precipitation at station",
    "18": "Squalls within sight",
    "19": "Funnel cloud / tornado within sight",
    "20": "Drizzle (not freezing)",
    "21": "Continuous or intermittent rain",
    "22": "Continuous or intermittent snow",
    "25": "Showers of rain",
    "28": "Fog or ice fog",
    "29": "Thunderstorm with or without precipitation",
    "50": "Drizzle, intermittent slight",
    "51": "Drizzle, continuous slight",
    "60": "Rain, intermittent slight",
    "61": "Rain, continuous slight",
    "62": "Rain, intermittent moderate",
    "63": "Rain, continuous moderate",
    "64": "Rain, intermittent heavy",
    "65": "Rain, continuous heavy",
    "80": "Rain shower(s), slight",
    "81": "Rain shower(s), moderate or heavy",
    "95": "Thunderstorm, slight/moderate with rain/snow",
    "96": "Thunderstorm, slight/moderate with hail",
    "97": "Thunderstorm, heavy without hail",
    "99": "Thunderstorm, heavy with hail"
}

# Wind Direction Compass Map
WIND_DIRECTION_MAP = {
    0: "Calm", 20: "NNE", 50: "NE", 70: "ENE", 90: "E",
    110: "ESE", 140: "SE", 160: "SSE", 180: "S", 200: "SSW",
    230: "SW", 250: "WSW", 270: "W", 290: "WNW", 320: "NW",
    340: "NNW", 360: "N"
}

class IMDService:
    def __init__(self, api_key: Optional[str] = None, jwt_token: Optional[str] = None):
        self.api_key = api_key or os.environ.get("IMD_API_KEY", "")
        self.jwt_token = jwt_token or os.environ.get("IMD_JWT_TOKEN", "")
        self.timeout = 10.0
        self.last_status: Dict[str, Any] = {
            "configured": bool(self.api_key and self.jwt_token),
            "last_check": None,
            "connected": False,
            "error": None
        }

    def set_credentials(self, api_key: str, jwt_token: str):
        """Update IMD API credentials at runtime."""
        self.api_key = api_key.strip()
        self.jwt_token = jwt_token.strip()
        self.last_status["configured"] = bool(self.api_key and self.jwt_token)
        logger.info(f"Updated IMD credentials. Configured: {self.last_status['configured']}")

    def get_auth_headers(self) -> Dict[str, str]:
        """Construct official headers required by api.imd.gov.in gateway."""
        headers = {
            "User-Agent": "SkyGuard-AI/2.0 (SIH-PS-26073; MoES-IMD-AWS)",
            "Accept": "application/json"
        }
        if self.api_key:
            headers["x-api-key"] = self.api_key
        if self.jwt_token:
            clean_token = self.jwt_token if self.jwt_token.startswith("Bearer ") else f"Bearer {self.jwt_token}"
            headers["Authorization"] = clean_token
        return headers

    async def check_connection(self) -> Dict[str, Any]:
        """Verify connectivity and authentication against IMD gateway."""
        check_time = datetime.now(timezone.utc).isoformat()
        if not self.api_key or not self.jwt_token:
            self.last_status = {
                "configured": False,
                "connected": False,
                "last_check": check_time,
                "mode": "Simulation/Fallback",
                "message": "IMD API credentials not configured. Please supply x-api-key and JWT token from https://api.imd.gov.in/public/login.php"
            }
            return self.last_status

        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                url = f"{IMD_BASE_URL}/current_wx?id=42182"
                resp = await client.get(url, headers=self.get_auth_headers())
                if resp.status_code == 200:
                    self.last_status = {
                        "configured": True,
                        "connected": True,
                        "last_check": check_time,
                        "mode": "Official IMD Live Gateway",
                        "status_code": 200,
                        "message": "Successfully authenticated with IMD API Gateway."
                    }
                else:
                    self.last_status = {
                        "configured": True,
                        "connected": False,
                        "last_check": check_time,
                        "mode": "Fallback (Auth Pending)",
                        "status_code": resp.status_code,
                        "message": f"IMD Gateway response {resp.status_code}: {resp.text}"
                    }
        except Exception as e:
            self.last_status = {
                "configured": True,
                "connected": False,
                "last_check": check_time,
                "mode": "Fallback (Network Error)",
                "message": f"Connection error: {str(e)}"
            }
        return self.last_status

    async def get_current_weather(self, station_key: str = "lucknow") -> Dict[str, Any]:
        """
        API-3: Current Weather API
        URL: https://api.imd.gov.in/api/v1/current_wx?id=StationId
        Returns real-time observation matching IMD schema.
        """
        meta = IMD_STATION_MAP.get(station_key.lower(), IMD_STATION_MAP["lucknow"])
        station_id = meta["imd_id"]
        
        # Try live gateway if configured
        if self.api_key and self.jwt_token:
            try:
                async with httpx.AsyncClient(timeout=self.timeout) as client:
                    url = f"{IMD_BASE_URL}/current_wx?id={station_id}"
                    resp = await client.get(url, headers=self.get_auth_headers())
                    if resp.status_code == 200:
                        data = resp.json()
                        return {
                            "source": "IMD_LIVE_GATEWAY",
                            "station_key": station_key,
                            "data": data,
                            "timestamp": datetime.now(timezone.utc).isoformat()
                        }
            except Exception as e:
                logger.warning(f"IMD Live Current Weather fetch failed: {e}. Falling back to calibrated schema.")

        # Fallback / Demo Simulation calibrated to Indo-Gangetic station characteristics
        now = datetime.now(timezone.utc)
        ist_now = now + timedelta(hours=5, minutes=30)
        
        # Diurnal temperature cycle modeling
        hour_fraction = ist_now.hour + ist_now.minute / 60.0
        diurnal_factor = 0.5 * (1 + -1.0 * (math_cos_hour := (2 * 3.141592 * (hour_fraction - 14) / 24.0)))
        # Base climatology for Lucknow region
        t_base = 28.5 + 4.5 * (1 - diurnal_factor)
        rh_base = 65.0 - 15.0 * (1 - diurnal_factor)
        p_base = 1008.0 + 2.0 * math_cos_hour

        # Station micro-climate deltas
        deltas = {
            "lucknow": {"t": 0.0, "rh": 0.0, "p": 0.0},
            "kanpur": {"t": 0.4, "rh": -2.0, "p": -0.8},
            "barabanki": {"t": -0.3, "rh": 3.0, "p": 0.4},
            "sitapur": {"t": -0.6, "rh": 4.0, "p": 1.2}
        }
        d = deltas.get(station_key.lower(), {"t": 0.0, "rh": 0.0, "p": 0.0})

        temp = round(t_base + d["t"], 1)
        rh = max(20.0, min(100.0, round(rh_base + d["rh"], 1)))
        pres = round(p_base + d["p"], 1)

        weather_code = "02" if rh < 75 else ("05" if temp > 32 else "21")
        weather_desc = WMO_WEATHER_CODES.get(weather_code, "Partly Cloudy")
        wind_dir_deg = 180  # Southerly monsoon/post-monsoon flow
        wind_speed_kmph = 8.0

        sample_record = {
            "Station Id": station_id,
            "Station": meta["name"],
            "District": meta["district"],
            "State": "UTTAR PRADESH",
            "Date of Observation": ist_now.strftime("%Y-%m-%d"),
            "Time of Observation UTC": now.strftime("%H:%M:%S"),
            "Time of Observation IST": ist_now.strftime("%H:%M:%S"),
            "M.S.L.P": str(pres),
            "Pressure_Unit": "hPa",
            "Wind Direction Code": str(wind_dir_deg),
            "Wind Direction": WIND_DIRECTION_MAP.get(wind_dir_deg, "Southerly"),
            "Wind Speed KMPH": str(wind_speed_kmph),
            "Temperature deg C": str(temp),
            "Weather Code": weather_code,
            "Weather Description": weather_desc,
            "Nebulosity": "3",
            "Nebulosity Description": "3 oktas (scattered clouds)",
            "Humidity %": str(rh),
            "Last 24 hrs Rainfall mm": "0.0",
            "Latitude": meta["lat"],
            "Longitude": meta["lon"]
        }

        return {
            "source": "IMD_CALIBRATED_FALLBACK" if not (self.api_key and self.jwt_token) else "IMD_FALLBACK_AFTER_GATEWAY_TIMEOUT",
            "station_key": station_key,
            "is_live": bool(self.api_key and self.jwt_token and self.last_status.get("connected")),
            "note": "Official IMD API-3 field format. To switch to live gateway, configure x-api-key and JWT token.",
            "data": sample_record,
            "timestamp": now.isoformat()
        }

    async def get_city_forecast(self, station_key: str = "lucknow") -> Dict[str, Any]:
        """
        API-1 / API-2: City Weather Forecast for 7 days
        URL: https://api.imd.gov.in/api/v1/cityforecastloc?id=42182
        """
        meta = IMD_STATION_MAP.get(station_key.lower(), IMD_STATION_MAP["lucknow"])
        station_id = meta["imd_id"]

        if self.api_key and self.jwt_token:
            try:
                async with httpx.AsyncClient(timeout=self.timeout) as client:
                    url = f"{IMD_BASE_URL}/cityforecastloc?id={station_id}"
                    resp = await client.get(url, headers=self.get_auth_headers())
                    if resp.status_code == 200:
                        return {
                            "source": "IMD_LIVE_GATEWAY",
                            "station_key": station_key,
                            "data": resp.json(),
                            "timestamp": datetime.now(timezone.utc).isoformat()
                        }
            except Exception as e:
                logger.warning(f"IMD Live City Forecast fetch failed: {e}")

        now = datetime.now(timezone.utc)
        ist_now = now + timedelta(hours=5, minutes=30)
        
        # Generate 7-day realistic IMD forecast sequence
        daily_forecasts = []
        forecast_weather_types = [
            ("Mainly clear sky", 34.0, 23.5, "+1.2", "0.0"),
            ("Partly cloudy sky", 33.5, 23.0, "+0.8", "0.0"),
            ("Partly cloudy sky with haze", 33.0, 22.8, "+0.5", "0.0"),
            ("Generally cloudy sky with light rain", 31.5, 22.0, "-1.0", "4.2"),
            ("Thunderstorm with rain", 30.0, 21.5, "-2.5", "12.0"),
            ("Partly cloudy sky", 32.0, 22.0, "-0.5", "0.0"),
            ("Mainly clear sky", 33.5, 23.0, "+0.8", "0.0")
        ]

        forecast_payload: Dict[str, Any] = {
            "Station_Code": station_id,
            "Station_Name": meta["name"],
            "Latitude": str(meta["lat"]),
            "Longitude": str(meta["lon"]),
            "Date": ist_now.strftime("%Y-%m-%d"),
            "Today_Max_temp": "34.2",
            "Today_Max_Departure_from_Normal": "+1.4",
            "Today_Min_temp": "23.6",
            "Today_Min_Departure_from_Normal": "+0.8",
            "Previous_Day_Max_temp": "33.8",
            "Previous_Day_Max_Departure_from_Normal": "+1.0",
            "Relative_Humidity_at_0830": "72",
            "Relative_Humidity_at_1730": "54",
            "Past_24_hrs_Rainfall": "0.0",
            "Sunrise_time": "06:05",
            "Sunset_time": "18:02",
            "Moonrise_time": "20:45",
            "Moonset_time": "08:15",
            "Todays_Forecast": forecast_weather_types[0][0],
            "Todays_Forecast_Max_Temp": str(forecast_weather_types[0][1]),
            "Todays_Forecast_Min_temp": str(forecast_weather_types[0][2]),
        }

        for day_idx in range(2, 8):
            w_text, max_t, min_t, dep, rain = forecast_weather_types[day_idx - 1]
            forecast_payload[f"Day_{day_idx}_Forecast"] = w_text
            forecast_payload[f"Day_{day_idx}_Max_Temp"] = str(max_t)
            forecast_payload[f"Day_{day_idx}_Min_temp"] = str(min_t)

        return {
            "source": "IMD_CALIBRATED_FALLBACK" if not (self.api_key and self.jwt_token) else "IMD_FALLBACK_AFTER_TIMEOUT",
            "station_key": station_key,
            "is_live": bool(self.api_key and self.jwt_token and self.last_status.get("connected")),
            "data": forecast_payload,
            "days_forecast": [
                {
                    "day_number": idx + 1,
                    "date": (ist_now + timedelta(days=idx)).strftime("%Y-%m-%d"),
                    "day_label": (ist_now + timedelta(days=idx)).strftime("%a, %d %b"),
                    "condition": forecast_weather_types[idx][0],
                    "max_temp": forecast_weather_types[idx][1],
                    "min_temp": forecast_weather_types[idx][2],
                    "departure": forecast_weather_types[idx][3],
                    "rainfall": forecast_weather_types[idx][4]
                }
                for idx in range(7)
            ],
            "timestamp": now.isoformat()
        }

    async def get_nowcast(self, station_key: str = "lucknow") -> Dict[str, Any]:
        """
        API-4 / API-7: District & Station Nowcast
        URL: https://api.imd.gov.in/api/v1/stationnowcast?id=Lucknow
        """
        meta = IMD_STATION_MAP.get(station_key.lower(), IMD_STATION_MAP["lucknow"])
        
        if self.api_key and self.jwt_token:
            try:
                async with httpx.AsyncClient(timeout=self.timeout) as client:
                    url = f"{IMD_BASE_URL}/stationnowcast?id={meta['name'].split('/')[0].strip()}"
                    resp = await client.get(url, headers=self.get_auth_headers())
                    if resp.status_code == 200:
                        return {
                            "source": "IMD_LIVE_GATEWAY",
                            "station_key": station_key,
                            "data": resp.json(),
                            "timestamp": datetime.now(timezone.utc).isoformat()
                        }
            except Exception as e:
                logger.warning(f"IMD Live Nowcast fetch failed: {e}")

        now = datetime.now(timezone.utc)
        ist_now = now + timedelta(hours=5, minutes=30)
        v_upto = ist_now + timedelta(hours=3)

        nowcast_payload = {
            "Station": meta["name"],
            "District": meta["district"],
            "Date": ist_now.strftime("%Y-%m-%d"),
            "toi": ist_now.strftime("%H%M"),
            "Vupto": v_upto.strftime("%H%M"),
            "color": "1",  # 1: Green (No Weather), 2: Yellow, 3: Orange, 4: Red
            "color_name": "GREEN",
            "color_hex": "#008000",
            "severity_level": "NO_WARNING",
            "message": "No significant weather condition expected over the station in next 3 hours. Visibility normal, surface wind gentle.",
            "probabilities": {
                "lightning": "< 30%",
                "gust_speed": "< 40 kmph",
                "rain_rate": "< 5 mm/hr"
            }
        }

        return {
            "source": "IMD_CALIBRATED_FALLBACK" if not (self.api_key and self.jwt_token) else "IMD_FALLBACK_AFTER_TIMEOUT",
            "station_key": station_key,
            "is_live": bool(self.api_key and self.jwt_token and self.last_status.get("connected")),
            "data": nowcast_payload,
            "timestamp": now.isoformat()
        }

    async def get_aws_data(self, state_id: str = "5") -> Dict[str, Any]:
        """
        API-9: AWS / ARG Telemetry Data
        URL: https://api.imd.gov.in/api/v1/aws_data?sid=5 (State ID 5 = Uttar Pradesh)
        """
        if self.api_key and self.jwt_token:
            try:
                async with httpx.AsyncClient(timeout=self.timeout) as client:
                    url = f"{IMD_BASE_URL}/aws_data?sid={state_id}"
                    resp = await client.get(url, headers=self.get_auth_headers())
                    if resp.status_code == 200:
                        return {
                            "source": "IMD_LIVE_GATEWAY",
                            "state_id": state_id,
                            "data": resp.json(),
                            "timestamp": datetime.now(timezone.utc).isoformat()
                        }
            except Exception as e:
                logger.warning(f"IMD AWS data fetch failed: {e}")

        # Return AWS records for the 4 Indo-Gangetic cluster stations
        now = datetime.now(timezone.utc)
        ist_now = now + timedelta(hours=5, minutes=30)
        
        cluster_records = []
        for s_key, s_meta in IMD_STATION_MAP.items():
            cluster_records.append({
                "ID": f"UP_{s_meta['aws_call_sign']}_01",
                "CALL_SIGN": s_meta["aws_call_sign"],
                "DISTRICT": s_meta["district"],
                "STATE": "UTTAR_PRADESH",
                "STATION": s_meta["name"],
                "DATE": ist_now.strftime("%Y-%m-%d"),
                "TIME": ist_now.strftime("%H:%M:%S"),
                "CURR_TEMP": "28.8",
                "DEW_POINT_TEMP": "21.2",
                "RH": "63",
                "WIND_DIRECTION": "180",
                "WIND_SPEED": "7",
                "MSLP": "1008.4",
                "MIN_TEMP": "23.5",
                "MAX_TEMP": "34.0",
                "Latitude": str(s_meta["lat"]),
                "Longitude": str(s_meta["lon"]),
                "WEATHER_CODE": "2",
                "NEBULOSITY": "3",
                "Feel Like": "30.5"
            })

        return {
            "source": "IMD_CALIBRATED_FALLBACK" if not (self.api_key and self.jwt_token) else "IMD_FALLBACK_AFTER_TIMEOUT",
            "state_id": state_id,
            "is_live": bool(self.api_key and self.jwt_token and self.last_status.get("connected")),
            "stations_count": len(cluster_records),
            "data": cluster_records,
            "timestamp": now.isoformat()
        }

# Global Singleton Instance
imd_service = IMDService()
