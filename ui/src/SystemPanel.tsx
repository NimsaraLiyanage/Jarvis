import type { LinkStatus, SystemStats } from "./useJarvis";
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

function Module({ name, status, on }: { name: string; status: string; on: boolean }) {
  return (
    <li className="flex items-center justify-between py-1.5">
      <span className="flex items-center gap-2.5 text-sm text-text">
        <span className={`h-1.5 w-1.5 rounded-full ${on ? "bg-accent shadow-[0_0_8px_rgb(var(--accent))]" : "bg-white/20"}`} />
        {name}
      </span>
      <span className={`font-mono text-[11px] ${on ? "text-accent" : "text-dim"}`}>{status}</span>
    </li>
  );
}

export function SystemPanel({
  stats,
  link,
  model,
  voice,
  voiceReady,
}: {
  stats: SystemStats | null;
  link: LinkStatus;
  model: string | null;
  voice: VoiceStatus;
  voiceReady: boolean;
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

      <section>
        <h2 className="label mb-2">Modules</h2>
        <ul className="divide-y divide-white/5">
          <Module name="Core link" status={online ? "ONLINE" : link === "connecting" ? "CONNECTING" : "OFFLINE"} on={online} />
          <Module name="Language model" status={online && model ? "READY" : "--"} on={online && !!model} />
          <Module name="Voice" status={voiceLabel} on={online && voiceReady} />
          <Module name="Tools" status={online ? "READY" : "--"} on={online} />
          <Module name="Memory" status="NOT INSTALLED" on={false} />
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
