import { useEffect, useRef, useState } from "react";
import type { Device, SystemStats, Weather } from "./useJarvis";

const CORE_HTTP = import.meta.env.VITE_CORE_HTTP ?? "http://127.0.0.1:8765";
// Same id always lands on the same bearing, so dots don't jump around between scans.
function bearing(id: string) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 360) * (Math.PI / 180);
}

const RING = { bluetooth: 0.45, usb: 0.8 } as const;

function DeviceRadar({ devices }: { devices: Device[] }) {
  const size = 200;
  const c = size / 2;
  const r = c - 6;
  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="label">Devices</h2>
        <span className="font-mono text-[11px] text-dim">{devices.length} linked</span>
      </div>
      <div className="flex items-center gap-4">
        <svg viewBox={`0 0 ${size} ${size}`} className="h-40 w-40 shrink-0" role="img" aria-label={`${devices.length} connected devices`}>
          <defs>
            <linearGradient id="sweep" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="rgb(var(--accent))" stopOpacity="0" />
              <stop offset="1" stopColor="rgb(var(--accent))" stopOpacity="0.35" />
            </linearGradient>
          </defs>
          {[0.25, RING.bluetooth, 0.62, RING.usb, 1].map((f) => (
            <circle key={f} cx={c} cy={c} r={r * f} fill="none" stroke="rgb(var(--accent))" strokeOpacity={f === RING.bluetooth || f === RING.usb ? 0.35 : 0.12} strokeDasharray={f === 1 ? undefined : "2 4"} />
          ))}
          <line x1={c - r} y1={c} x2={c + r} y2={c} stroke="rgb(var(--accent))" strokeOpacity="0.1" />
          <line x1={c} y1={c - r} x2={c} y2={c + r} stroke="rgb(var(--accent))" strokeOpacity="0.1" />
          <g className="radar-sweep" style={{ transformOrigin: `${c}px ${c}px` }}>
            <path d={`M${c} ${c} L${c + r} ${c} A${r} ${r} 0 0 0 ${c + r * Math.cos(-0.6)} ${c + r * Math.sin(-0.6)} Z`} fill="url(#sweep)" />
          </g>
          <circle cx={c} cy={c} r="4" fill="rgb(var(--accent))" />
          {devices.map((d) => {
            const a = bearing(d.id);
            const rr = r * RING[d.kind];
            const x = c + rr * Math.cos(a);
            const y = c + rr * Math.sin(a);
            return (
              <g key={d.id}>
                <circle cx={x} cy={y} r="9" fill="rgb(var(--accent))" opacity="0.15" className="radar-ping" style={{ transformOrigin: `${x}px ${y}px` }} />
                {d.kind === "bluetooth" ? (
                  <circle cx={x} cy={y} r="4.5" fill="rgb(var(--accent))" />
                ) : (
                  <rect x={x - 4} y={y - 4} width="8" height="8" fill="rgb(var(--accent))" />
                )}
                <title>{d.name}</title>
              </g>
            );
          })}
        </svg>
        <ul className="min-w-0 flex-1 space-y-1.5 text-sm">
          {devices.length === 0 && <li className="text-dim">No Bluetooth or USB devices connected.</li>}
          {devices.map((d) => (
            <li key={d.id} className="flex items-center gap-2">
              <span className={`h-2 w-2 shrink-0 bg-accent ${d.kind === "bluetooth" ? "rounded-full" : ""}`} />
              <span className="truncate text-text" title={d.name}>{d.name}</span>
            </li>
          ))}
          {devices.length > 0 && (
            <li className="pt-1 font-mono text-[10px] text-dim">● Bluetooth · ■ USB</li>
          )}
        </ul>
      </div>
    </section>
  );
}

function WeatherIcon({ code, day }: { code: number; day: boolean }) {
  const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const };
  const cloud = <path d="M7 18h10a4 4 0 0 0 0-8 5.5 5.5 0 0 0-10.6 1.6A3.3 3.3 0 0 0 7 18Z" {...stroke} />;
  let body;
  if (code <= 1) {
    body = day ? (
      <>
        <circle cx="12" cy="12" r="4" {...stroke} />
        <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" {...stroke} />
      </>
    ) : (
      <path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5Z" {...stroke} />
    );
  } else if (code >= 95) {
    body = <>{cloud}<path d="m12 18-2 3h3l-2 3" {...stroke} /></>;
  } else if (code >= 71 && code <= 86 && code !== 80 && code !== 81 && code !== 82) {
    body = <>{cloud}<path d="M9 21h.01M12 22h.01M15 21h.01" {...stroke} strokeWidth={2.5} /></>;
  } else if (code >= 51) {
    body = <>{cloud}<path d="m9 20-1 2M13 20l-1 2M17 20l-1 2" {...stroke} /></>;
  } else {
    body = cloud;
  }
  return (
    <svg viewBox="0 0 24 24" className="h-12 w-12 text-accent" aria-hidden="true">
      {body}
    </svg>
  );
}

