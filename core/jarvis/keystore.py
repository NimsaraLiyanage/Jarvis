"""Keeps the user's OpenAI key on disk, encrypted with Windows DPAPI.

DPAPI ties the encryption to the Windows account, so the file is useless if
copied to another user or machine. This is the same protection Electron's
safeStorage uses on Windows.
"""

import ctypes
import os
from ctypes import wintypes
from pathlib import Path

DATA_DIR = Path(os.getenv("APPDATA", Path.home())) / "Onyx"
KEY_FILE = DATA_DIR / "openai_key.bin"


class _Blob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _blob(data: bytes) -> _Blob:
    buf = ctypes.create_string_buffer(data, len(data))
    return _Blob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))


def _take(blob: _Blob) -> bytes:
    try:
        return ctypes.string_at(blob.pbData, blob.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(blob.pbData)


def _protect(data: bytes) -> bytes:
    out = _Blob()
    if not ctypes.windll.crypt32.CryptProtectData(ctypes.byref(_blob(data)), None, None, None, None, 0, ctypes.byref(out)):
        raise OSError("Windows could not encrypt the key.")
    return _take(out)


def _unprotect(data: bytes) -> bytes:
    out = _Blob()
    if not ctypes.windll.crypt32.CryptUnprotectData(ctypes.byref(_blob(data)), None, None, None, None, 0, ctypes.byref(out)):
        raise OSError("Windows could not decrypt the key.")
    return _take(out)


def load() -> str:
    """The saved key, or "" if there is none or it can't be read."""
    try:
        return _unprotect(KEY_FILE.read_bytes()).decode("utf-8")
    except (OSError, UnicodeDecodeError):
        return ""


def save(key: str) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    KEY_FILE.write_bytes(_protect(key.encode("utf-8")))


def clear() -> None:
    KEY_FILE.unlink(missing_ok=True)
