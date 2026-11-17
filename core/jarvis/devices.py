"""Keeps a list of connected Bluetooth and external USB devices for the HUD radar.

A scan takes a few seconds of PowerShell, so it runs in the background and the
stats ticker only reads the last result.
"""

import asyncio
import json
import logging
import subprocess
from pathlib import Path
from typing import Any

log = logging.getLogger("jarvis")

SCRIPT = Path(__file__).with_name("scripts") / "devices.ps1"
SCAN_INTERVAL_S = 10.0
SCAN_TIMEOUT_S = 30.0

_latest: list[dict[str, Any]] = []


def latest() -> list[dict[str, Any]]:
    return _latest


def _scan() -> list[dict[str, Any]]:
    result = subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(SCRIPT)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=SCAN_TIMEOUT_S,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    found = json.loads(result.stdout or "[]")
    return [
        {"kind": d.get("kind"), "id": str(d.get("id", "")), "name": str(d.get("name") or "Unknown device")}
        for d in found
        if isinstance(d, dict)
    ]


async def watch() -> None:
    global _latest
    while True:
        try:
            _latest = await asyncio.to_thread(_scan)
        except (OSError, ValueError, subprocess.SubprocessError):
            log.warning("device scan failed", exc_info=True)
        await asyncio.sleep(SCAN_INTERVAL_S)
