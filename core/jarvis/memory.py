"""What Jarvis remembers between restarts, kept in %APPDATA%/Jarvis/memory.db.

Messages are one conversation shared by typed chat and voice, so either can
pick up where the other left off. Facts are things the user asked Jarvis to
remember; they go into every prompt until the user has them forgotten.
"""

import sqlite3
import threading
import time
from typing import Any, Literal

from .keystore import DATA_DIR

DB_FILE = DATA_DIR / "memory.db"

Role = Literal["user", "assistant"]

# How much of the conversation goes back to the model with each typed message.
HISTORY_MESSAGES = 40
# A voice session gets a shorter recap in its instructions, each line cut to this length.
VOICE_RECAP_MESSAGES = 16
VOICE_RECAP_CHARS = 300
MESSAGE_MAX_CHARS = 20_000
FACT_MAX_CHARS = 500
MAX_FACTS = 200

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None
# Bumped whenever the facts change or the conversation is cleared, so the UI knows to refresh.
facts_version = 0
cleared_version = 0


def _db() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        _conn = sqlite3.connect(DB_FILE, check_same_thread=False)
        _conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY,
                role TEXT NOT NULL,
                text TEXT NOT NULL,
                source TEXT NOT NULL,
                created_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS facts (
                id INTEGER PRIMARY KEY,
                text TEXT NOT NULL,
                created_at REAL NOT NULL
            );
            """
        )
    return _conn


def add_message(role: Role, text: str, source: Literal["chat", "voice"]) -> int:
    with _lock:
        db = _db()
        cur = db.execute(
            "INSERT INTO messages (role, text, source, created_at) VALUES (?, ?, ?, ?)",
            (role, text[:MESSAGE_MAX_CHARS], source, time.time()),
        )
        db.commit()
        return cur.lastrowid or 0


def delete_message(message_id: int) -> None:
    with _lock:
        db = _db()
        db.execute("DELETE FROM messages WHERE id = ?", (message_id,))
        db.commit()


def recent_messages(limit: int = HISTORY_MESSAGES) -> list[dict[str, str]]:
    """The last messages, oldest first, as {"role", "content"} for the model."""
    with _lock:
        rows = _db().execute("SELECT role, text FROM messages ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [{"role": role, "content": text} for role, text in reversed(rows)]


def clear_messages() -> None:
    global cleared_version
    with _lock:
        db = _db()
        db.execute("DELETE FROM messages")
        db.commit()
        cleared_version += 1


def facts() -> list[dict[str, Any]]:
    with _lock:
        rows = _db().execute("SELECT id, text FROM facts ORDER BY id").fetchall()
    return [{"id": i, "text": t} for i, t in rows]


def add_fact(text: str) -> tuple[int, bool]:
    """Save a fact. Returns its id and whether it is new (an identical one is not saved twice)."""
    global facts_version
    text = " ".join(text.split())[:FACT_MAX_CHARS]
    with _lock:
        db = _db()
        row = db.execute("SELECT id FROM facts WHERE lower(text) = lower(?)", (text,)).fetchone()
        if row:
            return row[0], False
        (count,) = db.execute("SELECT count(*) FROM facts").fetchone()
        if count >= MAX_FACTS:
            raise ValueError(f"Memory is full ({MAX_FACTS} facts). Ask the user to forget some first.")
        cur = db.execute("INSERT INTO facts (text, created_at) VALUES (?, ?)", (text, time.time()))
        db.commit()
        facts_version += 1
        return cur.lastrowid or 0, True


def forget_fact(fact_id: int) -> str | None:
    """Delete a fact and return its text, or None if there was no such fact."""
    global facts_version
    with _lock:
        db = _db()
        row = db.execute("SELECT text FROM facts WHERE id = ?", (fact_id,)).fetchone()
        if row is None:
            return None
        db.execute("DELETE FROM facts WHERE id = ?", (fact_id,))
        db.commit()
        facts_version += 1
        return row[0]


def facts_prompt() -> str:
    """The facts section added to the instructions, or "" when nothing is saved."""
    saved = facts()
    if not saved:
        return ""
    lines = "\n".join(f"- [{f['id']}] {f['text']}" for f in saved)
    return (
        "\n\nThings the user asked you to remember (the number in brackets is the id for forget_memory). "
        f"Use them naturally; do not recite them unprompted:\n{lines}"
    )


def voice_recap() -> str:
    """The end of the saved conversation, written out for a new voice session's instructions."""
    recent = recent_messages(VOICE_RECAP_MESSAGES)
    if not recent:
        return ""
    lines = []
    for m in recent:
        text = " ".join(m["content"].split())
        if len(text) > VOICE_RECAP_CHARS:
            text = text[:VOICE_RECAP_CHARS] + "…"
        lines.append(f"{'User' if m['role'] == 'user' else 'Jarvis'}: {text}")
    return "\n\nThe conversation so far, typed or spoken, possibly from an earlier session:\n" + "\n".join(lines)
