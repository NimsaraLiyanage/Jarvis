import { useEffect, useState } from "react";
import { ChatPanel } from "./ChatPanel";
import { Orb } from "./Orb";
import { SystemPanel } from "./SystemPanel";
import { useJarvis, type LinkStatus, type OrbState } from "./useJarvis";
import { useVoice } from "./useVoice";

const LINK_LABEL: Record<LinkStatus, string> = {
  connecting: "Connecting",
  online: "Online",
  offline: "Offline",
};

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <div className="text-right">
      <div className="font-mono text-sm text-text">
        {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
      </div>
      <div className="hidden font-mono text-[11px] text-dim sm:block">
        {now.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: "numeric" })}
      </div>
    </div>
  );
}

export function App() {
  const jarvis = useJarvis();
  const [typing, setTyping] = useState(false);

  const voice = useVoice({ onTranscript: jarvis.appendTranscript, onNote: jarvis.pushNote, energy: jarvis.energy });

  // A typed reply in progress wins; otherwise a live voice session drives the orb.
  const orbState: OrbState =
    jarvis.coreState !== "idle"
      ? jarvis.coreState
      : voice.status === "live"
        ? voice.activity
        : typing
          ? "listening"
          : "idle";

  return (
    <div data-orb={orbState} className="backdrop flex h-dvh flex-col">
      <header className="flex items-center justify-between px-4 pt-3 sm:px-6">
        <div className="flex items-baseline gap-3">
          <h1 className="font-display text-2xl font-bold tracking-[0.3em] text-accent transition-colors duration-500">
            JARVIS
          </h1>
          <span className="flex items-center gap-1.5 font-mono text-[11px] text-dim uppercase">
            <span
              className={`h-1.5 w-1.5 rounded-full ${jarvis.link === "online" ? "bg-emerald-400" : jarvis.link === "connecting" ? "bg-amber-400" : "bg-danger"}`}
            />
            {LINK_LABEL[jarvis.link]}
          </span>
        </div>
        <Clock />
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(180px,32vh)_minmax(0,1fr)] gap-4 p-4 sm:px-6 lg:grid-cols-[260px_minmax(0,1fr)_minmax(340px,420px)] lg:grid-rows-1">
        <SystemPanel
          stats={jarvis.stats}
          link={jarvis.link}
          model={jarvis.model}
          voice={voice.status}
          voiceReady={jarvis.voiceReady}
        />
        <Orb state={orbState} energy={jarvis.energy} />
        <ChatPanel
          messages={jarvis.messages}
          link={jarvis.link}
          isStreaming={jarvis.isStreaming}
          voice={voice.status}
          onVoiceToggle={voice.status === "off" ? voice.start : voice.stop}
          onSend={jarvis.send}
          onReset={jarvis.reset}
          onTypingChange={setTyping}
        />
      </main>
    </div>
  );
}
