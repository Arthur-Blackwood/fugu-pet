import * as THREE from 'three';
import { MODEL_SCALE } from './model';
import { settings } from '../settings';

interface Bubble { m: THREE.Mesh; v: THREE.Vector3; life: number; max: number; size: number; ph: number }
export interface EmitOpts { jet?: number; size?: number; slow?: boolean }

/** Bursts bigger than this are released as a stream instead of all at once. */
const STREAM_OVER = 4;
/** Bubbles per second in a stream. */
const STREAM_RATE = 18;

const MAX_BUBBLES = 120;
/** Bubble sizes in EmitOpts are multiplied by this; at pet size the raw sizes are ~3 px. */
const SIZE_BOOST = 3.2;
/** Max rise speed, world units/s. */
const RISE_MAX = 1.0;

/** Air bubble: clear centre, bright rim, a highlight, and a faint dark edge so it reads
 *  on light and dark wallpapers alike. Normal blending — additive vanishes on a
 *  transparent window. */
function bubbleMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV;
      void main() {
        vec3 n = normalize(vN);
        float f = 1.0 - max(dot(n, normalize(vV)), 0.0);
        float rim = pow(f, 2.2);
        float edge = smoothstep(0.8, 0.97, f);
        float spec = pow(max(dot(n, normalize(vec3(-0.45, 0.6, 0.65))), 0.0), 36.0);
        vec3 col = mix(vec3(0.84, 0.94, 1.0), vec3(0.16, 0.24, 0.28), edge) + spec;
        gl_FragColor = vec4(min(col, 1.0), clamp(0.05 + 0.72 * rim + 0.9 * spec, 0.0, 1.0));
      }`,
  });
}

/** Pooled bubble particles emitted from the mouth. */
export function createBubbles(scene: THREE.Scene, mouth: THREE.Object3D, fish: THREE.Object3D) {
  const mat = bubbleMaterial();
  const geo = new THREE.SphereGeometry(1, 16, 12);
  const pool: Bubble[] = [];
  for (let i = 0; i < MAX_BUBBLES; i++) {
    const m = new THREE.Mesh(geo, mat); m.visible = false; scene.add(m);
    pool.push({ m, v: new THREE.Vector3(), life: 0, max: 1, size: 0.03, ph: Math.random() * 6 });
  }
  const _mw = new THREE.Vector3(), _fw = new THREE.Vector3();
  const streams: { left: number; acc: number; opt: EmitOpts }[] = [];
  /** World y of the window's top edge; bubbles pop before reaching it instead of being clipped. */
  let ceiling = Infinity;

  /** Emit n bubbles; large bursts trickle out as a stream so they read as "lots". */
  function emit(n: number, opt: EmitOpts = {}) {
    n = Math.round(n * settings.bubbles); // Settings → Bubbles (0 = none)
    if (n <= 0) return;
    if (n <= STREAM_OVER) { spawn(n, opt); return; }
    spawn(STREAM_OVER, opt);
    streams.push({ left: n - STREAM_OVER, acc: 0, opt });
  }

  function spawn(n: number, opt: EmitOpts) {
    mouth.getWorldPosition(_mw);
    _fw.set(1, 0, 0).applyQuaternion(fish.quaternion);
    const scale = fish.scale.x / MODEL_SCALE; // a grown fish blows bigger bubbles
    for (let i = 0; i < n; i++) {
      const b = pool.find((b) => !b.m.visible); if (!b) return;
      b.m.visible = true; b.life = 0; b.max = (opt.slow ? 4.5 : 3.0) + Math.random() * 1.0;
      b.size = (opt.size ?? 0.028) * (0.6 + Math.random() * 0.9) * scale * SIZE_BOOST;
      b.m.position.copy(_mw).addScaledVector(_fw, 0.06 * scale);
      const jet = opt.jet ?? 0.15;
      b.v.copy(_fw).multiplyScalar(jet * (0.6 + Math.random() * 0.8));
      b.v.x += (Math.random() - 0.5) * 0.15; b.v.y += 0.1 + Math.random() * 0.15; b.v.z += (Math.random() - 0.5) * 0.15;
      if (opt.slow) b.v.multiplyScalar(0.4);
    }
  }

  function update(dt: number, t: number) {
    for (let i = streams.length - 1; i >= 0; i--) {
      const st = streams[i];
      st.acc += dt * STREAM_RATE;
      const k = Math.min(st.left, Math.floor(st.acc));
      if (k > 0) { spawn(k, st.opt); st.left -= k; st.acc -= k; }
      if (st.left <= 0) streams.splice(i, 1);
    }
    for (const b of pool) {
      if (!b.m.visible) continue;
      b.life += dt; if (b.life > b.max) { b.m.visible = false; continue; }
      b.v.y = Math.min(b.v.y + 0.9 * dt, RISE_MAX); b.v.x *= 1 - 1.2 * dt; b.v.z *= 1 - 1.2 * dt;
      b.m.position.addScaledVector(b.v, dt); b.m.position.x += Math.sin(t * 5 + b.ph) * 0.002;
      const room = ceiling - b.m.position.y;
      if (room < 0.05) { b.m.visible = false; continue; }
      const fade = Math.min(1, b.life * 6) * Math.min(1, (b.max - b.life) * 3) * Math.min(1, room / 0.6);
      b.m.scale.setScalar(b.size * (0.8 + b.life * 0.25) * fade);
    }
  }

  const active = () => streams.length > 0 || pool.some((b) => b.m.visible);
  const count = () => pool.reduce((n, b) => n + (b.m.visible ? 1 : 0), 0);

  return { emit, update, active, count, setCeiling(y: number) { ceiling = y; } };
}

export type Bubbles = ReturnType<typeof createBubbles>;
