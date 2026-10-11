import { useEffect, useRef, useState } from "react";
import { SHAPES, THEMES, type OrbShape, type OrbTheme } from "./orbStyle";

export function OrbSettings({
  shape,
  theme,
  onShape,
  onTheme,
}: {
  shape: OrbShape;
  theme: OrbTheme;
  onShape: (shape: OrbShape) => void;
  onTheme: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={`flex h-9 items-center gap-2 border px-3 font-display text-xs font-semibold tracking-widest uppercase transition-colors ${
          open ? "border-accent text-accent" : "border-white/15 text-dim hover:border-accent/60 hover:text-accent"
        }`}
      >
        <span className="h-2.5 w-2.5 rounded-full bg-accent shadow-[0_0_8px_rgb(var(--accent))]" aria-hidden="true" />
        Orb
      </button>

      {open && (
        // The opaque wrapper positions the popover; .panel sets its own position and background.
        <div role="dialog" aria-label="Orb appearance" className="absolute top-11 right-0 z-20 w-64 bg-ink-2">
          <div className="panel p-4">
          <h2 className="label mb-2">Shape</h2>
          <div className="grid grid-cols-2 gap-1.5">
            {SHAPES.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => onShape(s.id)}
                aria-pressed={shape === s.id}
                className={`border py-1.5 text-sm transition-colors ${
                  shape === s.id ? "border-accent bg-accent/15 text-accent" : "border-white/10 text-text hover:border-accent/50"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>

          <h2 className="label mt-4 mb-2">Colour</h2>
          <div className="flex flex-col gap-1">
            {THEMES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => onTheme(t.id)}
                aria-pressed={theme.id === t.id}
                className={`flex items-center gap-3 border px-2.5 py-1.5 text-left text-sm transition-colors ${
                  theme.id === t.id ? "border-accent bg-accent/15 text-text" : "border-transparent text-text hover:border-white/15"
                }`}
              >
                <span
                  className="h-4 w-4 shrink-0 rounded-full"
                  style={{ background: `linear-gradient(135deg, ${t.deep}, ${t.main} 55%, ${t.bright})` }}
                  aria-hidden="true"
                />
                {t.label}
              </button>
            ))}
          </div>
          </div>
        </div>
      )}
    </div>
  );
}
