import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { OrbState } from "./useJarvis";

const CORE_HTTP = import.meta.env.VITE_CORE_HTTP ?? "http://127.0.0.1:8765";

const ICE_TIMEOUT_MS = 3000;
const CLOSE_TIMEOUT_MS = 1500;
// Backend work that never reports completion stops showing as "thinking" after this.
const DELEGATION_TIMEOUT_MS = 60_000;
// Jarvis counts as speaking above this output level, and for a short hold after.
const SPEAKING_LEVEL = 0.015;
const SPEAKING_HOLD_MS = 350;
// The mic stays open this long after Space is released so the last word isn't clipped.
const TALK_RELEASE_TAIL_MS = 250;
// A push-to-talk session is billed while open, so close it once nothing has happened for this long.
const IDLE_CLOSE_MS = 90_000;

export type VoiceStatus = "off" | "connecting" | "live";
// "handsfree" keeps the mic open; "ptt" opens it only while the talk key is held.
type VoiceMode = "handsfree" | "ptt";

interface Options {
  onTranscript: (role: "user" | "jarvis", delta: string) => void;
  onNote: (role: "error" | "tool", text: string) => void;
  // Shared with the orb: written every frame from the live audio level.
  energy: RefObject<number>;
}

interface Live {
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  mic: MediaStream;
  audio: HTMLAudioElement;
  ctx: AudioContext;
  frame: number;
  delegationTimer: number | undefined;
}

function waitForIce(pc: RTCPeerConnection) {
  return new Promise<void>((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    const done = () => {
      pc.removeEventListener("icegatheringstatechange", check);
      window.clearTimeout(timer);
      resolve();
    };
    const check = () => pc.iceGatheringState === "complete" && done();
    const timer = window.setTimeout(done, ICE_TIMEOUT_MS);
    pc.addEventListener("icegatheringstatechange", check);
  });
}

function rms(analyser: AnalyserNode, buf: Float32Array<ArrayBuffer>) {
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (const v of buf) sum += v * v;
  return Math.sqrt(sum / buf.length);
}

interface FunctionCall {
  call_id: string;
  name: string;
  arguments: string;
}

