import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env")

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
MODEL = os.getenv("JARVIS_MODEL", "gpt-6-luna")
USER_NAME = os.getenv("JARVIS_USER_NAME", "sir")

# Voice runs on OpenAI GPT-Live; the backend model does the work it delegates.
VOICE_MODEL = os.getenv("JARVIS_VOICE_MODEL", "gpt-live-1")
VOICE_NAME = os.getenv("JARVIS_VOICE", "marin")
VOICE_BACKEND_MODEL = os.getenv("JARVIS_VOICE_BACKEND_MODEL", "gpt-6-luna")

# Browser origins allowed to open the WebSocket. Anything else is rejected so a
# random web page can't talk to the core running on this machine.
ALLOWED_ORIGINS = {
    o.strip()
    for o in os.getenv(
        "JARVIS_ALLOWED_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173",
    ).split(",")
    if o.strip()
}
