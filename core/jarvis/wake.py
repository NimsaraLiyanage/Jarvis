"""Wakes Onyx without touching the window: the "Hey Onyx" wake word and a global hotkey.

Both run in the core on their own threads, so they work whichever UI is open
(desktop or web) and while that UI is hidden. A trigger is handed to the event
loop, which tells every connected UI to start listening. When no UI is
connected, the web UI is opened in the browser instead.

The wake word runs on openWakeWord, entirely on this computer, with no account
or key: no audio leaves it until a voice session starts. openWakeWord ships a
"Hey Jarvis" model but none for "Hey Onyx", so "Hey Jarvis" is used until a
custom hey-onyx.onnx (trained with openWakeWord's free Colab notebook) is put
next to the other data.
"""

import asyncio
import ctypes
import logging
import os
import threading
import webbrowser
from ctypes import wintypes
from pathlib import Path
from typing import Any, Callable, Literal

from . import config
from .keystore import DATA_DIR

log = logging.getLogger("jarvis")

Source = Literal["wake_word", "hotkey"]

CUSTOM_MODEL = Path(os.getenv("JARVIS_WAKE_WORD_FILE", "").strip() or DATA_DIR / "hey-onyx.onnx")
# The model bundled with openWakeWord, used until a "Hey Onyx" one is added.
FALLBACK_MODEL = "hey_jarvis"
# Score (0 to 1) that counts as hearing the phrase. Lower catches quieter or
# accented speech but wakes by mistake more often.
THRESHOLD = float(os.getenv("JARVIS_WAKE_THRESHOLD", "0.5"))
# 80 ms of 16 kHz audio, the chunk size openWakeWord works best with.
FRAME_SAMPLES = 1280
# A second trigger this soon after the first is the same "Hey Onyx" echoing or repeated.
COOLDOWN_S = 3.0

MOD_ALT = 0x0001
MOD_CONTROL = 0x0002
MOD_NOREPEAT = 0x4000
WM_HOTKEY = 0x0312
WM_QUIT = 0x0012
HOTKEY_ID = 1
HOTKEY_LABEL = "Ctrl+Alt+O"
HOTKEY_KEY = ord("O")

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

_status: dict[str, Any] = {"wake_word": "off", "wake_word_detail": "", "wake_phrase": "Hey Onyx", "hotkey": HOTKEY_LABEL}
_stop = threading.Event()
_hotkey_thread_id = 0


def status() -> dict[str, Any]:
    return dict(_status)


def _set_wake_status(state: str, detail: str = "") -> None:
    _status["wake_word"] = state
    _status["wake_word_detail"] = detail


def _load_model() -> Any:
    """The wake word model: the user's "Hey Onyx" if present, otherwise the bundled "Hey Jarvis"."""
    import openwakeword
    from openwakeword.model import Model
    from openwakeword.utils import download_models

    if CUSTOM_MODEL.is_file():
        path = str(CUSTOM_MODEL)
        _status["wake_phrase"] = "Hey Onyx"
    else:
        path = openwakeword.MODELS[FALLBACK_MODEL]["model_path"].replace(".tflite", ".onnx")
        _status["wake_phrase"] = "Hey Jarvis"
    # The shared feature models and the bundled one come down once, a few MB in all.
    if not Path(path).is_file() or not Path(path).with_name("melspectrogram.onnx").is_file():
        download_models(model_names=[] if CUSTOM_MODEL.is_file() else [FALLBACK_MODEL])
    return Model(wakeword_models=[path], inference_framework="onnx")


def _listen_for_wake_word(fire: Callable[[Source], None]) -> None:
    try:
        import numpy as np
        from pvrecorder import PvRecorder

        model = _load_model()
    except ImportError:
        _set_wake_status("error", "Wake word packages are missing. Run npm run setup again.")
        return
    except Exception as e:
        log.warning("wake word could not start: %s", e)
        _set_wake_status("error", f"The wake word model could not load (the first start needs the internet): {e}")
        return

    phrase = _status["wake_phrase"]
    recorder = None
    try:
        recorder = PvRecorder(frame_length=FRAME_SAMPLES)
        recorder.start()
        detail = f"Listening for “{phrase}” on {recorder.selected_device}."
        if phrase != "Hey Onyx":
            detail += f" For “Hey Onyx”, add a trained hey-onyx.onnx at {CUSTOM_MODEL}."
        _set_wake_status("on", detail)
        while not _stop.is_set():
            scores = model.predict(np.array(recorder.read(), dtype=np.int16))
            if max(scores.values()) >= THRESHOLD:
                # Clear the audio it remembers so the same phrase doesn't fire again.
                model.reset()
                fire("wake_word")
    except Exception as e:
        log.warning("wake word stopped: %s", e)
        _set_wake_status("error", f"The microphone stopped: {e}")
    finally:
        if recorder is not None:
            recorder.delete()


def _listen_for_hotkey(fire: Callable[[Source], None]) -> None:
    global _hotkey_thread_id
    _hotkey_thread_id = kernel32.GetCurrentThreadId()
    # The hotkey belongs to this thread, so its messages arrive in this loop.
    if not user32.RegisterHotKey(None, HOTKEY_ID, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, HOTKEY_KEY):
        log.warning("%s is taken by another app; the global hotkey is off", HOTKEY_LABEL)
        _status["hotkey"] = None
        return
    try:
        msg = wintypes.MSG()
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            if msg.message == WM_HOTKEY and msg.wParam == HOTKEY_ID:
                fire("hotkey")
    finally:
        user32.UnregisterHotKey(None, HOTKEY_ID)


def start(on_wake: Callable[[Source], Any]) -> None:
    """Start both listeners. on_wake is a coroutine function, run on the current event loop."""
    loop = asyncio.get_running_loop()
    last = {"wake_word": 0.0, "hotkey": 0.0}

    def fire(source: Source) -> None:
        now = loop.time()
        if now - last[source] < COOLDOWN_S:
            return
        last[source] = now
        loop.call_soon_threadsafe(lambda: loop.create_task(on_wake(source)))

    _stop.clear()
    threading.Thread(target=_listen_for_wake_word, args=(fire,), name="wake-word", daemon=True).start()
    threading.Thread(target=_listen_for_hotkey, args=(fire,), name="hotkey", daemon=True).start()


def stop() -> None:
    _stop.set()
    if _hotkey_thread_id:
        user32.PostThreadMessageW(_hotkey_thread_id, WM_QUIT, 0, 0)


def open_ui() -> None:
    """Nothing is connected to hear the wake: open the web UI, which starts listening when it loads."""
    webbrowser.open(f"{config.UI_URL}#wake")
