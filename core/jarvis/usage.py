"""Counts what the user's key has spent, so the UI can show a running cost.

Totals are kept per calendar month in %APPDATA%/Jarvis/usage.json. Costs are
estimates from the price table below, not OpenAI's bill: web searches and the
tokens the voice backend uses are not counted.
"""

import json
import threading
from datetime import date
from typing import Any

from .keystore import DATA_DIR

USAGE_FILE = DATA_DIR / "usage.json"

# US dollars per million tokens: (input, cached input, output). Check
# openai.com/api/pricing and update these when prices change.
TOKEN_PRICES: dict[str, tuple[float, float, float]] = {
    "gpt-6-luna": (0.10, 0.01, 0.50),
}
# US dollars per minute of a voice session, billed per second.
VOICE_PRICE_PER_MIN: dict[str, float] = {
    "gpt-live-1": 0.05,
}

_lock = threading.Lock()


def _month() -> str:
    return date.today().strftime("%Y-%m")


def _read() -> dict[str, Any]:
    try:
        return json.loads(USAGE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _bucket(data: dict[str, Any]) -> dict[str, Any]:
    return data.setdefault(_month(), {"input_tokens": 0, "output_tokens": 0, "voice_seconds": 0.0, "cost": 0.0, "unpriced": []})


def _write(data: dict[str, Any]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    USAGE_FILE.write_text(json.dumps(data, indent=1), encoding="utf-8")


def _note_unpriced(bucket: dict[str, Any], model: str) -> None:
    if model not in bucket["unpriced"]:
        bucket["unpriced"].append(model)


def record_tokens(model: str, usage: Any) -> None:
    """Add one response's usage (an OpenAI Responses `usage` object, or None)."""
    if usage is None:
        return
    inp = getattr(usage, "input_tokens", 0) or 0
    out = getattr(usage, "output_tokens", 0) or 0
    details = getattr(usage, "input_tokens_details", None)
    cached = getattr(details, "cached_tokens", 0) or 0
    with _lock:
        data = _read()
        bucket = _bucket(data)
        bucket["input_tokens"] += inp
        bucket["output_tokens"] += out
        price = TOKEN_PRICES.get(model)
        if price:
            bucket["cost"] += ((inp - cached) * price[0] + cached * price[1] + out * price[2]) / 1_000_000
        else:
            _note_unpriced(bucket, model)
        _write(data)


def record_voice(model: str, seconds: float) -> None:
    seconds = max(0.0, min(seconds, 6 * 3600))
    with _lock:
        data = _read()
        bucket = _bucket(data)
        bucket["voice_seconds"] += seconds
        price = VOICE_PRICE_PER_MIN.get(model)
        if price:
            bucket["cost"] += seconds / 60 * price
        else:
            _note_unpriced(bucket, model)
        _write(data)


def summary() -> dict[str, Any]:
    with _lock:
        bucket = _read().get(_month())
    bucket = bucket or {"input_tokens": 0, "output_tokens": 0, "voice_seconds": 0.0, "cost": 0.0, "unpriced": []}
    return {"month": _month(), **bucket}
