"""Current weather for the HUD.

The position comes from Windows Location when the user has allowed it, which
works from nearby Wi-Fi and is usually within a few hundred metres. Otherwise
it falls back to the public IP address, which can be a city or more out.
None of the services used here need a key.
"""

import asyncio
import json
import logging
import subprocess
from pathlib import Path
from typing import Any

import httpx2 as httpx

log = logging.getLogger("jarvis")

LOCATION_URL = "https://ipapi.co/json/"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
# Turns coordinates into a place name. Its policy asks for an identifying User-Agent.
REVERSE_URL = "https://nominatim.openstreetmap.org/reverse"
USER_AGENT = "Onyx-desktop-assistant/0.1"
LOCATION_SCRIPT = Path(__file__).with_name("scripts") / "location.ps1"
LOCATION_SETTINGS = "ms-settings:privacy-location"
REFRESH_S = 15 * 60
RETRY_S = 60

# WMO weather codes, as Open-Meteo reports them.
CONDITIONS = {
    0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Fog", 48: "Fog", 51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
    56: "Freezing drizzle", 57: "Freezing drizzle", 61: "Light rain", 63: "Rain", 65: "Heavy rain",
    66: "Freezing rain", 67: "Freezing rain", 71: "Light snow", 73: "Snow", 75: "Heavy snow",
    77: "Snow grains", 80: "Showers", 81: "Showers", 82: "Heavy showers",
    85: "Snow showers", 86: "Snow showers", 95: "Thunderstorm", 96: "Thunderstorm, hail", 99: "Thunderstorm, hail",
}

_latest: dict[str, Any] | None = None


def latest() -> dict[str, Any] | None:
    return _latest


def _windows_location() -> dict[str, Any]:
    """{"status": "ok", latitude, longitude, accuracy_m} or {"status": why not}."""
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(LOCATION_SCRIPT)],
            capture_output=True,
            text=True,
            timeout=30,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        return json.loads(result.stdout or "{}") or {"status": "unavailable"}
    except (OSError, ValueError, subprocess.SubprocessError):
        return {"status": "unavailable"}


async def _place_name(client: httpx.AsyncClient, lat: float, lon: float) -> str | None:
    try:
        resp = await client.get(
            REVERSE_URL,
            params={"lat": lat, "lon": lon, "format": "jsonv2", "zoom": 14},
            headers={"User-Agent": USER_AGENT},
        )
        addr = resp.raise_for_status().json().get("address", {})
    except (httpx.HTTPError, ValueError):
        return None
    for key in ("village", "suburb", "town", "city", "hamlet", "county", "state_district"):
        if addr.get(key):
            return addr[key]
    return None


async def _locate(client: httpx.AsyncClient) -> dict[str, Any]:
    win = await asyncio.to_thread(_windows_location)
    if win.get("status") == "ok":
        lat, lon = win["latitude"], win["longitude"]
        return {
            "latitude": lat,
            "longitude": lon,
            "city": await _place_name(client, lat, lon) or f"{lat:.3f}, {lon:.3f}",
            "source": "windows",
            "accuracy_m": round(win.get("accuracy_m") or 0),
            "windows_status": "ok",
        }
    loc = (await client.get(LOCATION_URL)).raise_for_status().json()
    return {
        "latitude": loc["latitude"],
        "longitude": loc["longitude"],
        "city": loc.get("city") or loc.get("region") or "Unknown",
        "source": "ip",
        "accuracy_m": None,
        "windows_status": win.get("status", "unavailable"),
    }


def open_location_settings() -> None:
    subprocess.Popen(["cmd", "/c", "start", "", LOCATION_SETTINGS], creationflags=subprocess.CREATE_NO_WINDOW)


async def _fetch() -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=15) as client:
        loc = await _locate(client)
        params = {
            "latitude": loc["latitude"],
            "longitude": loc["longitude"],
            "current": "temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code,is_day",
            "daily": "temperature_2m_max,temperature_2m_min",
            "forecast_days": 1,
            "timezone": "auto",
        }
        data = (await client.get(FORECAST_URL, params=params)).raise_for_status().json()
    now = data["current"]
    code = int(now["weather_code"])
    return {
        "city": loc["city"],
        "source": loc["source"],
        "accuracy_m": loc["accuracy_m"],
        "windows_status": loc["windows_status"],
        "temp": now["temperature_2m"],
        "feels_like": now["apparent_temperature"],
        "humidity": now["relative_humidity_2m"],
        "wind_kmh": now["wind_speed_10m"],
        "code": code,
        "condition": CONDITIONS.get(code, "Unknown"),
        "is_day": bool(now["is_day"]),
        "high": data["daily"]["temperature_2m_max"][0],
        "low": data["daily"]["temperature_2m_min"][0],
    }


async def refresh() -> dict[str, Any] | None:
    """Fetch now, for after the user changes the location setting."""
    global _latest
    try:
        _latest = await _fetch()
    except (httpx.HTTPError, KeyError, ValueError, TypeError):
        log.warning("weather update failed", exc_info=True)
    return _latest


async def watch() -> None:
    global _latest
    while True:
        try:
            _latest = await _fetch()
            await asyncio.sleep(REFRESH_S)
        except (httpx.HTTPError, KeyError, ValueError, TypeError):
            # Offline or a service hiccup: keep the last reading and try again soon.
            log.warning("weather update failed", exc_info=True)
            await asyncio.sleep(RETRY_S)
