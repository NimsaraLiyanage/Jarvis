import type { LinkStatus, SystemStats, Usage, WakeStatus } from "./useJarvis";
import type { VoiceStatus } from "./useVoice";

function Meter({ label, value, detail }: { label: string; value: number | null; detail?: string }) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="font-display text-sm font-semibold tracking-widest text-dim">{label}</span>
        <span className="font-mono text-sm text-text">{value === null ? "--" : `${Math.round(value)}%`}</span>
      </div>
      <div className="mt-1.5 h-1.5 bg-white/5">
        <div
          className="h-full bg-accent transition-[width,background-color] duration-700"
          style={{ width: `${value ?? 0}%` }}
        />
      </div>
      {detail && <div className="mt-1 font-mono text-[11px] text-dim">{detail}</div>}
    </div>
  );
}

function Module({ name, status, on, note }: { name: string; status: string; on: boolean; note?: string }) {
  return (
    <li className="py-1.5">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2.5 text-sm text-text">
          <span className={`h-1.5 w-1.5 rounded-full ${on ? "bg-accent shadow-[0_0_8px_rgb(var(--accent))]" : "bg-white/20"}`} />
          {name}
        </span>
        <span className={`font-mono text-[11px] ${on ? "text-accent" : "text-dim"}`}>{status}</span>
      </div>
      {note && <p className="mt-1 pl-4 text-xs leading-snug break-words text-dim">{note}</p>}
    </li>
  );
}

const WAKE_LABEL: Record<WakeStatus["wake_word"], string> = { off: "OFF", on: "LISTENING", setup: "SET UP", error: "ERROR" };

function formatTokens(n: number) {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function UsageSection({ usage }: { usage: Usage }) {
  const month = new Date(`${usage.month}-01T00:00`).toLocaleDateString([], { month: "long" });
  return (
    <section>
      <h2 className="label mb-3">Usage · {month}</h2>
      <div className="font-mono text-2xl text-text">${usage.cost.toFixed(usage.cost < 1 ? 3 : 2)}</div>
      <div className="mt-1 font-mono text-[11px] text-dim">estimated, billed by OpenAI</div>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-[11px]">
        <dt className="text-dim">Tokens in</dt>
        <dd className="text-right text-text">{formatTokens(usage.input_tokens)}</dd>
        <dt className="text-dim">Tokens out</dt>
        <dd className="text-right text-text">{formatTokens(usage.output_tokens)}</dd>
        <dt className="text-dim">Voice</dt>
        <dd className="text-right text-text">{(usage.voice_seconds / 60).toFixed(1)} min</dd>
      </dl>
      {usage.unpriced.length > 0 && (
        <div className="mt-2 text-[11px] text-dim">No price set for {usage.unpriced.join(", ")}, so it isn't in the total.</div>
      )}
    </section>
  );
}

export function SystemPanel({
  stats,
  link,
  model,
  voice,
  voiceReady,
  usage,
  wake,
}: {
  stats: SystemStats | null;
  link: LinkStatus;
  model: string | null;
  voice: VoiceStatus;
  voiceReady: boolean;
  usage: Usage | null;
  wake: WakeStatus | null;
}) {
  const online = link === "online";
  const voiceLabel = !online ? "--" : !voiceReady ? "NO API KEY" : voice === "live" ? "LIVE" : voice === "connecting" ? "CONNECTING" : "READY";
  return (
    <aside className="panel hidden min-h-0 lg:block">
      {/* Scrolling lives on an inner box so the panel's corner brackets don't cause overflow. */}
      <div className="scroll-thin flex h-full flex-col gap-6 overflow-y-auto p-5">
      <section>
        <h2 className="label mb-4">System</h2>
        <div className="flex flex-col gap-4">
          <Meter label="CPU" value={stats?.cpu ?? null} />
          <Meter
            label="MEMORY"
            value={stats?.ram ?? null}
            detail={stats ? `${stats.ram_used_gb} / ${stats.ram_total_gb} GB` : undefined}
          />
          {stats?.battery != null && (
            <Meter label="BATTERY" value={stats.battery} detail={stats.charging ? "Charging" : "On battery"} />
          )}
        </div>
      </section>

      {usage && <UsageSection usage={usage} />}

      <section>
        <h2 className="label mb-2">Modules</h2>
        <ul className="divide-y divide-white/5">
          <Module name="Core link" status={online ? "ONLINE" : link === "connecting" ? "CONNECTING" : "OFFLINE"} on={online} />
          <Module name="Language model" status={online && model ? "READY" : "--"} on={online && !!model} />
          <Module name="Voice" status={voiceLabel} on={online && voiceReady} />
          <Module name="Tools" status={online ? "READY" : "--"} on={online} />
          <Module name="Memory" status={online ? "READY" : "--"} on={online} />
          <Module
            name={wake?.wake_phrase ?? "Wake word"}
            status={online && wake ? WAKE_LABEL[wake.wake_word] : "--"}
            on={online && wake?.wake_word === "on"}
            // Explains a problem, or how to switch from the stand-in "Hey Jarvis" to "Hey Onyx".
            note={online && wake && (wake.wake_word !== "on" || wake.wake_phrase !== "Hey Onyx") ? wake.wake_word_detail : undefined}
          />
          <Module name="Hotkey" status={online && wake?.hotkey ? wake.hotkey.toUpperCase() : "--"} on={online && !!wake?.hotkey} />
        </ul>
      </section>

      {model && (
        <section className="mt-auto">
          <h2 className="label mb-1">Model</h2>
          <div className="font-mono text-xs text-dim">{model}</div>
        </section>
      )}
      </div>
    </aside>
  );
}
