from typing import Any

import httpx2 as httpx

from . import config, tools

LIVE_SESSIONS_URL = "https://api.openai.com/v1/live/sessions"

# The live model only handles the spoken conversation, so this stays short:
# persona, how to behave while waiting, and when to hand work to the backend.
INSTRUCTIONS = f"""You are JARVIS, a personal AI assistant speaking with the user through their computer. Address them as "{config.USER_NAME}".

Speak calmly and briefly, with a dry, understated wit. Give the answer first. One or two sentences is usually enough. If the user interrupts, stop and listen.

Backend tools:
- Web search: current information such as news, weather, prices, sports and recent events.
- Computer: open apps and websites on the user's computer, open a Google search in their browser, read the system status and the time.
- Reasoning: questions that need careful thought, calculation, planning or detailed knowledge.

Delegate to the backend when:
- The user asks you to open, launch, go to or search for something on their computer.
- The answer depends on current or changing information, including the time or the computer's status.
- The question needs several steps of reasoning, exact figures or a detailed explanation.
- The user corrects or changes a request the backend is already working on.

Do not delegate to the backend when:
- The user is greeting you, making small talk or asking you to repeat something.
- You can answer correctly in a sentence from general knowledge.

While the backend works, say briefly that you are checking, then wait for its result. Never guess an answer the backend is still producing.

You cannot yet read or change files, control other programs, or remember earlier sessions. If asked for that, say so plainly."""

BACKEND_INSTRUCTIONS = """You are the backend for a voice assistant running on the user's own computer. Your output is read aloud by another model, so reply with only the facts it needs: plain sentences, no markdown, no lists, no links. Lead with the answer. Keep it under about eighty words unless the question truly needs more.

When the user asks to open an app or website, or to search for something on their computer, call the matching tool, then say in one sentence what was done. Use web search when you need current information to answer a question yourself."""


class VoiceError(Exception):
    """A failure to start a voice session, with the HTTP status to report."""

    def __init__(self, message: str, status: int = 502) -> None:
        super().__init__(message)
        self.status = status


def session_config() -> dict[str, Any]:
    return {
        "model": config.VOICE_MODEL,
        "instructions": INSTRUCTIONS,
        "audio": {"output": {"voice": config.VOICE_NAME}},
        "delegation": {
            "type": "responses",
            "responses": {
                "model": config.VOICE_BACKEND_MODEL,
                "instructions": BACKEND_INSTRUCTIONS,
                "tools": [{"type": "web_search"}, *tools.DEFINITIONS],
                "tool_choice": "auto",
            },
        },
    }


async def create_session(offer_sdp: str) -> str:
    """Open a GPT-Live WebRTC session for the browser's SDP offer and return the SDP answer."""
    if not config.OPENAI_API_KEY:
        raise VoiceError("Voice needs an OpenAI key. Add OPENAI_API_KEY to .env and restart the core.", 503)

    body = {"session": session_config(), "transport": {"type": "webrtc", "sdp": offer_sdp}}
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                LIVE_SESSIONS_URL,
                headers={"Authorization": f"Bearer {config.OPENAI_API_KEY}"},
                json=body,
            )
    except httpx.HTTPError as e:
        raise VoiceError("Could not reach OpenAI. Check the internet connection.") from e

    if resp.status_code >= 400:
        detail = resp.text
        try:
            detail = resp.json()["error"]["message"]
        except (ValueError, KeyError, TypeError):
            pass
        raise VoiceError(f"OpenAI rejected the voice session ({resp.status_code}): {detail}")

    try:
        return resp.json()["transport"]["sdp"]
    except (ValueError, KeyError, TypeError) as e:
        raise VoiceError("OpenAI returned a voice session without an SDP answer.") from e
