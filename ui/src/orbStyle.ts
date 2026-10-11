import { useCallback, useState } from "react";

export const SHAPES = [
  { id: "sphere", label: "Sphere" },
  { id: "ring", label: "Ring" },
  { id: "galaxy", label: "Galaxy" },
  { id: "face", label: "Face" },
  { id: "face3d", label: "Face 3D" },
  { id: "hologram", label: "Hologram" },
  { id: "robot", label: "Robot" },
  { id: "dragon", label: "Dragon" },
  { id: "astronaut", label: "Astronaut" },
  { id: "animatronic", label: "Animatronic" },
  { id: "toy", label: "Robot Toy" },
] as const;
export type OrbShape = (typeof SHAPES)[number]["id"];

export interface ModelSpec {
  file: string;
  // Radians to turn the model so it stands upright (pitch) and faces the viewer (yaw).
  pitch?: number;
  yaw?: number;
}

// Shapes that are a plain 3D model file in ui/public/models/custom/.
export const MODELS: Partial<Record<OrbShape, ModelSpec>> = {
  dragon: { file: "tiny_planet_friends_3d-defective-product-4083.glb" },
  astronaut: { file: "wings_of_freedom-astronaut-3158.glb", yaw: Math.PI / 2 },
  animatronic: { file: "animatronic robot 3d model.glb" },
  toy: { file: "3d-robot-toy copy.glb" },
};

export interface OrbTheme {
  id: string;
  label: string;
  // Space-separated RGB for the UI accent, matching `main`.
  accent: string;
  deep: string;
  main: string;
  bright: string;
  // "Thinking" needs to read as a different state, so each theme picks a contrasting pair.
  thinkAccent: string;
  thinkA: string;
  thinkB: string;
}

const AMBER = { thinkAccent: "255 182 72", thinkA: "#ff6a3d", thinkB: "#ffc861" };

export const THEMES: OrbTheme[] = [
  { id: "arc", label: "Arc blue", accent: "94 230 255", deep: "#2a6bff", main: "#5ee6ff", bright: "#b6fbff", ...AMBER },
  { id: "emerald", label: "Emerald", accent: "74 240 170", deep: "#0f9d6b", main: "#4af0aa", bright: "#c2ffe4", ...AMBER },
  { id: "violet", label: "Violet", accent: "190 150 255", deep: "#6a3df0", main: "#be96ff", bright: "#eadcff", ...AMBER },
  { id: "crimson", label: "Crimson", accent: "255 110 120", deep: "#c81e3c", main: "#ff6e78", bright: "#ffd0d4", ...AMBER },
  {
    id: "gold",
    label: "Gold",
    accent: "255 196 92",
    deep: "#e07a10",
    main: "#ffc45c",
    bright: "#fff0cc",
    // Amber would be invisible against gold, so thinking goes cool instead.
    thinkAccent: "94 230 255",
    thinkA: "#2a6bff",
    thinkB: "#5ee6ff",
  },
];

const STORAGE_KEY = "jarvis.orb";

interface Saved {
  shape: OrbShape;
  theme: string;
}

function load(): Saved {
  const fallback: Saved = { shape: "sphere", theme: THEMES[0].id };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    return {
      shape: SHAPES.some((s) => s.id === saved?.shape) ? saved.shape : fallback.shape,
      theme: THEMES.some((t) => t.id === saved?.theme) ? saved.theme : fallback.theme,
    };
  } catch {
    return fallback;
  }
}

/** The orb's look, remembered in this browser. */
export function useOrbStyle() {
  const [saved, setSaved] = useState(load);

  const update = useCallback((change: Partial<Saved>) => {
    setSaved((current) => {
      const next = { ...current, ...change };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Private windows can refuse storage; the choice still applies until reload.
      }
      return next;
    });
  }, []);

  return {
    shape: saved.shape,
    theme: THEMES.find((t) => t.id === saved.theme) ?? THEMES[0],
    setShape: (shape: OrbShape) => update({ shape }),
    setTheme: (theme: string) => update({ theme }),
  };
}
