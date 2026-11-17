# Improvements

Planned work for Jarvis. Everything runs in the shared core, so each item works in both the desktop app and the web UI.

## 1. Memory (most important) — done

- [x] Keep chat history after a restart (SQLite, `%APPDATA%/Jarvis/memory.db`).
- [x] Remember facts about the user — name, likes, projects ("remember this…"). Forget them on request or from the Memory list.
- [x] Typed chat and voice share one conversation: voice turns are saved, typed chat sees them, and a new voice session starts with the saved facts and recent conversation.

## 2. Voice improvements

- [ ] Wake word ("Hey Jarvis"): start talking without pressing a key (openWakeWord or Porcupine).
- [ ] Global hotkey: open Jarvis even when another app is in front.

## 3. Files

- [ ] Search for files ("find last week's PDF").
- [ ] Read and summarise PDF, Word and Excel files.
- [ ] Move, rename or zip files, with the Allow/Deny prompt.

## 4. Browser control

- [ ] Run Chrome directly through Playwright, which is more accurate than clicking on screenshots: fill in forms, read tabs, download files.

## 5. Daily integrations

- [ ] Gmail: read, summarise and draft replies (with the prompt before sending).
- [ ] Google Calendar: today's meetings, adding events.
- [ ] Reminders and timers ("remind me in 10 minutes").
- [ ] Morning brief that reads out the weather, calendar, emails and news together.

## 6. System control

- [ ] Volume, brightness, Wi-Fi, media play/pause, lock, sleep.
- [ ] Clipboard: "summarise what I copied".
- [ ] Run PowerShell commands, with a prompt every time.

## 7. Polish

- [ ] System tray icon, start with Windows, an installer (electron-builder).
