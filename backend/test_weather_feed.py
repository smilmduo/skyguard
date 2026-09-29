import tempfile
import unittest
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import httpx

from backend.weather_feed import WeatherFeed


class WeatherFeedTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        jitter = patch("backend.weather_feed.random.uniform", return_value=0)
        jitter.start()
        self.addCleanup(jitter.stop)
        self.stations = {"a": {"lat": 1, "lon": 2}, "b": {"lat": 3, "lon": 4}}
        self.path = Path(self.directory.name) / "weather.json"
        self.feed = WeatherFeed(self.stations, self.path)
        self.buffers = {s: deque(maxlen=100) for s in self.stations}
        self.now = 1790683200.0
        self.stamp = datetime.fromtimestamp(self.now, timezone.utc).isoformat()

    def payload(self):
        return [{"current": {"time": self.stamp, "temperature_2m": 25,
                              "relative_humidity_2m": 75, "surface_pressure": 1000}}
                for _ in self.stations]

    async def request(self, response):
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: response)) as client:
            with patch("backend.weather_feed.time.time", return_value=self.now):
                return await self.feed.refresh(self.buffers, client)

    async def test_rate_limit_cooldown_survives_restart_and_skips_requests(self):
        self.assertFalse(await self.request(httpx.Response(429, headers={"Retry-After": "7200"})))
        self.assertEqual(self.feed.next_attempt, self.now + 7200)
        replacement = WeatherFeed(self.stations, self.path)
        replacement.load(self.buffers)
        self.assertEqual(replacement.next_attempt, self.feed.next_attempt)
        self.feed = replacement
        self.assertFalse(await self.request(httpx.Response(200, json=self.payload())))
        self.assertFalse(any(self.buffers.values()))

    async def test_recovery_and_no_duplicates(self):
        await self.request(httpx.Response(429))
        self.now = self.feed.next_attempt
        self.assertTrue(await self.request(httpx.Response(200, json=self.payload())))
        self.assertEqual(self.feed.failure_counts["current"], 0)
        self.assertIsNone(self.feed.error)
        self.now = self.feed.next_attempt
        await self.request(httpx.Response(200, json=self.payload()))
        self.assertEqual(self.feed.current["a"]["temp"], 25)

    async def test_failure_retains_values_and_timestamps(self):
        await self.request(httpx.Response(200, json=self.payload()))
        before = dict(self.feed.current["a"])
        self.now = self.feed.next_attempt
        await self.request(httpx.Response(429))
        self.assertEqual(self.feed.current["a"], before)
        with patch("backend.weather_feed.time.time", return_value=self.now):
            self.assertEqual(self.feed.status(self.buffers)["status"], "stale")

    async def test_valid_station_survives_invalid_neighbor(self):
        payload = self.payload()
        payload[1]["current"]["temperature_2m"] = None
        self.assertTrue(await self.request(httpx.Response(200, json=payload)))
        self.assertIn("a", self.feed.current)
        self.assertNotIn("b", self.feed.current)

    async def test_future_hourly_values_excluded(self):
        payload = self.payload()
        for result in payload:
            result["hourly"] = {"time": ["2099-01-01T00:00"], "temperature_2m": [50],
                                "relative_humidity_2m": [10], "surface_pressure": [990]}
        await self.request(httpx.Response(200, json=payload))
        self.assertEqual(self.feed.current["a"]["temp"], 25)
        self.assertFalse(self.buffers["a"])

    async def test_cache_restores_original_values(self):
        await self.request(httpx.Response(200, json=self.payload()))
        self.feed.current["a"]["temp"] = 999
        self.feed.save(self.buffers)
        restored = WeatherFeed(self.stations, self.path)
        restored.load(self.buffers)
        self.assertEqual(restored.current["a"]["temp"], 25)
        self.assertEqual(restored.current["a"]["timestamp"].isoformat(), self.stamp)

    def test_date_retry_after_and_exponential_backoff(self):
        self.feed.failures = 1
        response = httpx.Response(429, headers={"Retry-After": "Tue, 29 Sep 2026 14:00:00 GMT"})
        self.assertGreaterEqual(self.feed.retry_delay(response, self.now), 300)
        self.feed.failures = 2
        self.assertEqual(self.feed.retry_delay(None, self.now), 600)

    def test_paid_endpoint_and_interval_configuration(self):
        with patch.dict("os.environ", {"OPEN_METEO_API_KEY": "test-key", "POLLING_INTERVAL_SEC": "600"}):
            feed = WeatherFeed(self.stations, self.path)
        self.assertEqual(feed.interval, 600)
        self.assertEqual(feed.url, "https://customer-api.open-meteo.com/v1/forecast")

    async def test_api_head_status_and_retired_ingest(self):
        from backend.app import app
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            self.assertEqual((await client.head("/")).status_code, 200)
            self.assertEqual((await client.get("/api/weather/status")).json()["status"], "unavailable")
            self.assertEqual((await client.post("/api/telemetry/ingest", json=[])).status_code, 410)

    async def test_provider_readings_process_without_synthetic_seeding(self):
        import backend.app as module
        buffers = {s: deque(maxlen=100) for s in module.STATIONS}
        for rows in buffers.values():
            for hour in range(48):
                stamp = datetime.fromtimestamp(self.now - (48 - hour) * 3600, timezone.utc).isoformat()
                rows.append(self.feed.reading(stamp, 25 + hour % 4, 75, 1000))
        processed = deque()
        with patch.object(module, "telemetry_buffers", buffers), patch.object(module, "processed_telemetry", processed):
            module.rebuild_processed_telemetry()
        self.assertEqual(len(processed), 48)
        self.assertEqual(processed[-1]["source"], "OPEN_METEO")

    async def test_history_failure_preserves_current_and_diagnostics(self):
        def handler(request):
            if "current" in request.url.params:
                return httpx.Response(200, json=self.payload())
            return httpx.Response(429, json={"error": True, "reason": "Daily limit reached"})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            with patch("backend.weather_feed.time.time", return_value=self.now):
                await self.feed.refresh(self.buffers, client)
                status = self.feed.status(self.buffers)
        self.assertEqual(status["status"], "current")
        self.assertEqual(status["diagnostics"]["history"]["http_status"], 429)
        self.assertEqual(status["diagnostics"]["history"]["reason"], "Daily limit reached")

    async def test_hourly_backfill_separate_from_current(self):
        def handler(request):
            if "current" in request.url.params:
                return httpx.Response(200, json=self.payload())
            stamps = [datetime.fromtimestamp(self.now - hour * 3600, timezone.utc).isoformat()
                      for hour in range(47, -1, -1)]
            return httpx.Response(200, json=[{"hourly": {"time": stamps,
                "temperature_2m": [25] * 48, "relative_humidity_2m": [75] * 48,
                "surface_pressure": [1000] * 48}} for _ in self.stations])
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            with patch("backend.weather_feed.time.time", return_value=self.now):
                await self.feed.refresh(self.buffers, client)
        self.assertEqual(len(self.buffers["a"]), 48)
        self.assertFalse(self.feed.history_missing(self.buffers, self.now))
        self.assertTrue(self.feed.history_missing(self.buffers, self.now + 7200))

    async def test_concurrent_refresh_only_requests_once_per_kind(self):
        import asyncio
        requests = []
        def handler(request):
            requests.append(request)
            return httpx.Response(200, json=self.payload())
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            with patch("backend.weather_feed.time.time", return_value=self.now):
                await asyncio.gather(self.feed.refresh(self.buffers, client), self.feed.refresh(self.buffers, client))
        self.assertEqual(len(requests), 2)

    def test_secret_redaction(self):
        self.feed.key = "private-key"
        response = httpx.Response(400, json={"reason": "bad apikey=private-key"})
        self.assertNotIn("private-key", str(self.feed.diagnostic(response, ValueError())))


    async def test_history_endpoint_uses_elapsed_hours(self):
        import backend.app as module
        from datetime import timedelta
        now = datetime.now(timezone.utc)
        records = deque([{"timestamp": (now - timedelta(hours=h)).isoformat()} for h in (30, 23, 2)])
        with patch.object(module, "processed_telemetry", records):
            result = await module.get_telemetry_history(24)
        self.assertEqual(len(result), 2)

    def test_analysis_waits_for_contiguous_hourly_data(self):
        import backend.app as module
        buffers = {s: deque() for s in module.STATIONS}
        for rows in buffers.values():
            for index in range(48):
                stamp = datetime.fromtimestamp(self.now - index * 900, timezone.utc).isoformat()
                rows.append(self.feed.reading(stamp, 25, 75, 1000))
        processed = deque()
        with patch.object(module, "telemetry_buffers", buffers), patch.object(module, "processed_telemetry", processed):
            module.rebuild_processed_telemetry()
        self.assertFalse(processed)

    async def test_connection_failure_is_distinct_from_provider_rejection(self):
        def handler(request):
            raise httpx.ConnectError("offline", request=request)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            with patch("backend.weather_feed.time.time", return_value=self.now):
                await self.feed.refresh(self.buffers, client)
        self.assertEqual(self.feed.details["current"]["category"], "connection_failed")
        self.assertIsNone(self.feed.details["current"]["http_status"])



if __name__ == "__main__":
    unittest.main()
