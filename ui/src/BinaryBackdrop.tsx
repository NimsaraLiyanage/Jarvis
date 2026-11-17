import { useCallback, useEffect, useRef, useState } from "react";

export type Backdrop = "grid" | "binary";

export const BACKDROPS: { id: Backdrop; label: string }[] = [
  { id: "grid", label: "Grid" },
  { id: "binary", label: "Binary" },
];

const STORAGE_KEY = "onyx.backdrop";
const FONT_PX = 16;
// Drawn at this rate rather than every frame: it reads as rain, and costs little next to the orb.
const FRAME_MS = 1000 / 30;
// Rows a column's head falls per frame, and how many digits trail behind it.
const MIN_SPEED = 0.25;
const MAX_SPEED = 0.7;
const MIN_TRAIL = 8;
const MAX_TRAIL = 28;
// Chance per frame that any one digit flips, so the columns shimmer.
const FLIP_CHANCE = 0.02;
const HEAD = "rgb(220 255 230)";
const BODY = "0 255 102";

export function useBackdrop() {
  const [backdrop, setBackdropState] = useState<Backdrop>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "binary" ? "binary" : "grid";
    } catch {
      return "grid";
    }
  });
  const setBackdrop = useCallback((next: Backdrop) => {
    setBackdropState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Not remembered; it still switches.
    }
  }, []);
  return { backdrop, setBackdrop };
}

/** Columns of glowing green 0s and 1s falling behind the HUD. */
export function BinaryBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    interface Column {
      head: number; // row of the brightest digit; fractional while it falls
      speed: number;
      trail: number;
      digits: string[];
    }
    let columns: Column[] = [];
    let rows = 0;
    let width = 0;
    let height = 0;

    const bit = () => (Math.random() < 0.5 ? "0" : "1");
    const between = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
    // Spread over the screen from the start, so it is already full of rain.
    const newColumn = (head: number): Column => ({
      head,
      speed: between(MIN_SPEED, MAX_SPEED),
      trail: Math.round(between(MIN_TRAIL, MAX_TRAIL)),
      digits: Array.from({ length: rows }, bit),
    });

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      rows = Math.ceil(height / FONT_PX);
      columns = Array.from({ length: Math.ceil(width / FONT_PX) }, () => newColumn(between(-rows * 0.5, rows * 1.3)));
      draw();
    };

    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      ctx.font = `${FONT_PX}px "JetBrains Mono", monospace`;
      ctx.textBaseline = "top";
      columns.forEach((col, i) => {
        const x = i * FONT_PX;
        const headRow = Math.floor(col.head);
        for (let j = col.trail; j >= 1; j--) {
          const row = headRow - j;
          if (row < 0 || row >= rows) continue;
          ctx.fillStyle = `rgb(${BODY} / ${(1 - j / col.trail) * 0.85})`;
          ctx.fillText(col.digits[row], x, row * FONT_PX);
        }
        if (headRow >= 0 && headRow < rows) {
          // Only the head glows: a shadow on every digit would be slow.
          ctx.shadowColor = `rgb(${BODY})`;
          ctx.shadowBlur = 10;
          ctx.fillStyle = HEAD;
          ctx.fillText(col.digits[headRow], x, headRow * FONT_PX);
          ctx.shadowBlur = 0;
        }
      });
    };

    const step = () => {
      for (const col of columns) {
        col.head += col.speed;
        if (col.head - col.trail > rows) Object.assign(col, newColumn(between(-rows * 0.4, 0)));
        for (let k = 0; k < col.digits.length; k++) if (Math.random() < FLIP_CHANCE) col.digits[k] = bit();
      }
      draw();
    };

    resize();
    let frame = 0;
    let last = 0;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (now - last < FRAME_MS) return;
      last = now;
      step();
    };
    // With reduced motion the first frame stays as a still picture.
    if (!still) frame = requestAnimationFrame(tick);
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 h-full w-full opacity-35" />;
}