function LocationNote({ weather, onUpdate }: { weather: Weather; onUpdate: (w: Weather) => void }) {
  const [busy, setBusy] = useState(false);
  const post = async (path: string) => {
    setBusy(true);
    try {
      const resp = await fetch(`${CORE_HTTP}${path}`, { method: "POST" });
      if (path.endsWith("refresh") && resp.ok) {
        const next = (await resp.json()) as Weather | null;
        if (next) onUpdate(next);
      }
    } catch {
      // The core is offline; the next stats tick will say so.
    } finally {
      setBusy(false);
    }
  };

  if (weather.source === "windows") {
    return <p className="mt-2 font-mono text-[10px] text-dim">Windows location · ±{weather.accuracy_m} m</p>;
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-dim">
      <span>Approximate, from IP address</span>
      <button type="button" disabled={busy} onClick={() => void post("/api/location/settings")} className="text-accent uppercase hover:underline disabled:opacity-40">
        Use precise location
      </button>
      <button type="button" disabled={busy} onClick={() => void post("/api/location/refresh")} className="uppercase hover:text-accent disabled:opacity-40">
        {busy ? "Checking…" : "Recheck"}
      </button>
    </div>
  );
}

function WeatherCard({ weather: live }: { weather: Weather | null }) {
  // A manual recheck shows at once; the next stats tick carries the same reading.
  const [override, setOverride] = useState<Weather | null>(null);
  useEffect(() => setOverride(null), [live?.city, live?.source]);
  const weather = override ?? live;
  return (
    <section>
      <h2 className="label mb-3">Weather{weather ? ` · ${weather.city}` : ""}</h2>
      {weather ? (
        <div className="flex items-center gap-4">
          <WeatherIcon code={weather.code} day={weather.is_day} />
          <div className="flex-1">
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-3xl text-text">{Math.round(weather.temp)}°</span>
              <span className="text-sm text-text">{weather.condition}</span>
            </div>
            <div className="font-mono text-[11px] text-dim">
              H {Math.round(weather.high)}° · L {Math.round(weather.low)}° · feels {Math.round(weather.feels_like)}°
            </div>
          </div>
          <dl className="grid grid-cols-[auto_auto] gap-x-2 font-mono text-[11px]">
            <dt className="text-dim">HUM</dt>
            <dd className="text-right text-text">{weather.humidity}%</dd>
            <dt className="text-dim">WIND</dt>
            <dd className="text-right text-text">{Math.round(weather.wind_kmh)} km/h</dd>
          </dl>
        </div>
      ) : (
        <p className="text-sm text-dim">Waiting for a connection…</p>
      )}
      {weather && <LocationNote weather={weather} onUpdate={setOverride} />}
    </section>
  );
}

const HISTORY = 40;

function rate(bytes: number) {
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB/s`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB/s`;
  return `${bytes} B/s`;
}

function uptime(s: number) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : `${h}h ${m}m`;
}

function NetworkCard({ stats }: { stats: SystemStats | null }) {
  const [history, setHistory] = useState<{ up: number; down: number }[]>([]);
  const last = useRef<SystemStats | null>(null);
  useEffect(() => {
    if (!stats || stats === last.current) return;
    last.current = stats;
    setHistory((h) => [...h.slice(-(HISTORY - 1)), { up: stats.net_up, down: stats.net_down }]);
  }, [stats]);

  const peak = Math.max(1, ...history.flatMap((p) => [p.up, p.down]));
  const line = (key: "up" | "down") =>
    history.map((p, i) => `${(i / (HISTORY - 1)) * 100},${30 - (p[key] / peak) * 28}`).join(" ");

  return (
    <section>
      <h2 className="label mb-3">Network</h2>
      <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="h-12 w-full" aria-hidden="true">
        <polyline points={line("down")} fill="none" stroke="rgb(var(--accent))" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <polyline points={line("up")} fill="none" stroke="rgb(var(--accent))" strokeOpacity="0.45" strokeDasharray="2 2" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      </svg>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px]">
        <div className="flex justify-between"><dt className="text-dim">▼ DOWN</dt><dd className="text-text">{stats ? rate(stats.net_down) : "--"}</dd></div>
        <div className="flex justify-between"><dt className="text-dim">▲ UP</dt><dd className="text-text">{stats ? rate(stats.net_up) : "--"}</dd></div>
        <div className="flex justify-between"><dt className="text-dim">DISK</dt><dd className="text-text">{stats ? `${Math.round(stats.disk)}%` : "--"}</dd></div>
        <div className="flex justify-between"><dt className="text-dim">UPTIME</dt><dd className="text-text">{stats ? uptime(stats.uptime_s) : "--"}</dd></div>
      </dl>
    </section>
  );
}

// Shown in the right panel while the transcript is collapsed.
export function HudWidgets({ stats, devices, weather }: { stats: SystemStats | null; devices: Device[]; weather: Weather | null }) {
  return (
    <div className="flex flex-col gap-6">
      <WeatherCard weather={weather} />
      <DeviceRadar devices={devices} />
      <NetworkCard stats={stats} />
    </div>
  );
}