// The core runs the tool; a failure is reported to the model as the tool's output.
async function runTool(call: FunctionCall): Promise<{ label: string; output: string }> {
  try {
    const resp = await fetch(`${CORE_HTTP}/api/tools/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: call.name, arguments: call.arguments }),
    });
    if (!resp.ok) throw new Error(`core returned ${resp.status}`);
    return await resp.json();
  } catch (err) {
    const reason = err instanceof Error ? err.message : "unknown error";
    return { label: `${call.name} failed`, output: `Error: the tool could not be run (${reason}).` };
  }
}

export function useVoice({ onTranscript, onNote, energy }: Options) {
  const [status, setStatus] = useState<VoiceStatus>("off");
  const [activity, setActivity] = useState<OrbState>("idle");
  const [micOpen, setMicOpen] = useState(false);

  const live = useRef<Live | null>(null);
  // Guards against a second start while the first is still connecting.
  const starting = useRef(false);
  const delegating = useRef(false);
  const handsFree = useRef(false);
  const talkHeld = useRef(false);
  const releaseTimer = useRef<number | undefined>(undefined);
  const callbacks = useRef({ onTranscript, onNote });
  callbacks.current = { onTranscript, onNote };

  // Muting is done on the track itself, so a closed mic sends silence, not room audio.
  const applyMic = useCallback(() => {
    const open = handsFree.current || talkHeld.current;
    live.current?.mic.getTracks().forEach((t) => (t.enabled = open));
    setMicOpen(open && live.current !== null);
  }, []);

  const teardown = useCallback(() => {
    const s = live.current;
    live.current = null;
    starting.current = false;
    delegating.current = false;
    handsFree.current = false;
    talkHeld.current = false;
    window.clearTimeout(releaseTimer.current);
    setMicOpen(false);
    if (s) {
      cancelAnimationFrame(s.frame);
      window.clearTimeout(s.delegationTimer);
      s.mic.getTracks().forEach((t) => t.stop());
      s.dc.close();
      s.pc.close();
      s.audio.srcObject = null;
      void s.ctx.close();
    }
    setStatus("off");
  }, []);

  const closeSession = useCallback(
    (s: Live) => {
      if (s.dc.readyState === "open") {
        // Ask for a clean close, but don't wait forever for the acknowledgement.
        s.dc.send(JSON.stringify({ type: "session.close" }));
        window.setTimeout(() => live.current === s && teardown(), CLOSE_TIMEOUT_MS);
      } else {
        teardown();
      }
    },
    [teardown],
  );

  const begin = useCallback(async (mode: VoiceMode) => {
    if (starting.current || live.current) return;
    starting.current = true;
    handsFree.current = mode === "handsfree";
    setStatus("connecting");

    let mic: MediaStream | undefined;
    let pc: RTCPeerConnection | undefined;
    let ctx: AudioContext | undefined;
    try {
      mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      // Closed from the first sample unless this session is hands-free or the key is already down.
      const openNow = handsFree.current || talkHeld.current;
      mic.getTracks().forEach((t) => (t.enabled = openNow));
      pc = new RTCPeerConnection();
      const audioCtx = (ctx = new AudioContext());
      const audio = new Audio();
      audio.autoplay = true;

      const micAnalyser = audioCtx.createAnalyser();
      audioCtx.createMediaStreamSource(mic).connect(micAnalyser);
      const outAnalyser = audioCtx.createAnalyser();

      pc.ontrack = (e) => {
        const stream = e.streams[0];
        audio.srcObject = stream;
        audioCtx.createMediaStreamSource(stream).connect(outAnalyser);
      };
      for (const track of mic.getTracks()) pc.addTrack(track, mic);

      // The events channel has to exist before the offer is created.
      const dc = pc.createDataChannel("oai-events");
      const session: Live = { pc, dc, mic, audio, ctx: audioCtx, frame: 0, delegationTimer: undefined };

      const setDelegating = (on: boolean) => {
        delegating.current = on;
        window.clearTimeout(session.delegationTimer);
        if (on) session.delegationTimer = window.setTimeout(() => (delegating.current = false), DELEGATION_TIMEOUT_MS);
      };

      // Function calls the backend made in its current response, run once it completes.
      const pendingCalls: FunctionCall[] = [];
      let eventSeq = 0;
      const sendEvent = (payload: object) => {
        if (dc.readyState === "open") dc.send(JSON.stringify({ event_id: `jarvis_${++eventSeq}`, ...payload }));
      };
      const runCalls = async (calls: FunctionCall[]) => {
        for (const call of calls) {
          const result = await runTool(call);
          callbacks.current.onNote("tool", result.label);
          sendEvent({
            type: "response.item.create",
            item: { type: "function_call_output", call_id: call.call_id, output: result.output },
          });
        }
        // Every call is answered; let the backend continue with the results.
        sendEvent({ type: "response.create" });
      };

      dc.onmessage = (e) => {
        const ev = JSON.parse(e.data);
        switch (ev.type) {
          case "session.started":
            setStatus("live");
            break;
          case "session.input_transcript.delta":
            callbacks.current.onTranscript("user", ev.delta);
            break;
          case "session.output_transcript.delta":
            callbacks.current.onTranscript("jarvis", ev.delta);
            break;
          case "session.delegation.created":
            setDelegating(true);
            break;
          case "response.event": {
            const inner = ev.event;
            if (inner?.type === "response.output_item.done" && inner.item?.type === "function_call") {
              pendingCalls.push(inner.item);
            } else if (inner?.type === "response.completed" && pendingCalls.length > 0) {
              // Still working: the backend resumes once it has the tool results.
              setDelegating(true);
              void runCalls(pendingCalls.splice(0));
            } else if (inner?.type === "response.completed" || inner?.type === "response.failed") {
              pendingCalls.length = 0;
              setDelegating(false);
            }
            break;
          }
          case "error":
            callbacks.current.onNote("error", `Voice: ${ev.error?.message ?? "unknown error"}`);
            break;
          case "session.closed":
            if (ev.reason && ev.reason !== "close_requested") {
              callbacks.current.onNote("error", `Voice session ended (${ev.reason}).`);
            }
            if (live.current === session) teardown();
            break;
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc!.connectionState === "failed" && live.current === session) {
          callbacks.current.onNote("error", "Voice connection lost.");
          teardown();
        }
      };

      await pc.setLocalDescription(await pc.createOffer());
      await waitForIce(pc);

      const resp = await fetch(`${CORE_HTTP}/api/voice/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sdp: pc.localDescription!.sdp }),
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(body.detail ?? `The core refused the voice session (${resp.status}).`);
      await pc.setRemoteDescription({ type: "answer", sdp: body.sdp });

      // stop() may have been pressed while we were connecting.
      if (!starting.current) throw new DOMException("cancelled", "AbortError");
      live.current = session;
      starting.current = false;
      applyMic();

      const micBuf = new Float32Array(micAnalyser.fftSize);
      const outBuf = new Float32Array(outAnalyser.fftSize);
      let lastLoud = 0;
      let lastActive = performance.now();
      let current: OrbState = "idle";
      setActivity(current);
      const tick = () => {
        session.frame = requestAnimationFrame(tick);
        const out = rms(outAnalyser, outBuf);
        const now = performance.now();
        if (out > SPEAKING_LEVEL) lastLoud = now;
        const speaking = now - lastLoud < SPEAKING_HOLD_MS;
        const open = handsFree.current || talkHeld.current;

        const next: OrbState = delegating.current ? "thinking" : speaking ? "speaking" : open ? "listening" : "idle";
        if (next !== current) {
          current = next;
          setActivity(next);
        }
        const level = speaking ? out : open ? rms(micAnalyser, micBuf) : 0;
        energy.current = Math.max(energy.current, Math.min(1, level * 6));

        if (next !== "idle") {
          lastActive = now;
        } else if (now - lastActive > IDLE_CLOSE_MS) {
          lastActive = now;
          callbacks.current.onNote("tool", "Voice session closed after 90 seconds idle");
          closeSession(session);
        }
      };
      tick();
    } catch (err) {
      mic?.getTracks().forEach((t) => t.stop());
      pc?.close();
      void ctx?.close();
      starting.current = false;
      handsFree.current = false;
      setStatus("off");
      if (err instanceof DOMException && err.name === "AbortError") return;
      const message =
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "Microphone access was blocked. Allow it and try again."
          : err instanceof DOMException && err.name === "NotFoundError"
            ? "No microphone found."
            : err instanceof TypeError
              ? "Could not reach the core to start voice."
              : err instanceof Error
                ? err.message
                : "Voice failed to start.";
      callbacks.current.onNote("error", message);
    }
  }, [energy, teardown, applyMic, closeSession]);

  const start = useCallback(() => void begin("handsfree"), [begin]);

  const stop = useCallback(() => {
    const s = live.current;
    if (!s) {
      // Still connecting: let begin() notice and clean up after itself.
      starting.current = false;
      return;
    }
    closeSession(s);
  }, [closeSession]);

  // Push-to-talk: the first press also opens the session.
  const pressTalk = useCallback(() => {
    window.clearTimeout(releaseTimer.current);
    talkHeld.current = true;
    if (live.current) applyMic();
    else void begin("ptt");
  }, [applyMic, begin]);

  const releaseTalk = useCallback(() => {
    if (!talkHeld.current) return;
    window.clearTimeout(releaseTimer.current);
    releaseTimer.current = window.setTimeout(() => {
      talkHeld.current = false;
      applyMic();
    }, TALK_RELEASE_TAIL_MS);
  }, [applyMic]);

  useEffect(() => teardown, [teardown]);

  return { status, activity, micOpen, start, stop, pressTalk, releaseTalk };
}

function isTypingTarget(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

/** Hold Space anywhere outside a text field to talk; release to stop. */
export function usePushToTalk(press: () => void, release: () => void, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const onDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" || isTypingTarget(e.target)) return;
      // Also stops Space from clicking a focused button or scrolling the page.
      e.preventDefault();
      if (!e.repeat) press();
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      if (!isTypingTarget(e.target)) e.preventDefault();
      release();
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    // Losing focus mid-press would otherwise leave the mic stuck open.
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", release);
      release();
    };
  }, [press, release, enabled]);
}
