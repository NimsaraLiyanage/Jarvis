import { useEffect, useRef, useState, type RefObject } from "react";
import * as THREE from "three";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { Face } from "./Face";
import type { OrbTheme } from "./orbStyle";
import type { OrbState } from "./useJarvis";

const BASE = import.meta.env.BASE_URL;
// Drop your own head model at ui/public/models/avatar.glb to replace the bundled one.
const MODEL_URLS = [`${BASE}models/avatar.glb`, `${BASE}models/head.glb`];
const BLINK_MS = 150;
const ARM_DROP = 1.2;

// Face shapes by their ARKit names. Exporters disagree on spelling ("eyeBlink_L" vs
// "eyeBlinkLeft"), so each shape lists every spelling to try.
const SHAPES = {
  jawOpen: ["jawOpen", "viseme_aa", "mouthOpen"],
  funnel: ["mouthFunnel", "viseme_O"],
  pucker: ["mouthPucker", "viseme_U"],
  lowerDownL: ["mouthLowerDown_L", "mouthLowerDownLeft"],
  lowerDownR: ["mouthLowerDown_R", "mouthLowerDownRight"],
  upperUpL: ["mouthUpperUp_L", "mouthUpperUpLeft"],
  upperUpR: ["mouthUpperUp_R", "mouthUpperUpRight"],
  smileL: ["mouthSmile_L", "mouthSmileLeft"],
  smileR: ["mouthSmile_R", "mouthSmileRight"],
  blinkL: ["eyeBlink_L", "eyeBlinkLeft"],
  blinkR: ["eyeBlink_R", "eyeBlinkRight"],
  browUp: ["browInnerUp"],
  browOuterL: ["browOuterUp_L", "browOuterUpLeft"],
  browOuterR: ["browOuterUp_R", "browOuterUpRight"],
  lookUpL: ["eyeLookUp_L", "eyeLookUpLeft"],
  lookUpR: ["eyeLookUp_R", "eyeLookUpRight"],
} as const;
type ShapeName = keyof typeof SHAPES;

/** Sets a named face shape on every mesh in the model that has it. */
function makeShapeSetter(model: THREE.Object3D) {
  const targets = new Map<ShapeName, { mesh: THREE.Mesh; index: number }[]>();
  model.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    const dictionary = mesh.morphTargetDictionary;
    if (!dictionary || !mesh.morphTargetInfluences) return;
    for (const [shape, spellings] of Object.entries(SHAPES) as [ShapeName, readonly string[]][]) {
      const name = spellings.find((s) => s in dictionary);
      if (name === undefined) continue;
      if (!targets.has(shape)) targets.set(shape, []);
      targets.get(shape)!.push({ mesh, index: dictionary[name] });
    }
  });
  const set = (shape: ShapeName, value: number) => {
    for (const { mesh, index } of targets.get(shape) ?? []) mesh.morphTargetInfluences![index] = value;
  };
  return { set, canTalk: targets.has("jawOpen") };
}

// A soft round dot, so the mesh nodes are not drawn as squares.
function dotTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.35, "rgba(255,255,255,0.85)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
}

/**
 * Restyles a head model as a robot face built from mesh nodes: glowing dots at the
 * vertices joined by the wireframe, over a dark shell that hides the far side.
 * The overlays share the original mesh's face shapes, so they move with it.
 */
function toMeshNodes(model: THREE.Object3D, nodeSize: number) {
  const shell = new THREE.MeshBasicMaterial({ color: 0x05080f, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const overlay = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false };
  const wire = new THREE.MeshBasicMaterial({ ...overlay, wireframe: true, opacity: 0.32 });
  const nodes = new THREE.PointsMaterial({ ...overlay, size: nodeSize, map: dotTexture(), opacity: 0.95 });
  const eye = new THREE.MeshBasicMaterial({ toneMapped: false });

  const meshes: THREE.Mesh[] = [];
  model.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) meshes.push(obj as THREE.Mesh);
  });
  for (const mesh of meshes) {
    for (const old of [mesh.material].flat()) {
      (old as THREE.MeshStandardMaterial).map?.dispose();
      old.dispose();
    }
    // The eyes become solid glowing lenses instead of mesh.
    if (/eye/i.test(`${mesh.name} ${mesh.parent?.name ?? ""}`)) {
      mesh.material = eye;
      continue;
    }
    mesh.material = shell;
    for (const layer of [new THREE.Mesh(mesh.geometry, wire), new THREE.Points(mesh.geometry, nodes)]) {
      layer.morphTargetDictionary = mesh.morphTargetDictionary;
      layer.morphTargetInfluences = mesh.morphTargetInfluences;
      mesh.add(layer);
    }
  }
  return { wire, nodes, eye };
}

