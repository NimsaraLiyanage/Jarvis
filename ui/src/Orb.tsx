import { useEffect, useRef, type RefObject } from "react";
import * as THREE from "three";
import type { OrbState } from "./useJarvis";

interface Look {
  amp: number;
  freq: number;
  speed: number;
  a: THREE.Color;
  b: THREE.Color;
}

const LOOKS: Record<OrbState, Look> = {
  idle: { amp: 0.1, freq: 1.3, speed: 0.5, a: new THREE.Color("#2a6bff"), b: new THREE.Color("#5ee6ff") },
  listening: { amp: 0.17, freq: 1.6, speed: 0.9, a: new THREE.Color("#38d9ff"), b: new THREE.Color("#b6fbff") },
  thinking: { amp: 0.24, freq: 2.4, speed: 2.0, a: new THREE.Color("#ff6a3d"), b: new THREE.Color("#ffc861") },
  speaking: { amp: 0.14, freq: 1.8, speed: 1.1, a: new THREE.Color("#4c8dff"), b: new THREE.Color("#9af5ff") },
};

const STATE_LABEL: Record<OrbState, string> = {
  idle: "Standing by",
  listening: "Listening",
  thinking: "Processing",
  speaking: "Responding",
};

// Simplex 3D noise by Ian McEwan / Ashima Arts (MIT).
const NOISE_GLSL = /* glsl */ `
vec4 permute(vec4 x){ return mod(((x*34.0)+1.0)*x, 289.0); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + 2.0 * C.xxx;
  vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;
  i = mod(i, 289.0);
  vec4 p = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 1.0/7.0;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
`;

const VERTEX = /* glsl */ `
uniform float uTime;
uniform float uAmp;
uniform float uFreq;
uniform float uSize;
attribute float aSeed;
varying float vNoise;
${NOISE_GLSL}
void main() {
  vec3 dir = normalize(position);
  float n = snoise(dir * uFreq + vec3(0.0, uTime * 0.35, uTime * 0.2)) * 0.7
          + snoise(dir * uFreq * 2.3 - uTime * 0.5) * 0.3;
  vNoise = n;
  vec4 mv = modelViewMatrix * vec4(position + dir * n * uAmp, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * (0.6 + aSeed * 0.8) / -mv.z;
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uOpacity;
varying float vNoise;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float alpha = smoothstep(0.5, 0.0, d) * uOpacity;
  vec3 color = mix(uColorA, uColorB, smoothstep(-0.6, 0.8, vNoise));
  gl_FragColor = vec4(color, alpha);
}
`;

// Evenly spread points on a sphere (Fibonacci lattice).
function sphereGeometry(count: number, radius: number) {
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const theta = golden * i;
    positions[i * 3] = Math.cos(theta) * r * radius;
    positions[i * 3 + 1] = y * radius;
    positions[i * 3 + 2] = Math.sin(theta) * r * radius;
    seeds[i] = Math.random();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
  return geo;
}

function makeLayer(count: number, radius: number, opacity: number) {
  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uAmp: { value: LOOKS.idle.amp },
      uFreq: { value: LOOKS.idle.freq },
      uSize: { value: 8 },
      uOpacity: { value: opacity },
      uColorA: { value: LOOKS.idle.a.clone() },
      uColorB: { value: LOOKS.idle.b.clone() },
    },
  });
  return new THREE.Points(sphereGeometry(count, radius), material);
}

export function Orb({ state, energy }: { state: OrbState; energy: RefObject<number> }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const host = hostRef.current!;
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 20);
    camera.position.z = 4.2;

    const core = makeLayer(9000, 1, 0.85);
    const halo = makeLayer(900, 1.38, 0.45);
    scene.add(core, halo);
    const layers = [core, halo];

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = host;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      // Keep the whole orb in view when the pane is narrower than it is tall.
      camera.position.z = w < h ? 4.2 * (h / w) : 4.2;
      camera.updateProjectionMatrix();
      const size = h * renderer.getPixelRatio() * 0.02;
      for (const layer of layers) layer.material.uniforms.uSize.value = size;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let last = performance.now();
    let time = 0;
    let speed = LOOKS.idle.speed;
    let frame = 0;

    const tick = () => {
      frame = requestAnimationFrame(tick);
      const now = performance.now();
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const look = LOOKS[stateRef.current];
      const ease = 1 - Math.exp(-dt * 4);

      energy.current *= Math.exp(-dt * 5);
      speed += (look.speed - speed) * ease;
      time += dt * speed * (reducedMotion ? 0.2 : 1);

      // Tokens (typed chat) or live audio level (voice) make the orb swell.
      const reactive = stateRef.current === "speaking" || stateRef.current === "listening";
      const amp = look.amp + (reactive ? energy.current * 0.22 : 0);
      for (const layer of layers) {
        const u = layer.material.uniforms;
        u.uTime.value = time;
        u.uAmp.value += (amp - u.uAmp.value) * ease;
        u.uFreq.value += (look.freq - u.uFreq.value) * ease;
        u.uColorA.value.lerp(look.a, ease);
        u.uColorB.value.lerp(look.b, ease);
      }
      core.rotation.y = time * 0.25;
      halo.rotation.y = -time * 0.15;
      halo.rotation.x = time * 0.08;

      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      for (const layer of layers) {
        layer.geometry.dispose();
        layer.material.dispose();
      }
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [energy]);

  return (
    <div className="relative h-full w-full overflow-hidden">
      {/* Stage stops short of the bottom so the state label never sits on the orb. */}
      <div className="absolute inset-x-0 top-0 bottom-8 flex items-center justify-center">
        <svg
          viewBox="0 0 200 200"
          className="pointer-events-none absolute aspect-square h-[94%] max-w-[94%] text-accent"
          fill="none"
          stroke="currentColor"
          aria-hidden="true"
        >
          <circle cx="100" cy="100" r="97" strokeWidth="0.3" opacity="0.35" />
          <circle className="ring-cw" cx="100" cy="100" r="92" strokeWidth="1.2" strokeDasharray="60 14 6 14" opacity="0.7" />
          <circle className="ring-ccw" cx="100" cy="100" r="85" strokeWidth="0.5" strokeDasharray="2 5" opacity="0.6" />
          <circle className="ring-cw" cx="100" cy="100" r="79" strokeWidth="2" strokeDasharray="34 214" opacity="0.5" />
        </svg>
        <div ref={hostRef} className="absolute inset-0" />
      </div>
      <div className="label pointer-events-none absolute bottom-1 left-1/2 -translate-x-1/2 whitespace-nowrap" role="status">
        {STATE_LABEL[state]}
      </div>
    </div>
  );
}
