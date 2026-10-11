import { useEffect, useRef, type RefObject } from "react";
import type { OrbState } from "./useJarvis";

// Everything is drawn in a 200x200 box centred on (100, 100), the same box as the HUD rings.
const MOUTH_Y = 130;
const MAX_OPEN = 6.5;
const BLINK_MS = 150;

const EYES = [
  { cx: 84, cy: 92, outer: -1 },
  { cx: 116, cy: 92, outer: 1 },
];

// The jaw drops a little as the mouth opens, so the outline is rebuilt each frame.
function faceOutline(jaw: number) {
  const j = jaw;
  return (
    `M100,48 C120,48 133,63 133,86 C133,106 129,${123 + j * 0.5} 119,${137 + j * 0.8} ` +
    `C113,${145 + j} 107,${149.5 + j} 100,${149.5 + j} C93,${149.5 + j} 87,${145 + j} 81,${137 + j * 0.8} ` +
    `C71,${123 + j * 0.5} 67,106 67,86 C67,63 80,48 100,48 Z`
  );
}

// Lip shapes for a mouth opened by `o` units. The corners pull in slightly as it opens.
function mouthPaths(o: number) {
  const y = MOUTH_Y;
  const xl = 88 + 0.3 * o;
  const xr = 112 - 0.3 * o;
  const seam = y + 1.6;
  return {
    upper:
      `M${xl},${y} C${xl + 4},${y - 3} 96,${y - 4.6} 98,${y - 4.2} Q100,${y - 3.2} 102,${y - 4.2} ` +
      `C104,${y - 4.6} ${xr - 4},${y - 3} ${xr},${y} Q100,${seam} ${xl},${y} Z`,
    inner: `M${xl},${y} Q100,${seam} ${xr},${y} Q100,${seam + 2 * o} ${xl},${y} Z`,
    teeth: `M${xl + 3},${y + 0.9} Q100,${seam + 0.5} ${xr - 3},${y + 0.9} Q100,${seam + 0.5 + Math.min(o, 2.2)} ${xl + 3},${y + 0.9} Z`,
    lower: `M${xl},${y} Q100,${seam + 2 * o} ${xr},${y} Q100,${y + 11 + 1.9 * o} ${xl},${y} Z`,
  };
}

function Eye({ cx, cy, outer, eyeRef, irisRef }: (typeof EYES)[number] & { eyeRef: (el: SVGGElement | null) => void; irisRef: (el: SVGGElement | null) => void }) {
  const inner = cx - outer * 8;
  const edge = cx + outer * 9;
  return (
    <g ref={eyeRef}>
      <path d={`M${inner},${cy + 0.5} Q${cx},${cy - 7} ${edge},${cy - 0.5} Q${cx},${cy + 5} ${inner},${cy + 0.5} Z`} fill="currentColor" fillOpacity="0.1" strokeWidth="0.4" />
      <g ref={irisRef}>
        <circle cx={cx} cy={cy - 0.7} r="3.6" fill="currentColor" fillOpacity="0.5" strokeWidth="0.5" />
        <circle cx={cx} cy={cy - 0.7} r="1.4" fill="var(--color-ink)" stroke="none" />
        <circle cx={cx + 1.2} cy={cy - 1.9} r="0.75" fill="#fff" stroke="none" />
      </g>
      {/* Upper lash line with a small wing at the outer corner, and a soft lid crease above it. */}
      <path d={`M${inner},${cy + 0.5} Q${cx},${cy - 7.3} ${edge},${cy - 0.5} L${edge + outer * 2.6},${cy - 2.6}`} strokeWidth="1.2" strokeLinecap="round" fill="none" />
      <path d={`M${inner + outer * 1.5},${cy - 3.4} Q${cx},${cy - 9.2} ${edge - outer * 0.5},${cy - 4}`} strokeWidth="0.4" opacity="0.6" fill="none" />
    </g>
  );
}