async function loadModel(loader: GLTFLoader, urls: string[]) {
  for (const url of urls) {
    try {
      // Vite's dev server answers a missing file with index.html, so check the type first.
      const head = await fetch(url, { method: "HEAD" });
      if (!head.ok || head.headers.get("content-type")?.includes("text/html")) continue;
      return (await loader.loadAsync(url)).scene;
    } catch (err) {
      console.warn(`Could not load ${url}`, err);
    }
  }
  throw new Error("No head model could be loaded");
}

export function Face3D({
  state,
  energy,
  theme,
  look,
}: {
  state: OrbState;
  energy: RefObject<number>;
  theme: OrbTheme;
  // "real" shows the model as it is; "mesh" redraws the bundled head as a robot made of mesh nodes.
  look: "real" | "mesh";
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    const host = hostRef.current!;
    let disposed = false;
    let frame = 0;

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(26, 1, 0.01, 100);

    // Soft frontal light for the skin, plus two coloured back lights that tie the head to the HUD.
    scene.add(new THREE.HemisphereLight(0xfff4ea, 0x2a2622, 1.5));
    const key = new THREE.DirectionalLight(0xffe9d2, 2.6);
    key.position.set(1.2, 1.4, 3);
    scene.add(key);
    const rims = [-1, 1].map((side) => {
      const rim = new THREE.DirectionalLight(themeRef.current.main, 2.2);
      rim.position.set(side * 3, 1, -2.5);
      scene.add(rim);
      return rim;
    });

    const ktx2 = new KTX2Loader().setTranscoderPath(`${BASE}basis/`).detectSupport(renderer);
    const loader = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);

    const pivot = new THREE.Group();
    scene.add(pivot);
    let frameDistance = 1;

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = host;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      // Keep the head inside the rings when the pane is narrower than it is tall.
      camera.position.set(0, 0, frameDistance * (w < h ? h / w : 1));
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    // The robot is always the bundled head; a custom avatar only replaces the realistic face.
    loadModel(loader, look === "mesh" ? MODEL_URLS.slice(-1) : MODEL_URLS)
      .then((model) => {
        if (disposed) return;
        // Centre the model on the pivot and back the camera off until the head fills the ring.
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const centre = box.getCenter(new THREE.Vector3());
        let frameHeight = Math.max(size.x, size.y);
        // A full-body avatar (it has a skeleton with hips) is framed on its head bone instead.
        const headBone = model.getObjectByName("Hips") ? model.getObjectByName("Head") : undefined;
        if (headBone) {
          model.updateWorldMatrix(true, true);
          // Bring the arms down from a T-pose so the shoulders look natural in frame.
          for (const [side, sign] of [["Left", -1], ["Right", 1]] as const) {
            const arm = model.getObjectByName(`${side}Arm`);
            const foreArm = model.getObjectByName(`${side}ForeArm`);
            if (!arm?.parent || !foreArm) continue;
            const along = foreArm.getWorldPosition(new THREE.Vector3()).sub(arm.getWorldPosition(new THREE.Vector3())).normalize();
            if (Math.abs(along.y) > 0.3) continue; // already hanging down (A-pose)
            // Swing about the front-to-back axis, expressed in the parent bone's own frame.
            const axis = new THREE.Vector3(0, 0, 1).applyQuaternion(arm.parent.getWorldQuaternion(new THREE.Quaternion()).invert());
            arm.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, sign * ARM_DROP));
          }
          model.updateWorldMatrix(true, true);
          headBone.getWorldPosition(centre);
          frameHeight = size.y * 0.22;
          centre.y += frameHeight * 0.18;
        }
        model.position.sub(centre);
        pivot.add(model);
        // The bare robot head can sit closer than a portrait with hair and shoulders.
        frameDistance = (frameHeight / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) * (look === "mesh" ? 1.1 : 1.3);
        resize();
        const robot = look === "mesh" ? toMeshNodes(model, frameHeight * 0.016) : null;

        const shapes = makeShapeSetter(model);
        // Eye nodes are named differently by different tools.
        const eyes = [
          ["eyeLeft", "LeftEye"],
          ["eyeRight", "RightEye"],
        ]
          .map((names) => names.map((name) => model.getObjectByName(name)).find((o) => o !== undefined))
          .filter((o) => o !== undefined);
        const eyeRest = eyes.map((eye) => eye.rotation.clone());
        setStatus("ready");

        const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const rimColor = new THREE.Color();
        let last = performance.now();
        let t = 0;
        let open = 0;
        let gazeX = 0;
        let gazeY = 0;
        let brow = 0;
        let turn = 0;
        let nod = 0;
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

          // Mouth: the jaw follows the speech level; the lips cycle through rounder and
          // wider shapes on top of it so it doesn't look like a hinge.
          energy.current *= Math.exp(-dt * 5);
          const flutter = 0.7 + 0.3 * Math.sin(t * 21);
          const target = s === "speaking" ? Math.min(1, energy.current * 1.3) * flutter : 0;
          open += (target - open) * ease(target > open ? 34 : 16);
          const round = 0.5 + 0.5 * Math.sin(t * 6.3);
          shapes.set("jawOpen", open * 0.5);
          shapes.set("funnel", open * 0.45 * round);
          shapes.set("pucker", open * 0.2 * round);
          shapes.set("lowerDownL", open * 0.35 * (1 - round));
          shapes.set("lowerDownR", open * 0.35 * (1 - round));
          shapes.set("upperUpL", open * 0.2 * (1 - round));
          shapes.set("upperUpR", open * 0.2 * (1 - round));
          // A faint resting smile that relaxes while she talks.
          const smile = 0.22 * (1 - open);
          shapes.set("smileL", smile);
          shapes.set("smileR", smile);

          if (now > nextBlink) {
            blinkStart = now;
            nextBlink = now + 2400 + Math.random() * 3600;
          }
          const phase = (now - blinkStart) / BLINK_MS;
          const lid = phase < 1 ? Math.sin(phase * Math.PI) : 0;
          shapes.set("blinkL", lid);
          shapes.set("blinkR", lid);

          // Gaze: up and away while thinking, a slow wander when idle.
          const wander = reducedMotion ? 0 : 1;
          const gazeTargetX = s === "thinking" ? -0.22 + 0.08 * Math.sin(t * 1.7) : s === "idle" ? 0.1 * Math.sin(t * 0.35) * wander : 0;
          const gazeTargetY = s === "thinking" ? -0.2 : 0;
          gazeX += (gazeTargetX - gazeX) * ease(6);
          gazeY += (gazeTargetY - gazeY) * ease(6);
          eyes.forEach((eye, i) => {
            eye.rotation.x = eyeRest[i].x + gazeY;
            eye.rotation.y = eyeRest[i].y + gazeX;
          });
          const lookUp = Math.max(0, -gazeY) * 2.5;
          shapes.set("lookUpL", lookUp);
          shapes.set("lookUpR", lookUp);

          const browTarget = s === "thinking" ? 0.55 : s === "listening" ? 0.4 : s === "speaking" ? open * 0.25 : 0;
          brow += (browTarget - brow) * ease(7);
          shapes.set("browUp", brow);
          shapes.set("browOuterL", brow * 0.5);
          shapes.set("browOuterR", brow * 0.5);

          // Head: a slow idle sway, a tilt toward the speaker, small nods with each word.
          const sway = reducedMotion ? 0 : Math.sin(t * 0.5);
          const turnTarget = s === "listening" ? 0.12 : s === "thinking" ? -0.14 : sway * 0.09;
          turn += (turnTarget - turn) * ease(2.5);
          nod += ((s === "speaking" ? open * 0.05 : 0) - nod) * ease(8);
          pivot.rotation.set(nod + (reducedMotion ? 0 : Math.sin(t * 0.37) * 0.02), turn, s === "listening" ? 0.04 : 0);

          rimColor.set(s === "thinking" ? themeRef.current.thinkB : themeRef.current.main);
          for (const rim of rims) rim.color.lerp(rimColor, ease(4));
          if (robot) {
            robot.wire.color.lerp(rimColor, ease(4));
            rimColor.set(s === "thinking" ? themeRef.current.thinkB : themeRef.current.bright);
            robot.nodes.color.lerp(rimColor, ease(4));
            robot.eye.color.lerp(rimColor, ease(4));
            // The lattice brightens with the voice.
            robot.wire.opacity = 0.3 + 0.35 * open;
          }

          renderer.render(scene, camera);
        };
        tick();
      })
      .catch((err) => {
        console.error(err);
        if (!disposed) setStatus("failed");
      });

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        mesh.geometry?.dispose();
        for (const material of [mesh.material].flat()) {
          if (!material) continue;
          (material as THREE.MeshStandardMaterial).map?.dispose();
          material.dispose();
        }
      });
      ktx2.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [energy, look]);

  // If the model can't be loaded, the drawn face stands in rather than leaving the ring empty.
  if (status === "failed") return <Face state={state} energy={energy} />;
  // A round window, so a full-body model reads as a portrait inside the rings.
  return (
    <div className="absolute aspect-square h-[88%] max-w-[88%] overflow-hidden rounded-full">
      <div ref={hostRef} className="absolute inset-0" />
      {status === "loading" && <p className="label absolute inset-0 flex items-center justify-center">Loading</p>}
    </div>
  );
}
