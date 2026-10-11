"""Windows-specific helpers: typing into Notepad and locating user folders."""

import ctypes
import subprocess
import time
from ctypes import wintypes
from dataclasses import dataclass
from pathlib import Path

import psutil

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
dwmapi = ctypes.WinDLL("dwmapi")

INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
VK_RETURN = 0x0D
VK_TAB = 0x09
SW_RESTORE = 9
WM_GETTEXT = 0x000D
WM_GETTEXTLENGTH = 0x000E
WM_CLOSE = 0x0010
GW_OWNER = 4
GWL_EXSTYLE = -20
WS_EX_TOOLWINDOW = 0x00000080
DWMWA_CLOAKED = 14
# Desktop and taskbar: never app windows, and never something to close.
SHELL_WINDOW_CLASSES = {"Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"}
CLOSE_WAIT_S = 2.0

NOTEPAD_CLASS = "Notepad"
LAUNCH_TIMEOUT_S = 6
# Focus is re-checked this often so typing stops if the user switches windows.
FOCUS_CHECK_EVERY = 25
KEY_DELAY_S = 0.004

ULONG_PTR = ctypes.c_size_t


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", wintypes.LONG),
        ("dy", wintypes.LONG),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class _INPUTUNION(ctypes.Union):
    # MOUSEINPUT is the largest member; it has to be here for INPUT to be the right size.
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", wintypes.DWORD), ("u", _INPUTUNION)]


user32.SendInput.argtypes = (wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int)
user32.SendInput.restype = wintypes.UINT
user32.GetForegroundWindow.restype = wintypes.HWND
user32.GetWindowThreadProcessId.argtypes = (wintypes.HWND, ctypes.POINTER(wintypes.DWORD))
user32.GetWindowThreadProcessId.restype = wintypes.DWORD
user32.GetWindowLongW.argtypes = (wintypes.HWND, ctypes.c_int)
dwmapi.DwmGetWindowAttribute.argtypes = (wintypes.HWND, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD)
user32.GetWindow.argtypes = (wintypes.HWND, wintypes.UINT)
user32.GetWindow.restype = wintypes.HWND
user32.PostMessageW.argtypes = (wintypes.HWND, wintypes.UINT, ctypes.c_size_t, ctypes.c_ssize_t)
user32.FindWindowExW.argtypes =(wintypes.HWND, wintypes.HWND, wintypes.LPCWSTR, wintypes.LPCWSTR)
user32.FindWindowExW.restype = wintypes.HWND
user32.SendMessageW.argtypes = (wintypes.HWND, wintypes.UINT, ctypes.c_size_t, ctypes.c_void_p)
user32.SendMessageW.restype = ctypes.c_ssize_t
EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


class _GUID(ctypes.Structure):
    _fields_ = [("data", ctypes.c_byte * 16)]


def known_folder(folder_id: str) -> Path:
    """Resolve a Windows known folder (Desktop, Documents) to its real path, even when OneDrive has moved it."""
    guid = _GUID()
    ctypes.windll.ole32.CLSIDFromString(folder_id, ctypes.byref(guid))
    path = ctypes.c_wchar_p()
    result = ctypes.windll.shell32.SHGetKnownFolderPath(ctypes.byref(guid), 0, None, ctypes.byref(path))
    if result != 0 or not path.value:
        raise OSError(f"Windows could not locate the folder (error {result & 0xFFFFFFFF:#x})")
    try:
        return Path(path.value)
    finally:
        ctypes.windll.ole32.CoTaskMemFree(path)


class TypingError(Exception):
    """Typing could not start or was stopped; the message is safe to show."""


def _key(vk: int = 0, scan: int = 0, flags: int = 0) -> INPUT:
    return INPUT(type=INPUT_KEYBOARD, ki=KEYBDINPUT(wVk=vk, wScan=scan, dwFlags=flags))


def _press(char: str) -> None:
    if char == "\n":
        events = [_key(vk=VK_RETURN), _key(vk=VK_RETURN, flags=KEYEVENTF_KEYUP)]
    elif char == "\t":
        events = [_key(vk=VK_TAB), _key(vk=VK_TAB, flags=KEYEVENTF_KEYUP)]
    else:
        # One down/up pair per UTF-16 unit, so characters outside the BMP work too.
        units = char.encode("utf-16-le")
        events = []
        for i in range(0, len(units), 2):
            unit = int.from_bytes(units[i : i + 2], "little")
            events.append(_key(scan=unit, flags=KEYEVENTF_UNICODE))
            events.append(_key(scan=unit, flags=KEYEVENTF_UNICODE | KEYEVENTF_KEYUP))
    array = (INPUT * len(events))(*events)
    user32.SendInput(len(events), array, ctypes.sizeof(INPUT))


def _notepad_windows() -> list[int]:
    """Visible Notepad windows, front-most first."""
    found: list[int] = []
    name = ctypes.create_unicode_buffer(64)

    def visit(hwnd: int, _lparam: int) -> bool:
        if user32.IsWindowVisible(hwnd):
            user32.GetClassNameW(hwnd, name, len(name))
            if name.value == NOTEPAD_CLASS:
                found.append(hwnd)
        return True

    user32.EnumWindows(EnumWindowsProc(visit), 0)
    return found