export function Face({ state, energy }: { state: OrbState; energy: RefObject<number> }) {
  const stateRef = useRef(state);
  stateRef.current = state;

  const headRef = useRef<SVGGElement>(null);
  const outlineRef = useRef<SVGPathElement>(null);
  const browsRef = useRef<SVGGElement>(null);
  const eyeRefs = useRef<(SVGGElement | null)[]>([]);
  const irisRefs = useRef<(SVGGElement | null)[]>([]);
  const upperRef = useRef<SVGPathElement>(null);
  const innerRef = useRef<SVGPathElement>(null);
  const teethRef = useRef<SVGPathElement>(null);
  const lowerRef = useRef<SVGPathElement>(null);

  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    let last = performance.now();
    let t = 0;
    let open = 0;
    let gazeX = 0;
    let gazeY = 0;
    let brow = 0;
    let tilt = 0;
    let blinkStart = -Infinity;
    let nextBlink = last + 2500;

    const tick = () => {
      frame = requestAnimationFrame(tick);
      const now = performance.now();
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      t += dt;
      const s = stateRef.current;
      const ease = (rate: number) => 1 - Math.exp(-dt * rate);

      // Mouth: follows the speech level, with a fast flutter so steady sound still reads as talking.
      energy.current *= Math.exp(-dt * 5);
      const flutter = 0.7 + 0.3 * Math.sin(t * 21);
      const target = s === "speaking" ? Math.min(1, energy.current * 1.3) * flutter * MAX_OPEN : 0;
      open += (target - open) * ease(target > open ? 34 : 16);

      const mouth = mouthPaths(open);
      upperRef.current?.setAttribute("d", mouth.upper);
      innerRef.current?.setAttribute("d", mouth.inner);
      lowerRef.current?.setAttribute("d", mouth.lower);
      teethRef.current?.setAttribute("d", mouth.teeth);
      teethRef.current?.setAttribute("opacity", String(Math.min(1, open / 2.5) * 0.85));
      outlineRef.current?.setAttribute("d", faceOutline(open * 0.55));

      // Eyes: blink at irregular intervals; look up and away while thinking.
      if (now > nextBlink) {
        blinkStart = now;
        nextBlink = now + 2400 + Math.random() * 3600;
      }
      const phase = (now - blinkStart) / BLINK_MS;
      const lid = 1 - 0.93 * (phase < 1 ? Math.sin(phase * Math.PI) : 0);
      const wander = reducedMotion ? 0 : 1;
      const gazeTargetX = s === "thinking" ? -1.5 + 0.5 * Math.sin(t * 1.7) : s === "idle" ? 0.9 * Math.sin(t * 0.35) * wander : 0;
      const gazeTargetY = s === "thinking" ? -1.2 : 0;
      gazeX += (gazeTargetX - gazeX) * ease(6);
      gazeY += (gazeTargetY - gazeY) * ease(6);
      EYES.forEach((eye, i) => {
        eyeRefs.current[i]?.setAttribute("transform", `translate(${eye.cx} ${eye.cy}) scale(1 ${lid}) translate(${-eye.cx} ${-eye.cy})`);
        irisRefs.current[i]?.setAttribute("transform", `translate(${gazeX} ${gazeY})`);
      });

      // Brows lift when attentive; the head sways gently and tilts toward whoever is talking.
      const browTarget = s === "thinking" ? -1.3 : s === "listening" ? -0.9 : s === "speaking" ? -0.12 * open : 0;
      brow += (browTarget - brow) * ease(7);
      browsRef.current?.setAttribute("transform", `translate(0 ${brow})`);

      const sway = reducedMotion ? 0 : Math.sin(t * 0.6);
      const tiltTarget = s === "listening" ? 2.2 : s === "thinking" ? -1.6 : sway * 0.8;
      tilt += (tiltTarget - tilt) * ease(3);
      headRef.current?.setAttribute("transform", `translate(0 ${sway * 0.6}) rotate(${tilt} 100 150)`);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [energy]);

  const mouth = mouthPaths(0);
  return (
    <svg
      viewBox="0 0 200 200"
      className="face absolute aspect-square h-[94%] max-w-[94%] text-accent"
      fill="none"
      stroke="currentColor"
      strokeWidth="0.8"
      strokeLinejoin="round"
      role="img"
      aria-label="Jarvis"
    >
      <defs>
        <clipPath id="face-clip">
          <circle cx="100" cy="100" r="77" />
        </clipPath>
        <pattern id="face-scan" width="4" height="2.4" patternUnits="userSpaceOnUse">
          <rect width="4" height="0.5" fill="currentColor" stroke="none" />
        </pattern>
      </defs>

      <g clipPath="url(#face-clip)">
        <g ref={headRef}>
          {/* Neck and shoulders sit behind everything else. */}
          <path
            d="M88,138 L88,159 C88,167 80,171 70,174 C57,178 47,185 43,198 L157,198 C153,185 143,178 130,174 C120,171 112,167 112,159 L112,138 Z"
            fill="currentColor"
            fillOpacity="0.07"
          />
          <path d="M92,172 Q100,180 108,172" strokeWidth="0.6" opacity="0.6" />

          {/* Hair: one mass that leaves the face open, with a side-swept fringe. */}
          <path
            d="M100,30 C69,30 49,53 49,86 C49,112 50,132 44,152 C42,160 44,168 40,176 L64,180 C70,160 66,140 68,116 C68,100 66,88 69,78 C80,75 95,66 105,53 C111,63 122,71 131,77 C134,88 132,100 132,116 C134,140 130,160 136,180 L160,176 C156,168 158,160 156,152 C150,132 151,112 151,86 C151,53 131,30 100,30 Z"
            fill="currentColor"
            fillOpacity="0.2"
            strokeWidth="0.8"
          />
          <g strokeWidth="0.45" opacity="0.5">
            <path d="M101,35 C78,36 58,56 57,86 C56,114 58,138 52,166" />
            <path d="M104,36 C126,38 143,58 143,86 C144,114 142,138 148,166" />
            <path d="M104,41 C95,54 82,63 70,68" />
            <path d="M103,46 C97,56 88,64 77,70" />
            <path d="M107,43 C114,55 125,64 135,69" />
            <path d="M62,112 C62,136 64,154 58,174" />
            <path d="M138,112 C138,136 136,154 142,174" />
          </g>

          {/* Face: a dark fill so the neck does not show through, then a faint tint. */}
          <path d={faceOutline(0)} fill="var(--color-ink)" stroke="none" opacity="0.9" />
          <path ref={outlineRef} d={faceOutline(0)} fill="currentColor" fillOpacity="0.06" strokeWidth="0.8" />

          {/* The fringe falls over the forehead, in front of the face. */}
          <path
            d="M69,80 C80,76 95,67 105,53 C111,63 122,71 131,78 C128,66 120,54 106,49 C90,50 74,62 69,80 Z"
            fill="currentColor"
            fillOpacity="0.22"
            strokeWidth="0.6"
          />

          <g strokeWidth="0.5" opacity="0.4">
            <path d="M70,106 Q74,119 83,129" />
            <path d="M130,106 Q126,119 117,129" />
          </g>

          <g ref={browsRef} strokeWidth="1.3" strokeLinecap="round">
            <path d="M74,83.5 Q83,78 93.5,82" />
            <path d="M126,83.5 Q117,78 106.5,82" />
          </g>

          {EYES.map((eye, i) => (
            <Eye key={eye.cx} {...eye} eyeRef={(el) => (eyeRefs.current[i] = el)} irisRef={(el) => (irisRefs.current[i] = el)} />
          ))}

          <g strokeWidth="0.7" strokeLinecap="round" opacity="0.7">
            <path d="M97.5,97 C96.5,105 95,111 95.5,115.5" />
            <path d="M95,117 Q97.5,119.5 100,118.6 Q102.5,119.5 105,117" />
          </g>

          <path ref={innerRef} d={mouth.inner} fill="var(--color-ink)" strokeWidth="0.4" />
          <path ref={teethRef} d={mouth.teeth} fill="#fff" stroke="none" opacity="0" />
          <path ref={upperRef} d={mouth.upper} fill="currentColor" fillOpacity="0.55" strokeWidth="0.7" />
          <path ref={lowerRef} d={mouth.lower} fill="currentColor" fillOpacity="0.45" strokeWidth="0.7" />
        </g>

        {/* Hologram scan lines drifting over the whole figure. */}
        <rect className="face-scan" x="0" y="-10" width="200" height="220" fill="url(#face-scan)" stroke="none" opacity="0.07" />
      </g>
    </svg>
  );
}
