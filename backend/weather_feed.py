"""Server-owned Open-Meteo feed, with shared cooldown and real-data cache."""
from contextlib import AsyncExitStack
import asyncio
import random
import re
import json
import logging
import math
import os
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

import httpx

logger = logging.getLogger("skyguard-backend")


class WeatherFeed:
    def __init__(self, stations, cache_path=None):
        self.stations = stations
        self.interval = max(60, int(os.getenv("POLLING_INTERVAL_SEC", "900")))
        self.key = os.getenv("OPEN_METEO_API_KEY", "").strip()
        self.url = ("https://customer-api.open-meteo.com/v1/forecast" if self.key
                    else "https://api.open-meteo.com/v1/forecast")
        self.cache_path = Path(cache_path or os.getenv(
            "WEATHER_CACHE_PATH", str(Path(__file__).parent / "data" / "weather-cache.json")))
        self.next_attempt = 0.0
        self.failure_counts = {"current": 0, "history": 0}
        self.failures = 0
        self.error = None
        self.last_success = None
        self.current = {}
        self.details = {"current": None, "history": None}
        self.station_errors = {"current": {}, "history": {}}
        self.history_next = 0.0
        self.blocked_until = 0.0
        self.lock = asyncio.Lock()

    def load(self, buffers):
        try:
            payload = json.loads(self.cache_path.read_text(encoding="utf-8"))
            restored = {}
            for station in self.stations:
                restored[station] = [self.reading(
                    row["timestamp"], row["raw_temp"], row["raw_rh"], row["raw_pres"]
                ) for row in payload["stations"][station] if row.get("source") == "OPEN_METEO"
                    and datetime.fromisoformat(row["timestamp"]).timestamp() % 3600 == 0]
            for station, rows in restored.items():
                buffers[station].extend(sorted(rows, key=lambda row: row["timestamp"]))
            self.next_attempt = float(payload.get("next_attempt", 0))
            self.failures = int(payload.get("failures", 0))
            self.failure_counts = payload.get("failure_counts", self.failure_counts)
            self.last_success = payload.get("last_success")
            self.error = payload.get("error")
            self.current = {s: self.reading(row["timestamp"], row["raw_temp"], row["raw_rh"], row["raw_pres"])
                            for s, row in payload.get("current", {}).items() if s in self.stations}
            self.history_next = float(payload.get("history_next", 0))
            self.blocked_until = float(payload.get("blocked_until", 0))
            self.details = payload.get("details", self.details)
            self.station_errors = payload.get("station_errors", self.station_errors)
        except FileNotFoundError:
            pass
        except (OSError, ValueError, KeyError, TypeError):
            logger.warning("Weather cache unavailable or invalid; waiting for provider data.")

    def save(self, buffers):
        try:
            self.cache_path.parent.mkdir(parents=True, exist_ok=True)
            payload = {
                "stations": {s: [dict(row, timestamp=row["timestamp"].isoformat())
                                  for row in rows if row.get("source") == "OPEN_METEO"]
                             for s, rows in buffers.items()},
                "current": {s: dict(row, timestamp=row["timestamp"].isoformat()) for s, row in self.current.items()},
                "failure_counts": self.failure_counts,
                "history_next": self.history_next, "blocked_until": self.blocked_until,
                "details": self.details, "station_errors": self.station_errors,
                "next_attempt": self.next_attempt, "failures": self.failures,
                "last_success": self.last_success, "error": self.error,
            }
            temporary = self.cache_path.with_suffix(".tmp")
            temporary.write_text(json.dumps(payload), encoding="utf-8")
            temporary.replace(self.cache_path)
        except OSError:
            logger.warning("Could not persist weather cache; data remains in memory.")

    @staticmethod
    def reading(timestamp, temp, rh, pres):
        dt = datetime.fromisoformat(timestamp)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        values = [float(temp), float(rh), float(pres)]
        if not all(math.isfinite(value) for value in values):
            raise ValueError("Non-finite weather value")
        return {"timestamp": dt, "temp": values[0], "rh": values[1], "pres": values[2],
                "raw_temp": values[0], "raw_rh": values[1], "raw_pres": values[2],
                "source": "OPEN_METEO"}

    def retry_delay(self, response, now):
        delay = min(3600, 300 * 2 ** min(self.failures - 1, 4))
        if response is not None:
            value = response.headers.get("Retry-After", "")
            try:
                delay = max(delay, float(value))
            except ValueError:
                try:
                    delay = max(delay, parsedate_to_datetime(value).timestamp() - now)
                except (ValueError, TypeError, OverflowError):
                    pass
        return delay + random.uniform(0, 15)

    def history_missing(self, buffers, now):
        end = int(now // 3600) * 3600
        expected = set(range(end - 47 * 3600, end + 1, 3600))
        return any(not expected.issubset({int(row["timestamp"].timestamp()) for row in rows})
                   for rows in buffers.values())

    def diagnostic(self, response, exc):
        status = response.status_code if response is not None else None
        category = ("rate_limited" if status == 429 else "invalid_request" if status and 400 <= status < 500
                    else "provider_unavailable" if status and status >= 500
                    else "connection_failed" if isinstance(exc, httpx.RequestError) else "invalid_response")
        reason = category.replace("_", " ")
        if response is not None:
            try:
                reason = str(response.json().get("reason", reason))
            except (ValueError, AttributeError):
                pass
        if self.key:
            reason = reason.replace(self.key, "[redacted]")
        reason = re.sub(r"(?i)(apikey=)[^&\s]+", r"\1[redacted]", reason)
        reason = " ".join(reason.split())[:300]
        return {"category": category, "http_status": status, "reason": reason,
                "retry_after": response.headers.get("Retry-After") if response is not None else None}

    async def refresh(self, buffers, client=None):
        async with self.lock:
            now = time.time()
            if now < self.blocked_until:
                return False
            changed = False
            async with AsyncExitStack() as stack:
                if client is None:
                    client = await stack.enter_async_context(httpx.AsyncClient(timeout=20))
                for kind in ("current", "history"):
                    if now < self.blocked_until:
                        break
                    due = self.next_attempt if kind == "current" else self.history_next
                    if now < due:
                        continue
                    if kind == "history" and not self.history_missing(buffers, now):
                        self.history_next = (int(now // 3600) + 1) * 3600 + 60
                        continue
                    params = {
                        "latitude": ",".join(str(c["lat"]) for c in self.stations.values()),
                        "longitude": ",".join(str(c["lon"]) for c in self.stations.values()),
                        "timezone": "UTC",
                    }
                    variables = "temperature_2m,relative_humidity_2m,surface_pressure"
                    if kind == "current":
                        params["current"] = variables
                    else:
                        params.update(hourly=variables, past_hours=48, forecast_hours=1)
                    if self.key:
                        params["apikey"] = self.key
                    response = None
                    try:
                        response = await client.get(self.url, params=params)
                        response.raise_for_status()
                        payload = response.json()
                        results = payload if isinstance(payload, list) else [payload]
                        if len(results) != len(self.stations):
                            raise ValueError("Station count mismatch")
                        failures = {}
                        accepted = 0
                        for station, result in zip(self.stations, results):
                            try:
                                if kind == "current":
                                    data = result["current"]
                                    row = self.reading(data["time"], *(data[v] for v in variables.split(",")))
                                    if row["timestamp"].timestamp() > now + 60:
                                        raise ValueError("Future timestamp")
                                    previous = self.current.get(station)
                                    if previous is None or row["timestamp"] >= previous["timestamp"]:
                                        self.current[station] = row
                                    accepted += 1
                                else:
                                    data = result["hourly"]
                                    rows = []
                                    for index, stamp in enumerate(data["time"]):
                                        try:
                                            row = self.reading(stamp, *(data[v][index] for v in variables.split(",")))
                                            timestamp = row["timestamp"].timestamp()
                                            if timestamp <= now and timestamp % 3600 == 0:
                                                rows.append(row)
                                        except (ValueError, TypeError, IndexError, KeyError):
                                            continue
                                    if not rows:
                                        raise ValueError("No valid hourly data")
                                    merged = {r["timestamp"]: r for r in buffers[station]}
                                    merged.update({r["timestamp"]: r for r in rows})
                                    buffers[station].clear()
                                    buffers[station].extend(merged[t] for t in sorted(merged))
                                    accepted += 1
                            except (ValueError, TypeError, KeyError, IndexError):
                                failures[station] = "Missing or invalid weather values"
                        self.station_errors[kind] = failures
                        if not accepted:
                            raise ValueError("No valid stations")
                        self.details[kind] = None if not failures else {
                            "category": "partial_response", "http_status": 200,
                            "reason": "Some stations have missing or invalid values", "retry_after": None}
                        self.failure_counts[kind] = 0
                        if kind == "current":
                            self.error = "partial_response" if failures else None
                            self.last_success = datetime.fromtimestamp(now, timezone.utc).isoformat()
                            self.failures = 0
                            self.next_attempt = now + self.interval
                        else:
                            self.history_next = now + (900 if self.history_missing(buffers, now) else 3600)
                        changed = True
                    except (httpx.HTTPError, ValueError, KeyError, TypeError, IndexError) as exc:
                        self.details[kind] = self.diagnostic(response, exc)
                        self.failure_counts[kind] += 1
                        self.failures = self.failure_counts[kind]
                        delay = self.retry_delay(response, now)
                        self.failure_counts[kind] = 0
                        if kind == "current":
                            self.error = self.details[kind]["category"]
                            self.next_attempt = now + delay
                        else:
                            self.history_next = now + delay
                        if response is not None and response.status_code == 429:
                            self.blocked_until = now + delay
                        logger.warning("Weather %s: %s; retry in %.0fs", kind, self.details[kind], delay)
            self.save(buffers)
            return changed

    def next_wakeup(self):
        return max(self.blocked_until, min(self.next_attempt, self.history_next))

    def status(self, buffers):
        now = time.time()
        stations = {}
        for station in self.stations:
            row = self.current.get(station)
            state = "unavailable" if row is None else (
                "stale" if now - row["timestamp"].timestamp() > max(1800, self.interval * 2)
                or self.error not in (None, "partial_response")
                or station in self.station_errors["current"] else "current")
            stations[station] = {"status": state, "reading": dict(row, timestamp=row["timestamp"].isoformat()) if row else None}
        states = [s["status"] for s in stations.values()]
        state = "current" if all(s == "current" for s in states) else (
            "unavailable" if all(s == "unavailable" for s in states) else "stale")
        return {"status": state, "source": "OPEN_METEO", "provider_error": self.error,
                "last_success": self.last_success, "stations": stations, "diagnostics": self.details,
                "station_errors": self.station_errors,
                "history_complete": not self.history_missing(buffers, now),
                "last_observations": {s: row["timestamp"].isoformat() for s, row in self.current.items()},
                "next_retry": datetime.fromtimestamp(max(self.next_attempt, self.blocked_until), timezone.utc).isoformat(),
                "next_history_retry": datetime.fromtimestamp(max(self.history_next, self.blocked_until), timezone.utc).isoformat(),
                "polling_interval_seconds": self.interval}
