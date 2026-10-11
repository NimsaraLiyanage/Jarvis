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

Hold Space to talk and release it to close the mic (click outside the chat box first, since Space types there). The first press opens the session; it closes by itself after 90 seconds with nothing happening. The microphone button starts a hands-free session with the mic always open, and ends whichever session is running. Voice runs on OpenAI GPT-Live over WebRTC: the browser sends its offer to the core (`core/jarvis/voice.py`), which opens the session with your key, so the key never reaches the UI. GPT-Live holds the conversation and hands questions needing web search or deeper reasoning to the backend model.

GPT-Live is billed per second while a session is open, so end the session when you are done. Voice and typed chat use different models and do not share conversation history yet.

## Orb appearance

The Orb button in the top bar changes the orb's shape (Sphere, Ring, Galaxy, Face, Face 3D, Robot) and colour theme. Face 3D (`ui/src/Face3D.tsx`) renders a real head model and drives its jaw, lips, blinks, brows and gaze. It loads `ui/public/models/avatar.glb` if you add one, otherwise the bundled `head.glb` (the three.js sample head). Any GLB with ARKit-style face shapes such as `jawOpen` and `eyeBlinkLeft` should work. Face is a drawn hologram portrait (`ui/src/Face.tsx`) whose mouth follows the speech level, and which blinks and shifts its gaze with Jarvis's state. The whole interface takes its accent colour from the theme, and the choice is remembered in the browser. Shapes and themes are defined in `ui/src/orbStyle.ts` and `ui/src/Orb.tsx`.

The Robot shape uses the same component to redraw the bundled head as a face built from mesh nodes: glowing dots joined by the wireframe, with solid glowing eyes. It talks, blinks and looks around the same way, in the theme colour.

Credits: `head.glb` is the sample head from the three.js examples (`facecap.glb`, model by [Face Cap](https://www.bannaflak.com/face-cap)); no licence is stated for it there. The files in `ui/public/basis/` are the Basis Universal texture transcoder shipped with three.js.

## Tools

Jarvis can search the web, open a fixed list of apps, open websites, open a Google search in the browser, read the text of a public web page, and read the system status and time. The tools live in `core/jarvis/tools.py` and work from both typed chat and voice. Most only open things or read status and run straight away.

Tools that change something ask first: an Allow/Deny card appears above the chat box showing exactly what will happen, and no answer within 60 seconds counts as deny. Four tools work this way:

- Closing an app's windows, the same as clicking their X. The prompt lists the exact windows. Nothing is force-closed, so an app with unsaved work shows its own save prompt, and the window showing Jarvis is never closed.
- Typing into Notepad, which stops the moment Notepad loses focus.
- Saving text as a new `.txt` file, only on the Desktop or in Documents, never overwriting an existing file.
- Looking at the screen: a screenshot of the primary monitor is sent to OpenAI to answer one question. It asks every time because everything visible is sent.

Reading the text in open Notepad windows needs no prompt.

## Roadmap

1. ~~Foundation, streaming chat, HUD~~
2. Voice: ~~spoken conversation~~, wake word
3. Tools: ~~web search, open apps and sites, read pages, system status, confirmation prompt, typing in Notepad~~, browser control, files
4. Memory: conversation history and facts about you
5. Integrations: calendar, mail, reminders, morning brief
6. Polish: tray, global hotkey, installer
