import asyncio
import logging
from typing import Any

import openai
import psutil
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from . import approvals, config, keystore, tools, usage, voice
from .brain import BrainError, OpenAIBrain

log = logging.getLogger("jarvis")

app = FastAPI(title="Jarvis Core")
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


@app.post("/api/usage/voice")
async def add_voice_usage(body: VoiceUsage, request: Request) -> dict[str, Any]:
    """The UI reports how long a voice session stayed open, since only it sees the end."""
    require_own_ui(request)
    usage.record_voice(config.VOICE_MODEL, body.seconds)
    return usage.summary()


def system_stats() -> dict[str, Any]:
    mem = psutil.virtual_memory()
    battery = psutil.sensors_battery()
    return {
        "type": "system",
        "cpu": psutil.cpu_percent(interval=None),
        "ram": mem.percent,
        "ram_used_gb": round(mem.used / 1024**3, 1),
        "ram_total_gb": round(mem.total / 1024**3, 1),
        "battery": None if battery is None else round(battery.percent),
        "charging": None if battery is None else battery.power_plugged,
        "usage": usage.summary(),
        "voice_ready": bool(config.OPENAI_API_KEY),
        **key_status(),
    }


class Session:
    """One connected UI. Serialises sends so the stats ticker and a reply can't interleave."""

    def __init__(self, sock: WebSocket) -> None:
        self.sock = sock
        self.history: list[dict[str, Any]] = []
        self._send_lock = asyncio.Lock()

    async def send(self, payload: dict[str, Any]) -> None:
        async with self._send_lock:
            await self.sock.send_json(payload)

    async def push_stats(self) -> None:
        while True:
            await self.send(system_stats())
            await asyncio.sleep(STATS_INTERVAL_S)

    async def handle_user_message(self, text: str) -> None:
        self.history.append({"role": "user", "content": text})
        await self.send({"type": "state", "value": "thinking"})
        speaking = False
        try:
            async for kind, value in brain.stream_reply(self.history):
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
        except BrainError as e:
            # Drop the unanswered user turn so the next request starts clean.
            self.history.pop()
            await self.send({"type": "error", "message": str(e)})
        except Exception:
            log.exception("unexpected failure while replying")
            self.history.pop()
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
    approvals.register(session)
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
            elif kind == "reset" and not busy:
                session.history.clear()
    except WebSocketDisconnect:
        pass
    finally:
        approvals.unregister(session)
        stats_task.cancel()
        if reply_task is not None:
            reply_task.cancel()
