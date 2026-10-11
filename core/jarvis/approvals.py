"""Asks the user to allow or deny an action before a tool changes anything."""

import asyncio
import uuid
from typing import Any, Protocol

TIMEOUT_S = 60


class Sender(Protocol):
    async def send(self, payload: dict[str, Any]) -> None: ...


_sessions: set[Sender] = set()
_pending: dict[str, asyncio.Future[bool]] = {}


def register(session: Sender) -> None:
    _sessions.add(session)


def unregister(session: Sender) -> None:
    _sessions.discard(session)


async def _broadcast(payload: dict[str, Any]) -> None:
    for session in list(_sessions):
        try:
            await session.send(payload)
        except Exception:
            # A window that just closed; the others can still answer.
            _sessions.discard(session)


async def request(title: str, detail: str) -> bool:
    """Show an Allow/Deny prompt in every open UI. No answer in time counts as deny."""
    if not _sessions:
        return False
    request_id = uuid.uuid4().hex
    future: asyncio.Future[bool] = asyncio.get_running_loop().create_future()
    _pending[request_id] = future
    await _broadcast({"type": "confirm_request", "id": request_id, "title": title, "detail": detail})
    try:
        return await asyncio.wait_for(future, TIMEOUT_S)
    except asyncio.TimeoutError:
        return False
    finally:
        del _pending[request_id]
        await _broadcast({"type": "confirm_closed", "id": request_id})


def resolve(request_id: str, allow: bool) -> None:
    future = _pending.get(request_id)
    if future is not None and not future.done():
        future.set_result(allow)