@dataclass(frozen=True)
class Window:
    hwnd: int
    title: str
    process: str  # executable name without ".exe", lower case


def open_windows() -> list[Window]:
    """The app windows a user would see on the taskbar, front-most first."""
    found: list[Window] = []
    title = ctypes.create_unicode_buffer(512)
    class_name = ctypes.create_unicode_buffer(128)
    cloaked = wintypes.DWORD()
    pid = wintypes.DWORD()

    def visit(hwnd: int, _lparam: int) -> bool:
        if not user32.IsWindowVisible(hwnd) or user32.GetWindow(hwnd, GW_OWNER):
            return True
        if user32.GetWindowLongW(hwnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW:
            return True
        # Store apps keep hidden "cloaked" windows around; those are not really open.
        dwmapi.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, ctypes.byref(cloaked), ctypes.sizeof(cloaked))
        user32.GetWindowTextW(hwnd, title, len(title))
        user32.GetClassNameW(hwnd, class_name, len(class_name))
        if cloaked.value or not title.value or class_name.value in SHELL_WINDOW_CLASSES:
            return True
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        try:
            process = psutil.Process(pid.value).name().lower().removesuffix(".exe")
        except psutil.Error:
            return True
        # explorer.exe also owns the desktop and taskbar; only its folder windows count.
        if process == "explorer" and class_name.value != "CabinetWClass":
            return True
        found.append(Window(hwnd, title.value, process))
        return True

    user32.EnumWindows(EnumWindowsProc(visit), 0)
    return found


def close_windows(windows: list[Window]) -> list[Window]:
    """Ask each window to close, the same as clicking its X. Returns the ones still open afterwards.

    Nothing is force-closed: an app with unsaved work shows its usual save prompt and stays open.
    """
    for window in windows:
        user32.PostMessageW(window.hwnd, WM_CLOSE, 0, 0)
    deadline = time.monotonic() + CLOSE_WAIT_S
    remaining = windows
    while time.monotonic() < deadline:
        time.sleep(0.2)
        remaining = [w for w in windows if user32.IsWindow(w.hwnd) and user32.IsWindowVisible(w.hwnd)]
        if not remaining:
            break
    return remaining


def read_notepad_windows(max_chars: int) -> list[tuple[str, str]]:
    """(window title, text) for every open Notepad window, front-most first."""
    windows = []
    for hwnd in _notepad_windows():
        title = ctypes.create_unicode_buffer(256)
        user32.GetWindowTextW(hwnd, title, len(title))
        edit = user32.FindWindowExW(hwnd, None, "Edit", None)
        text = ""
        if edit:
            length = min(user32.SendMessageW(edit, WM_GETTEXTLENGTH, 0, None), max_chars)
            buffer = ctypes.create_unicode_buffer(length + 1)
            user32.SendMessageW(edit, WM_GETTEXT, length + 1, ctypes.cast(buffer, ctypes.c_void_p))
            text = buffer.value
        windows.append((title.value, text))
    return windows


def _open_notepad() -> int:
    before = set(_notepad_windows())
    subprocess.Popen(["notepad.exe"])
    deadline = time.monotonic() + LAUNCH_TIMEOUT_S
    while time.monotonic() < deadline:
        time.sleep(0.15)
        new = [h for h in _notepad_windows() if h not in before]
        if new:
            return new[0]
    raise TypingError("Notepad did not open in time")


def _bring_to_front(hwnd: int) -> None:
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, SW_RESTORE)
    # Windows only lets the foreground thread hand over focus, so borrow its input queue.
    foreground_thread = user32.GetWindowThreadProcessId(user32.GetForegroundWindow(), None)
    this_thread = kernel32.GetCurrentThreadId()
    attached = foreground_thread and foreground_thread != this_thread
    if attached:
        user32.AttachThreadInput(this_thread, foreground_thread, True)
    try:
        user32.BringWindowToTop(hwnd)
        user32.SetForegroundWindow(hwnd)
    finally:
        if attached:
            user32.AttachThreadInput(this_thread, foreground_thread, False)

    deadline = time.monotonic() + 1.5
    while time.monotonic() < deadline:
        if user32.GetForegroundWindow() == hwnd:
            return
        time.sleep(0.05)
    raise TypingError("Notepad could not be brought to the front")


def type_in_notepad(text: str) -> bool:
    """Type text into the front-most Notepad window, opening one if needed.

    Returns True if a new window was opened. Stops with TypingError as soon as
    Notepad is no longer the active window, so keystrokes never land elsewhere.
    """
    existing = _notepad_windows()
    hwnd = existing[0] if existing else _open_notepad()
    _bring_to_front(hwnd)
    time.sleep(0.15)

    for i, char in enumerate(text.replace("\r\n", "\n")):
        if i % FOCUS_CHECK_EVERY == 0 and user32.GetForegroundWindow() != hwnd:
            raise TypingError(f"Notepad lost focus, so typing stopped after {i} of {len(text)} characters")
        _press(char)
        time.sleep(KEY_DELAY_S)
    return not existing
