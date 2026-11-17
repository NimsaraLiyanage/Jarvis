import asyncio
import logging
import time
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

import openai
import psutil
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from . import approvals, config, devices, keystore, memory, tools, usage, voice, wake, weather
from .brain import BrainError, OpenAIBrain

log = logging.getLogger("jarvis")

@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    # Background watchers for the HUD; the stats ticker only reads their latest result.
    watchers = [asyncio.create_task(devices.watch()), asyncio.create_task(weather.watch())]
    wake.start(on_wake)
    yield
    wake.stop()
    for task in watchers:
        task.cancel()


# Every connected UI, so a wake reaches whichever one is open.
sessions: set["Session"] = set()


async def on_wake(source: wake.Source) -> None:
    if not sessions:
        wake.open_ui()
        return
    for session in list(sessions):
        try:
            await session.send({"type": "wake", "source": source})
        except Exception:
            sessions.discard(session)


app = FastAPI(title="Onyx Core", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=sorted(config.ALLOWED_ORIGINS),
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type"],
)
brain = OpenAIBrain()

STATS_INTERVAL_S = 2.0


@app.get("/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "model": config.MODEL}


class VoiceOffer(BaseModel):
    sdp: str


class ToolCall(BaseModel):
    name: str
    arguments: str = "{}"


class KeyBody(BaseModel):
    key: str


class VoiceUsage(BaseModel):
    seconds: float


def require_own_ui(request: Request) -> None:
    # These endpoints spend money or act on the computer, so only our own UI may call them.
    if request.headers.get("origin") not in config.ALLOWED_ORIGINS:
        raise HTTPException(status_code=403, detail="Origin not allowed.")


@app.post("/api/voice/session")
async def voice_session(offer: VoiceOffer, request: Request) -> dict[str, str]:
    require_own_ui(request)
    try:
        return {"sdp": await voice.create_session(offer.sdp)}
    except voice.VoiceError as e:
        raise HTTPException(status_code=e.status, detail=str(e)) from e


@app.post("/api/tools/run")
async def run_tool(call: ToolCall, request: Request) -> dict[str, str]:
    """Runs a tool the voice backend asked for; the UI relays the call and the result."""
    require_own_ui(request)
    result = await tools.execute(call.name, call.arguments, approvals.request)
    return {"label": result.label, "output": result.output}


def key_status() -> dict[str, Any]:
    key = config.OPENAI_API_KEY
    return {
        "key_set": bool(key),
        "key_hint": f"...{key[-4:]}" if key else None,
        "key_from_env": config.KEY_FROM_ENV,
    }


@app.get("/api/key")
async def get_key_status(request: Request) -> dict[str, Any]:
    require_own_ui(request)
    return key_status()


@app.post("/api/key")
async def set_key(body: KeyBody, request: Request) -> dict[str, Any]:
    """Check the key with OpenAI, then save it encrypted for this Windows account."""
    require_own_ui(request)
    key = body.key.strip()
    if not key.startswith("sk-") or len(key) < 20:
        raise HTTPException(status_code=400, detail="That doesn't look like an OpenAI key. It starts with sk-.")
    try:
        await openai.AsyncOpenAI(api_key=key).models.list()
    except openai.AuthenticationError as e:
        raise HTTPException(status_code=400, detail="OpenAI rejected this key. Copy it again and check nothing is missing.") from e
    except openai.APIConnectionError as e:
        raise HTTPException(status_code=502, detail="Could not reach OpenAI to check the key. Check the internet connection.") from e
    except openai.APIStatusError as e:
        raise HTTPException(status_code=502, detail=f"OpenAI could not check the key ({e.status_code}): {e.message}") from e
    try:
        keystore.save(key)
    except OSError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    config.OPENAI_API_KEY = key
    config.KEY_FROM_ENV = False
    brain.reset_client()
    return key_status()


@app.delete("/api/key")
async def remove_key(request: Request) -> dict[str, Any]:
    require_own_ui(request)
    keystore.clear()
    if not config.KEY_FROM_ENV:
        config.OPENAI_API_KEY = ""
        brain.reset_client()
    return key_status()


@app.post("/api/location/settings")
async def location_settings(request: Request) -> dict[str, bool]:
    """Opens the Windows privacy page where the user can allow location."""
    require_own_ui(request)
    weather.open_location_settings()
    return {"ok": True}


@app.post("/api/location/refresh")
async def location_refresh(request: Request) -> dict[str, Any]:
    require_own_ui(request)
    return await weather.refresh()


@app.post("/api/usage/voice")
async def add_voice_usage(body: VoiceUsage, request: Request) -> dict[str, Any]:
    """The UI reports how long a voice session stayed open, since only it sees the end."""
    require_own_ui(request)
    usage.record_voice(config.VOICE_MODEL, body.seconds)
    return usage.summary()


_last_net: tuple[float, int, int] | None = None


def network_rates() -> tuple[float, float]:
    """Bytes per second sent and received since the previous call."""
    global _last_net
    io = psutil.net_io_counters()
    now = time.monotonic()
    prev, _last_net = _last_net, (now, io.bytes_sent, io.bytes_recv)
    if prev is None or now <= prev[0]:
        return 0.0, 0.0
    span = now - prev[0]
    return (io.bytes_sent - prev[1]) / span, (io.bytes_recv - prev[2]) / span


def system_stats() -> dict[str, Any]:
    mem = psutil.virtual_memory()
    up, down = network_rates()
    disk = psutil.disk_usage(str(config.ROOT.anchor))
    battery = psutil.sensors_battery()
    return {
        "type": "system",
        "cpu": psutil.cpu_percent(interval=None),
        "ram": mem.percent,
        "ram_used_gb": round(mem.used / 1024**3, 1),
        "ram_total_gb": round(mem.total / 1024**3, 1),
        "battery": None if battery is None else round(battery.percent),
        "charging": None if battery is None else battery.power_plugged,
        "net_up": round(up),
        "net_down": round(down),
        "disk": disk.percent,
        "uptime_s": round(time.time() - psutil.boot_time()),
        "usage": usage.summary(),
        "devices": devices.latest(),
        "weather": weather.latest(),
        "voice_ready": bool(config.OPENAI_API_KEY),
        "wake": wake.status(),
        **key_status(),
    }


def history_event() -> dict[str, Any]:
    return {
        "type": "history",
        "messages": [{"role": m["role"], "text": m["content"]} for m in memory.recent_messages(memory.HISTORY_MESSAGES)],
    }


def memory_event() -> dict[str, Any]:
    return {"type": "memory", "facts": memory.facts()}


class Session:
    """One connected UI. Serialises sends so the stats ticker and a reply can't interleave.

    The conversation itself lives in memory.db, shared with every other window and with voice.
    """

    def __init__(self, sock: WebSocket) -> None:
        self.sock = sock
        self._send_lock = asyncio.Lock()
        self._facts_version = memory.facts_version
        self._cleared_version = memory.cleared_version

    async def send(self, payload: dict[str, Any]) -> None:
        async with self._send_lock:
            await self.sock.send_json(payload)

    def mark_cleared(self) -> None:
        self._cleared_version = memory.cleared_version

    async def push_stats(self) -> None:
        while True:
            await self.send(system_stats())
            # Facts saved by a tool, or a Clear pressed in another window, reach this window here.
            if self._facts_version != memory.facts_version:
                self._facts_version = memory.facts_version
                await self.send(memory_event())
            if self._cleared_version != memory.cleared_version:
                self._cleared_version = memory.cleared_version
                await self.send(history_event())
            await asyncio.sleep(STATS_INTERVAL_S)

    async def handle_user_message(self, text: str) -> None:
        message_id = memory.add_message("user", text, "chat")
        history = memory.recent_messages()
        await self.send({"type": "state", "value": "thinking"})
        speaking = False
        try:
            async for kind, value in brain.stream_reply(history):
                if kind == "tool":
                    # Back to "thinking" while the model reads the tool result.
                    speaking = False
                    await self.send({"type": "tool", "label": value})
                    await self.send({"type": "state", "value": "thinking"})
                    continue
                if not speaking:
                    speaking = True
                    await self.send({"type": "state", "value": "speaking"})
                await self.send({"type": "delta", "text": value})
            reply = history[-1]["content"] if history[-1]["role"] == "assistant" else ""
            if reply:
                memory.add_message("assistant", reply, "chat")
        except BrainError as e:
            # Drop the unanswered user turn so the next request starts clean.
            memory.delete_message(message_id)
            await self.send({"type": "error", "message": str(e)})
        except Exception:
            log.exception("unexpected failure while replying")
            memory.delete_message(message_id)
            await self.send({"type": "error", "message": "Something went wrong inside the core. Check its log."})
        await self.send({"type": "done"})
        await self.send({"type": "state", "value": "idle"})


@app.websocket("/ws")
async def ws(sock: WebSocket) -> None:
    if sock.headers.get("origin") not in config.ALLOWED_ORIGINS:
        await sock.close(code=1008)
        return
    await sock.accept()
    session = Session(sock)
    await session.send({"type": "hello", "model": config.MODEL, "voice_ready": bool(config.OPENAI_API_KEY)})
    await session.send(history_event())
    await session.send(memory_event())
    approvals.register(session)
    sessions.add(session)
    stats_task = asyncio.create_task(session.push_stats())
    # A reply runs as its own task so this loop stays free to receive the
    # user's Allow/Deny answer while a tool is waiting on it.
    reply_task: asyncio.Task[None] | None = None
    try:
        while True:
            msg = await sock.receive_json()
            kind = msg.get("type")
            busy = reply_task is not None and not reply_task.done()
            if kind == "user_message":
                text = str(msg.get("text", "")).strip()
                if text and not busy:
                    reply_task = asyncio.create_task(session.handle_user_message(text))
            elif kind == "confirm_response":
                approvals.resolve(str(msg.get("id", "")), msg.get("allow") is True)
            elif kind == "voice_turn":
                # A finished spoken turn, so typed chat and later voice sessions know it was said.
                role = {"user": "user", "jarvis": "assistant"}.get(msg.get("role"))
                text = str(msg.get("text", "")).strip()
                if role and text:
                    memory.add_message(role, text, "voice")
            elif kind == "forget":
                fact_id = msg.get("id")
                if isinstance(fact_id, int):
                    memory.forget_fact(fact_id)
            elif kind == "reset" and not busy:
                memory.clear_messages()
                # This window already cleared itself; only the others need telling.
                session.mark_cleared()
    except WebSocketDisconnect:
        pass
    finally:
        approvals.unregister(session)
        sessions.discard(session)
        stats_task.cancel()
        if reply_task is not None:
            reply_task.cancel()


if config.SERVE_UI:
    # Mounted last so the API routes above win; serves the built UI for the desktop app.
    from fastapi.staticfiles import StaticFiles

    app.mount("/", StaticFiles(directory=config.ROOT / "dist", html=True, check_dir=False), name="ui")
