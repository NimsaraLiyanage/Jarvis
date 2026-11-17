import { useCallback, useEffect, useRef, useState } from "react";

const CORE_WS = import.meta.env.VITE_CORE_WS ?? "ws://127.0.0.1:8765/ws";
const RECONNECT_MS = 1500;

export type OrbState = "idle" | "listening" | "thinking" | "speaking";
export type LinkStatus = "connecting" | "online" | "offline";

export interface ChatMessage {
  id: number;
  // "tool" is a one-line note about an action Jarvis just took.
  role: "user" | "jarvis" | "error" | "tool";
  text: string;
}

// An action Jarvis wants to take that needs the user's Allow or Deny.
export interface ConfirmRequest {
  id: string;
  title: string;
  detail: string;
}

export interface SystemStats {
  cpu: number;
  ram: number;
  ram_used_gb: number;
  ram_total_gb: number;
  battery: number | null;
  charging: boolean | null;
  net_up: number; // bytes per second
  net_down: number;
  disk: number;
  uptime_s: number;
}

export interface Device {
  kind: "bluetooth" | "usb";
  id: string;
  name: string;
}

export interface Weather {
  city: string;
  // "windows" is Windows Location (Wi-Fi based, precise); "ip" is the rough fallback.
  source: "windows" | "ip";
  accuracy_m: number | null;
  windows_status: string;
  temp: number;
  feels_like: number;
  humidity: number;
  wind_kmh: number;
  code: number;
  condition: string;
  is_day: boolean;
  high: number;
  low: number;
}

// This month's spend on the user's own key; cost is an estimate from the core's price table.
export interface Usage {
  month: string;
  input_tokens: number;
  output_tokens: number;
  voice_seconds: number;
  cost: number;
  unpriced: string[];
}

export interface KeyStatus {
  key_set: boolean;
  key_hint: string | null;
  key_from_env: boolean;
}

type ServerEvent =
  | { type: "hello"; model: string; voice_ready: boolean }
  | { type: "state"; value: OrbState }
  | { type: "delta"; text: string }
  | { type: "tool"; label: string }
  | ({ type: "confirm_request" } & ConfirmRequest)
  | { type: "confirm_closed"; id: string }
  | { type: "done" }
  | { type: "error"; message: string }
  | ({ type: "system"; usage: Usage; voice_ready: boolean; devices: Device[]; weather: Weather | null } & SystemStats & KeyStatus);

export function useJarvis() {
  const [link, setLink] = useState<LinkStatus>("connecting");
  const [coreState, setCoreState] = useState<OrbState>("idle");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [voiceReady, setVoiceReady] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [weather, setWeather] = useState<Weather | null>(null);
  const [keyStatus, setKeyStatus] = useState<KeyStatus | null>(null);

  const sockRef = useRef<WebSocket | null>(null);
  const nextId = useRef(1);
  // Id of the reply currently being streamed, if any.
  const streamingId = useRef<number | null>(null);
  // The spoken turn still receiving transcript fragments, if any.
  const voiceTurn = useRef<{ role: "user" | "jarvis"; id: number } | null>(null);
  // Bumped on every token; the orb reads and decays it each frame.
  const energy = useRef(0);

  useEffect(() => {
    let closed = false;
    let timer: number | undefined;

    const connect = () => {
      const sock = new WebSocket(CORE_WS);
      sockRef.current = sock;

      sock.onopen = () => setLink("online");

      sock.onmessage = (e) => {
        const ev = JSON.parse(e.data) as ServerEvent;
        switch (ev.type) {
          case "hello":
            setModel(ev.model);
            setVoiceReady(ev.voice_ready);
            break;
          case "state":
            setCoreState(ev.value);
            break;
          case "system":
            setStats(ev);
            setUsage(ev.usage);
            setDevices(ev.devices);
            setWeather(ev.weather);
            setVoiceReady(ev.voice_ready);
            setKeyStatus((k) =>
              k?.key_set === ev.key_set && k.key_hint === ev.key_hint && k.key_from_env === ev.key_from_env
                ? k
                : { key_set: ev.key_set, key_hint: ev.key_hint, key_from_env: ev.key_from_env },
            );
            break;
          case "delta": {
            energy.current = Math.min(1, energy.current + 0.35);
            if (streamingId.current === null) {
              const id = nextId.current++;
              streamingId.current = id;
              setMessages((m) => [...m, { id, role: "jarvis", text: ev.text }]);
            } else {
              const id = streamingId.current;
              setMessages((m) => m.map((msg) => (msg.id === id ? { ...msg, text: msg.text + ev.text } : msg)));
            }
            break;
          }
          case "tool": {
            // Text after the action starts a fresh bubble below the note.
            streamingId.current = null;
            const id = nextId.current++;
            setMessages((m) => [...m, { id, role: "tool", text: ev.label }]);
            break;
          }
          case "error": {
            const id = nextId.current++;
            setMessages((m) => [...m, { id, role: "error", text: ev.message }]);
            break;
          }
          case "confirm_request":
            setConfirm({ id: ev.id, title: ev.title, detail: ev.detail });
            break;
          case "confirm_closed":
            setConfirm((c) => (c?.id === ev.id ? null : c));
            break;
          case "done":
            streamingId.current = null;
            break;
        }
      };

      sock.onclose = () => {
        if (closed) return;
        streamingId.current = null;
        setConfirm(null);
        setLink("offline");
        setCoreState("idle");
        timer = window.setTimeout(connect, RECONNECT_MS);
      };
    };

    connect();
    return () => {
      closed = true;
      window.clearTimeout(timer);
      sockRef.current?.close();
    };
  }, []);

  const send = useCallback((text: string) => {
    const sock = sockRef.current;
    if (!sock || sock.readyState !== WebSocket.OPEN) return;
    const id = nextId.current++;
    voiceTurn.current = null;
    setMessages((m) => [...m, { id, role: "user", text }]);
    sock.send(JSON.stringify({ type: "user_message", text }));
  }, []);

  // Spoken transcripts arrive as fragments with no end-of-turn marker, so a turn
  // lasts until the other side starts talking.
  const appendTranscript = useCallback((role: "user" | "jarvis", delta: string) => {
    const turn = voiceTurn.current;
    if (turn?.role === role) {
      setMessages((m) => m.map((msg) => (msg.id === turn.id ? { ...msg, text: msg.text + delta } : msg)));
      return;
    }
    const id = nextId.current++;
    voiceTurn.current = { role, id };
    setMessages((m) => [...m, { id, role, text: delta }]);
  }, []);

  const pushNote = useCallback((role: "error" | "tool", text: string) => {
    const id = nextId.current++;
    voiceTurn.current = null;
    setMessages((m) => [...m, { id, role, text }]);
  }, []);

  const answerConfirm = useCallback((id: string, allow: boolean) => {
    const sock = sockRef.current;
    if (sock?.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: "confirm_response", id, allow }));
    setConfirm((c) => (c?.id === id ? null : c));
  }, []);

  const reset = useCallback(() => {
    voiceTurn.current = null;
    setMessages([]);
    const sock = sockRef.current;
    if (sock?.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: "reset" }));
  }, []);

  return {
    link,
    coreState,
    messages,
    stats,
    model,
    voiceReady,
    usage,
    devices,
    weather,
    keyStatus,
    setKeyStatus,
    confirm,
    answerConfirm,
    energy,
    send,
    reset,
    appendTranscript,
    pushNote,
    isStreaming: coreState === "thinking" || coreState === "speaking",
  };
}
