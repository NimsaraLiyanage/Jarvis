"""Windows-specific helpers: typing into Notepad, clicking in a window and locating user folders."""

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

INPUT_MOUSE = 0
INPUT_KEYBOARD = 1
MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_WHEEL = 0x0800
WHEEL_DELTA = 120
MOUSEEVENTF_ABSOLUTE = 0x8000
# Absolute mouse positions run from 0 to this across the primary monitor, whatever its resolution or scaling.
MOUSE_ABSOLUTE_MAX = 65535
SM_CXSCREEN = 0
SM_CYSCREEN = 1
GA_ROOT = 2
GA_ROOTOWNER = 3
# Window class of a classic right-click menu.
MENU_CLASS = "#32768"
# A drag is sent as this many small moves, since apps ignore a pointer that jumps straight to the end.
DRAG_STEPS = 20
DRAG_STEP_DELAY_S = 0.02
SCROLL_DELAY_S = 0.02
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
user32.WindowFromPoint.argtypes = (wintypes.POINT,)
user32.WindowFromPoint.restype = wintypes.HWND
user32.GetAncestor.argtypes = (wintypes.HWND, wintypes.UINT)
user32.GetAncestor.restype = wintypes.HWND
user32.GetWindowRect.argtypes = (wintypes.HWND, ctypes.POINTER(wintypes.RECT))
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
    """Typing or clicking could not start or was stopped; the message is safe to show."""


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
    raise TypingError("the window could not be brought to the front")


def bring_to_front(window: Window) -> None:
    """Make the window the active one, restoring it if it is minimised."""
    _bring_to_front(window.hwnd)


def _send(*events: INPUT) -> None:
    array = (INPUT * len(events))(*events)
    user32.SendInput(len(events), array, ctypes.sizeof(INPUT))


def _mouse(flags: int, x: float, y: float, data: int = 0) -> INPUT:
    """A mouse event at a point given as fractions (0-1) of the primary monitor's width and height."""
    return INPUT(
        type=INPUT_MOUSE,
        mi=MOUSEINPUT(
            dx=round(x * MOUSE_ABSOLUTE_MAX),
            dy=round(y * MOUSE_ABSOLUTE_MAX),
            mouseData=data & 0xFFFFFFFF,
            dwFlags=flags | MOUSEEVENTF_ABSOLUTE,
        ),
    )


def _require_inside(window: Window, x: float, y: float) -> None:
    """Stop with TypingError unless the point is on the window or one of its own popups and menus."""
    point = wintypes.POINT(
        round(x * (user32.GetSystemMetrics(SM_CXSCREEN) - 1)),
        round(y * (user32.GetSystemMetrics(SM_CYSCREEN) - 1)),
    )
    hit = user32.WindowFromPoint(point)
    if user32.GetAncestor(hit, GA_ROOTOWNER) == window.hwnd:
        return
    # A classic right-click menu has no owner, so it is matched by the program it belongs to.
    class_name = ctypes.create_unicode_buffer(64)
    user32.GetClassNameW(user32.GetAncestor(hit, GA_ROOT), class_name, len(class_name))
    hit_pid, window_pid = wintypes.DWORD(), wintypes.DWORD()
    user32.GetWindowThreadProcessId(hit, ctypes.byref(hit_pid))
    user32.GetWindowThreadProcessId(window.hwnd, ctypes.byref(window_pid))
    if class_name.value == MENU_CLASS and hit_pid.value == window_pid.value:
        return
    raise TypingError("that spot is not inside the window, so nothing was done there")


def click_in_window(window: Window, x: float, y: float, right: bool = False) -> None:
    """Click once at a point on the primary monitor, given as fractions (0-1) of its width and height.

    Stops with TypingError unless that point is on the given window or one of its
    own popups, so a click never lands in a different app.
    """
    _require_inside(window, x, y)
    down, up = (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP) if right else (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP)
    _send(_mouse(MOUSEEVENTF_MOVE, x, y), _mouse(down, x, y), _mouse(up, x, y))


def drag_in_window(window: Window, start: tuple[float, float], end: tuple[float, float]) -> None:
    """Hold the left button at one point of the window and release it at another."""
    _require_inside(window, *start)
    _require_inside(window, *end)
    _send(_mouse(MOUSEEVENTF_MOVE, *start), _mouse(MOUSEEVENTF_LEFTDOWN, *start))
    try:
        time.sleep(0.15)
        for step in range(1, DRAG_STEPS + 1):
            t = step / DRAG_STEPS
            _send(_mouse(MOUSEEVENTF_MOVE, start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t))
            time.sleep(DRAG_STEP_DELAY_S)
        time.sleep(0.15)
    finally:
        # Always let go, or the button stays held down for the user.
        _send(_mouse(MOUSEEVENTF_LEFTUP, *end))


def scroll_window(window: Window, notches: int) -> None:
    """Turn the mouse wheel over the middle of the window; positive notches scroll down."""
    rect = wintypes.RECT()
    user32.GetWindowRect(window.hwnd, ctypes.byref(rect))
    x = (rect.left + rect.right) / 2 / (user32.GetSystemMetrics(SM_CXSCREEN) - 1)
    y = (rect.top + rect.bottom) / 2 / (user32.GetSystemMetrics(SM_CYSCREEN) - 1)
    if not (0 <= x <= 1 and 0 <= y <= 1):
        raise TypingError("the middle of the window is not on the main screen")
    _require_inside(window, x, y)
    _send(_mouse(MOUSEEVENTF_MOVE, x, y))
    delta = -WHEEL_DELTA if notches > 0 else WHEEL_DELTA
    for _ in range(abs(notches)):
        _send(_mouse(MOUSEEVENTF_WHEEL, x, y, delta))
        time.sleep(SCROLL_DELAY_S)


def _type(hwnd: int, text: str, name: str) -> None:
    """Send the text as keystrokes, stopping as soon as the window is no longer the active one."""
    for i, char in enumerate(text.replace("\r\n", "\n")):
        if i % FOCUS_CHECK_EVERY == 0 and user32.GetForegroundWindow() != hwnd:
            raise TypingError(f"{name} lost focus, so typing stopped after {i} of {len(text)} characters")
        _press(char)
        time.sleep(KEY_DELAY_S)


def type_in_window(window: Window, text: str) -> None:
    """Type text into whatever has the keyboard focus in the window, which must be the active one."""
    _type(window.hwnd, text, "The window")


def type_in_notepad(text: str) -> bool:
    """Type text into the front-most Notepad window, opening one if needed.

    Returns True if a new window was opened. Stops with TypingError as soon as
    Notepad is no longer the active window, so keystrokes never land elsewhere.
    """
    existing = _notepad_windows()
    hwnd = existing[0] if existing else _open_notepad()
    _bring_to_front(hwnd)
    time.sleep(0.15)
    _type(hwnd, text, "Notepad")
    return not existing
