import { useEffect, useRef, useState, type RefObject } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { ModelSpec, OrbTheme } from "./orbStyle";
import type { OrbState } from "./useJarvis";

const DIR = `${import.meta.env.BASE_URL}models/custom/`;
const TWO_PI = Math.PI * 2;

/**
 * A character made from a plain 3D model with no face rig. It can't move a mouth, so it
 * speaks with its whole body: it bounces and stretches with the voice, leans in to
 * listen, and spins while thinking.
 */
export function Model3D({ spec, state, energy, theme }: { spec: ModelSpec; state: OrbState; energy: RefObject<number>; theme: OrbTheme }) {
  const { file, pitch = 0, yaw: facing = 0 } = spec;
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
    setStatus("loading");

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(26, 1, 0.01, 100);

    // A neutral studio environment gives metal and glossy parts something to reflect.
    const pmrem = new THREE.PMREMGenerator(renderer);
    const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = environment;
    scene.environmentIntensity = 0.9;

    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(1.5, 2, 3);
    scene.add(key);
    // Coloured back lights tie the model to the HUD and flare when it speaks.
    const rims = [-1, 1].map((side) => {
      const rim = new THREE.DirectionalLight(themeRef.current.main, 3);
      rim.position.set(side * 3, 1.2, -2.5);
      scene.add(rim);
      return rim;
    });

    const pivot = new THREE.Group();
    scene.add(pivot);
    let frameDistance = 1;
    let modelSize = 1;

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = host;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.position.set(0, 0, frameDistance * (w < h ? h / w : 1));
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    new GLTFLoader()
      .loadAsync(DIR + encodeURIComponent(file))
      .then(({ scene: model }) => {
        if (disposed) return;
        // Stand the model up and face it forward before measuring it.
        const upright = new THREE.Group();
        upright.rotation.set(pitch, facing, 0, "YXZ");
        upright.add(model);
        const box = new THREE.Box3().setFromObject(upright);
        const size = box.getSize(new THREE.Vector3());
        upright.position.sub(box.getCenter(new THREE.Vector3()));
        pivot.add(upright);
        // Fit the widest dimension, with room left over for the bounce and spin.
        modelSize = Math.max(size.x, size.y, size.z);
        frameDistance = (modelSize / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.5;
        resize();
        setStatus("ready");

        const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const rimColor = new THREE.Color();
        let last = performance.now();
        let t = 0;
        let open = 0;
        let yaw = 0;
        let lean = 0;

        const tick = () => {
          frame = requestAnimationFrame(tick);
          const now = performance.now();
          const dt = Math.min((now - last) / 1000, 0.1);
          last = now;
          t += dt;
          const s = stateRef.current;
          const ease = (rate: number) => 1 - Math.exp(-dt * rate);

          energy.current *= Math.exp(-dt * 5);
          const flutter = 0.7 + 0.3 * Math.sin(t * 21);
          const target = s === "speaking" ? Math.min(1, energy.current * 1.3) * flutter : 0;
          open += (target - open) * ease(target > open ? 34 : 14);

          // Turn: spin while thinking, face front to listen or talk, sway gently when idle.
          if (s === "thinking" && !reducedMotion) {
            yaw += dt * 2.4;
          } else {
            const front = Math.round(yaw / TWO_PI) * TWO_PI;
            const sway = s === "idle" && !reducedMotion ? Math.sin(t * 0.5) * 0.45 : 0;
            yaw += (front + sway - yaw) * ease(3);
          }
          lean += ((s === "listening" ? 0.16 : 0) - lean) * ease(4);

          const float = reducedMotion ? 0 : Math.sin(t * 1.3) * 0.02 * modelSize;
          pivot.position.y = float + open * 0.035 * modelSize;
          pivot.rotation.set(lean + open * 0.07, yaw, 0);
          // Squash and stretch with the voice.
          pivot.scale.set(1 - open * 0.035, 1 + open * 0.07, 1 - open * 0.035);

          rimColor.set(s === "thinking" ? themeRef.current.thinkB : themeRef.current.main);
          for (const rim of rims) {
            rim.color.lerp(rimColor, ease(4));
            rim.intensity = 3 + open * 9;
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
          for (const value of Object.values(material)) {
            if (value instanceof THREE.Texture) value.dispose();
          }
          material.dispose();
        }
      });
      environment.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [energy, file, pitch, facing]);

  return (
    <>
      <div ref={hostRef} className="absolute inset-0" />
      {status === "loading" && <p className="label absolute">Loading</p>}
      {status === "failed" && <p className="absolute max-w-[60%] text-center text-sm text-dim">Could not load {file} from models/custom.</p>}
    </>
  );
}
