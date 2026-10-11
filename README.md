# Jarvis

A personal assistant with a HUD-style interface. Runs as a desktop app (Electron) or in the browser, backed by a local Python core that talks to the OpenAI API.

## Setup

Needs Node 22+ and Python 3.11+.

```
npm install
npm run setup
copy .env.example .env
```

Put your OpenAI API key in `.env`; the one key runs typed chat and voice. Never put a real key in `.env.example` — that file is committed.

## Run

| Command | What it starts |
|---|---|
| `npm run desktop` | Core + UI in an Electron window |
| `npm run web` | Core + UI at http://localhost:5173 |
| `npm run build` | Type-check and build the UI into `dist/` |

## Layout

- `core/jarvis/` — Python core (FastAPI). `main.py` serves the WebSocket at `ws://127.0.0.1:8765/ws`, `brain.py` streams typed replies, `voice.py` opens voice sessions, `config.py` reads `.env`.
- `ui/src/` — React UI. `useJarvis.ts` owns the connection, `Orb.tsx` is the Three.js orb, `ChatPanel.tsx` and `SystemPanel.tsx` are the side panels.
- `desktop/` — Electron shell that loads the UI.

## Settings (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | — | Required, for typed chat and voice |
| `JARVIS_MODEL` | `gpt-6-luna` | Model used for typed replies |
| `JARVIS_USER_NAME` | `sir` | How Jarvis addresses you |
| `JARVIS_VOICE` | `marin` | GPT-Live voice |
| `JARVIS_VOICE_BACKEND_MODEL` | `gpt-6-luna` | Model that handles work the voice model delegates |

## Voice

Press the microphone button to start a spoken conversation, and again to end it. Voice runs on OpenAI GPT-Live over WebRTC: the browser sends its offer to the core (`core/jarvis/voice.py`), which opens the session with your key, so the key never reaches the UI. GPT-Live holds the conversation and hands questions needing web search or deeper reasoning to the backend model.

GPT-Live is billed per second while a session is open, so end the session when you are done. Voice and typed chat use different models and do not share conversation history yet.

## Tools

Jarvis can search the web, open a fixed list of apps, open websites, open a Google search in the browser, and read the system status and time. The tools live in `core/jarvis/tools.py` and work from both typed chat and voice. They only open things or read status; nothing that changes or deletes anything runs without a confirmation step, which is not built yet.

## Roadmap

1. ~~Foundation, streaming chat, HUD~~
2. Voice: ~~spoken conversation~~, wake word
3. Tools: ~~web search, open apps and sites, system status~~, files and system controls with confirmation for risky actions
4. Memory: conversation history and facts about you
5. Integrations: calendar, mail, reminders, morning brief
6. Polish: tray, global hotkey, installer
