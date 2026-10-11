"""Actions Jarvis can take on this computer.

Everything here is safe to run without asking: it opens things or reads status,
and never changes or deletes anything. Riskier tools need a confirmation step
before they are added.
"""

import json
import os
import webbrowser
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable
from urllib.parse import quote_plus, urlparse

import psutil

# Friendly name -> what Windows should launch. A fixed list, so the model can
# never start an arbitrary program.
APPS = {
    "notepad": "notepad.exe",
    "calculator": "calc.exe",
    "file_explorer": "explorer.exe",
    "task_manager": "taskmgr.exe",
    "paint": "mspaint.exe",
    "settings": "ms-settings:",
    "chrome": "chrome",
    "edge": "msedge",
    "vscode": "vscode:",
    "spotify": "spotify:",
}


@dataclass
class ToolResult:
    label: str  # short line shown in the transcript
    output: str  # what the model reads back


def _no_args() -> dict[str, Any]:
    return {"type": "object", "properties": {}, "required": [], "additionalProperties": False}


def _one_string(name: str, description: str, enum: list[str] | None = None) -> dict[str, Any]:
    prop: dict[str, Any] = {"type": "string", "description": description}
    if enum:
        prop["enum"] = enum
    return {"type": "object", "properties": {name: prop}, "required": [name], "additionalProperties": False}


def _function(name: str, description: str, parameters: dict[str, Any]) -> dict[str, Any]:
    return {"type": "function", "name": name, "description": description, "parameters": parameters, "strict": True}


DEFINITIONS = [
    _function(
        "open_app",
        "Open an application on the user's computer. Use when the user asks to open, launch or start one of the listed apps.",
        _one_string("app", "Which application to open.", sorted(APPS)),
    ),
    _function(
        "open_website",
        "Open a web page in the user's default browser. Use when the user asks to go to or open a specific site.",
        _one_string("url", "Full address starting with https:// or http://."),
    ),
    _function(
        "search_in_browser",
        "Open a Google search results page in the user's browser so they can see the results themselves. "
        "Use when the user asks to search or google something on their computer. "
        "To answer a question yourself, use web search instead.",
        _one_string("query", "What to search for."),
    ),
    _function(
        "get_system_status",
        "Read the computer's current CPU load, memory use and battery level.",
        _no_args(),
    ),
    _function(
        "get_datetime",
        "Read the current local date and time on the user's computer.",
        _no_args(),
    ),
]


def _open_app(app: str) -> ToolResult:
    target = APPS.get(app)
    if target is None:
        return ToolResult(f"Unknown app: {app}", f"Error: '{app}' is not an app I can open. Available: {', '.join(sorted(APPS))}.")
    try:
        os.startfile(target)
    except OSError as e:
        return ToolResult(f"Could not open {app}", f"Error: could not open {app} ({e}). It may not be installed.")
    return ToolResult(f"Opened {app.replace('_', ' ')}", f"Opened {app}.")


def _open_website(url: str) -> ToolResult:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return ToolResult("Blocked a non-web address", "Error: only http:// and https:// addresses can be opened.")
    webbrowser.open(url)
    return ToolResult(f"Opened {parsed.netloc}", f"Opened {url} in the browser.")


def _search_in_browser(query: str) -> ToolResult:
    webbrowser.open(f"https://www.google.com/search?q={quote_plus(query)}")
    return ToolResult(f"Searched Google for “{query}”", f"Opened Google results for '{query}' in the browser.")


def _get_system_status() -> ToolResult:
    mem = psutil.virtual_memory()
    battery = psutil.sensors_battery()
    status = {
        "cpu_percent": psutil.cpu_percent(interval=0.3),
        "memory_percent": mem.percent,
        "memory_used_gb": round(mem.used / 1024**3, 1),
        "memory_total_gb": round(mem.total / 1024**3, 1),
        "battery_percent": None if battery is None else round(battery.percent),
        "charging": None if battery is None else battery.power_plugged,
    }
    return ToolResult("Checked system status", json.dumps(status))


def _get_datetime() -> ToolResult:
    return ToolResult("Checked the time", datetime.now().astimezone().strftime("%A, %d %B %Y, %H:%M %Z"))


_HANDLERS: dict[str, Callable[..., ToolResult]] = {
    "open_app": _open_app,
    "open_website": _open_website,
    "search_in_browser": _search_in_browser,
    "get_system_status": _get_system_status,
    "get_datetime": _get_datetime,
}
_STRING_ARG = {"open_app": "app", "open_website": "url", "search_in_browser": "query"}


def run(name: str, arguments: str) -> ToolResult:
    """Run one tool call. `arguments` is the JSON string the model produced; bad input comes back as an error result."""
    handler = _HANDLERS.get(name)
    if handler is None:
        return ToolResult(f"Unknown tool: {name}", f"Error: there is no tool named '{name}'.")
    try:
        args = json.loads(arguments or "{}")
    except ValueError:
        return ToolResult(f"Bad input for {name}", "Error: the tool arguments were not valid JSON.")

    arg_name = _STRING_ARG.get(name)
    if arg_name is None:
        return handler()
    value = args.get(arg_name) if isinstance(args, dict) else None
    if not isinstance(value, str) or not value.strip():
        return ToolResult(f"Bad input for {name}", f"Error: '{arg_name}' must be a non-empty string.")
    return handler(value.strip())
