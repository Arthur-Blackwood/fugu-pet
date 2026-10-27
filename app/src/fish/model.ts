// Procedural silver-white pufferfish (Tetraodontidae), modelled on a reference plate:
// blunt rounded head, deepest at the pectoral fins, a body tapering into a slender
// caudal peduncle, a truncate tail; when inflated, a near-perfect ball covered in fine
// prickles with the tail stalk sticking out behind.
//
// The body is a UV sphere whose vertices are re-mapped by (t, θ): t ∈ [0, 1] runs
// from the snout tip (t = 0) to the end of the tail stalk (t = 1) along the sphere's
// latitude, θ goes round the body (0 = top, π = belly). Two shapes are baked —
// "lean" and "puff" — and `inflate` blends them.
// Coordinates: +x = snout, +y = back, ±z = flanks. Lean body ≈ 2.75 long (+ tail fin).
import * as THREE from 'three';
import { BODY_FRAG_HEAD, bodyFragColor, BODY_FRAG_NORMAL, BODY_FRAG_SHEEN } from './skin';

type Vec3Arr = [number, number, number];

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const smooth = (a: number, b: number, x: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
/** Quarter-ellipse rise from 0 to 1 over [0, span]: a rounded profile. */
const rise = (t: number, span: number) => { const u = 1 - Math.min(1, t / span); return Math.sqrt(Math.max(0, 1 - u * u)); };

/** Reference direction on the unit sphere for body coordinates (t, θ). */
export function refAt(t: number, theta: number) {
  const a = Math.PI * t;
  return new THREE.Vector3(Math.cos(a), Math.sin(a) * Math.cos(theta), Math.sin(a) * Math.sin(theta));
}

/* Landmarks, in body coordinates. */
const EYE_T = 0.185, EYE_TH = 0.9; // high on the side of the head, just behind the snout
const EYE_REF_L = refAt(EYE_T, EYE_TH);
const EYE_REF_R = refAt(EYE_T, -EYE_TH);
const PEC_T = 0.35, PEC_TH = Math.PI / 2 + 0.22; // mid-flank, a little below the midline
const GILL_REF_L = refAt(PEC_T - 0.035, PEC_TH);
const GILL_REF_R = refAt(PEC_T - 0.035, -PEC_TH);
/** Mouth: at the very tip of the blunt snout, below the eyes and above the belly. */
const MOUTH_REF = new THREE.Vector3(1, 0, 0);
/** Mouth size (lip ring radius, body units). */
const MOUTH_R = 0.14;
/** Small dorsal and anal fins, opposite each other just before the tail stalk. */
const DORSAL_REF = refAt(0.775, 0), ANAL_REF = refAt(0.785, Math.PI);

/* ---------- shape functions ---------- */
/** Raised eye orbits: the skin bulges a little around each eye. */
function orbit(x: number, y: number, z: number, k: number) {
  const dl = 1 - (x * EYE_REF_L.x + y * EYE_REF_L.y + z * EYE_REF_L.z);
  const dr = 1 - (x * EYE_REF_R.x + y * EYE_REF_R.y + z * EYE_REF_R.z);
  return 1 + 0.08 * (1 - 0.5 * k) * Math.exp(-Math.min(dl, dr) / 0.025);
}

function lean(t: number, c: number, s: number, o: Vec3Arr) {
  const X = 1.12 - 2.62 * t;
  // Top: a sloping forehead up to the nape; bottom: a rounder chin into a deep belly.
  // The ^0.8 makes the snout blunt, a little face for the mouth rather than a point.
  const top = rise(t, 0.24) ** 0.8, bot = rise(t, 0.14) ** 0.8, side = rise(t, 0.17) ** 0.8;
  const taper = 1 - 0.72 * smooth(0.32, 0.88, t);                    // into the tail stalk
  const end = t > 0.965 ? Math.sqrt(Math.max(0, 1 - ((t - 0.965) / 0.035) ** 2)) : 1;
  const belly = 1 + 0.14 * Math.sin(Math.PI * clamp01((t - 0.08) / 0.62));
  const nape = 1 + 0.05 * smooth(0.12, 0.3, t) * (1 - smooth(0.35, 0.7, t));
  const ht = 0.44 * top * taper * end * nape;
  const hb = 0.48 * bot * taper * end * belly;
  const w = 0.48 * side * taper * end * (1 + 0.06 * (1 - smooth(0.2, 0.5, t))); // broad head
  o[0] = X; o[1] = c >= 0 ? c * ht : c * hb; o[2] = s * w;
}

function puff(t: number, c: number, s: number, o: Vec3Arr) {
  const R = 1.2, XC = 0.02, T = 0.86, A = 0.93 * Math.PI;
  if (t <= T) {
    const a = (t / T) * A, r = R * Math.sin(a);
    o[0] = XC + R * Math.cos(a) * 0.97;
    o[1] = c * r * (c >= 0 ? 1 : 1.04); // a slightly heavier belly
    o[2] = s * r;
  } else {
    // the tail stalk sticks out of the back of the ball
    const u = (t - T) / (1 - T);
    const r0 = R * Math.sin(A);
    const r = (r0 + (0.12 - r0) * smooth(0, 0.6, u)) * (u > 0.75 ? Math.sqrt(Math.max(0, 1 - ((u - 0.75) / 0.25) ** 2)) : 1);
    o[0] = XC + R * Math.cos(A) * 0.97 - 0.45 * u;
    o[1] = c * r; o[2] = s * r;
  }
}

const _a: Vec3Arr = [0, 0, 0], _b: Vec3Arr = [0, 0, 0];
function deform(x: number, y: number, z: number, k: number, o: Vec3Arr) {
  const t = Math.acos(Math.max(-1, Math.min(1, x))) / Math.PI;
  const rho = Math.hypot(y, z);
  const c = rho > 1e-9 ? y / rho : 1, s = rho > 1e-9 ? z / rho : 0;
  lean(t, c, s, _a); puff(t, c, s, _b);
  const ob = orbit(x, y, z, k);
  for (let i = 0; i < 3; i++) o[i] = _a[i] + (_b[i] - _a[i]) * k;
  o[1] *= ob; o[2] *= ob;
}
const _p0: Vec3Arr = [0, 0, 0], _p1: Vec3Arr = [0, 0, 0], _p2: Vec3Arr = [0, 0, 0];
const _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3(), _u = new THREE.Vector3(), _v = new THREE.Vector3();
/** Surface normal of the deformed body at unit reference direction r. */
function normalAt(r: THREE.Vector3, k: number, out: THREE.Vector3) {
  const t1 = _t1.set(0, 1, 0); if (Math.abs(r.y) > 0.9) t1.set(1, 0, 0);
  t1.crossVectors(r, t1).normalize();
  const t2 = _t2.crossVectors(r, t1).normalize();
  const e = 0.002;
  deform(r.x, r.y, r.z, k, _p0);
  let ax = r.x + t1.x * e, ay = r.y + t1.y * e, az = r.z + t1.z * e; let l = Math.hypot(ax, ay, az);
  deform(ax / l, ay / l, az / l, k, _p1);
  ax = r.x + t2.x * e; ay = r.y + t2.y * e; az = r.z + t2.z * e; l = Math.hypot(ax, ay, az);
  deform(ax / l, ay / l, az / l, k, _p2);
  _u.set(_p1[0] - _p0[0], _p1[1] - _p0[1], _p1[2] - _p0[2]);
  _v.set(_p2[0] - _p0[0], _p2[1] - _p0[1], _p2[2] - _p0[2]);
  out.crossVectors(_u, _v).normalize();
  if (out.x * _p0[0] + out.y * _p0[1] + out.z * _p0[2] < 0) out.negate();
  return out;
}
function surfaceAt(r: THREE.Vector3, k: number, out: THREE.Vector3) {
  deform(r.x, r.y, r.z, k, _p0); return out.set(_p0[0], _p0[1], _p0[2]);
}

/* ---------- swimming body wave ----------
   A travelling sideways wave down the rear body: the head stays steady, the tail stalk
   swings most. Same formula in the vertex shader (WAG_GLSL) and for the fins riding on
   the body (wagAt), so they move together. */
const WAG_X0 = 0.3, WAG_SPAN = 1.85, WAG_K = 2.4;
const WAG_GLSL = /* glsl */ `
uniform float uWag; uniform float uWagPhase;
vec2 fuguWag(float x) { // sideways offset and its slope along x
  float b = clamp((${WAG_X0.toFixed(2)} - x) / ${WAG_SPAN.toFixed(2)}, 0.0, 1.0);
  float ph = uWagPhase - ${WAG_K.toFixed(2)} * b;
  float dz = uWag * b * b * sin(ph);
  float db = uWag * (2.0 * b * sin(ph) - b * b * ${WAG_K.toFixed(2)} * cos(ph));
  return vec2(dz, x < ${WAG_X0.toFixed(2)} && b < 1.0 ? -db / ${WAG_SPAN.toFixed(2)} : 0.0);
}
`;
function wagAt(x: number, amp: number, phase: number) {
  const b = Math.max(0, Math.min(1, (WAG_X0 - x) / WAG_SPAN)), ph = phase - WAG_K * b;
  const db = amp * (2 * b * Math.sin(ph) - b * b * WAG_K * Math.cos(ph));
  return { dz: amp * b * b * Math.sin(ph), slope: x < WAG_X0 && b < 1 ? -db / WAG_SPAN : 0 };
}

/* ---------- textures ---------- */
function canvasTex(size: number, draw: (x: CanvasRenderingContext2D, S: number) => void, srgb = true) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d')!, size);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
/** Front of the eyeball: golden-green iris with radial fibres, a big round pupil. */
function eyeTexture() {
  return canvasTex(512, (x, S) => {
    x.fillStyle = '#1c1a15'; x.fillRect(0, 0, S, S);
    const cx = S / 2, ir = S * 0.5 * 0.8, pr = ir * 0.46;
    const g = x.createRadialGradient(cx, cx, pr * 0.85, cx, cx, ir);
    g.addColorStop(0, '#e6cf7a'); g.addColorStop(0.3, '#c9a94c'); g.addColorStop(0.7, '#8f7a3a'); g.addColorStop(0.92, '#4a4024'); g.addColorStop(1, '#25211a');
    x.fillStyle = g; x.beginPath(); x.arc(cx, cx, ir, 0, Math.PI * 2); x.fill();
    for (let i = 0; i < 320; i++) {
      const a = Math.random() * Math.PI * 2, r0 = pr * (1 + Math.random() * 0.15), r1 = ir * (0.6 + Math.random() * 0.38);
      x.strokeStyle = Math.random() < 0.55 ? 'rgba(255,236,170,0.16)' : 'rgba(46,40,14,0.22)'; x.lineWidth = 0.8 + Math.random() * 1.4;
      x.beginPath(); x.moveTo(cx + Math.cos(a) * r0, cx + Math.sin(a) * r0); x.lineTo(cx + Math.cos(a) * r1, cx + Math.sin(a) * r1); x.stroke();
    }
    // a faint greenish sheen in the upper iris, a bright collarette round the pupil
    const gr = x.createRadialGradient(cx, cx - ir * 0.35, 0, cx, cx - ir * 0.35, ir * 0.8);
    gr.addColorStop(0, 'rgba(160,190,120,0.22)'); gr.addColorStop(1, 'rgba(160,190,120,0)');
    x.fillStyle = gr; x.beginPath(); x.arc(cx, cx, ir, 0, Math.PI * 2); x.fill();
    x.strokeStyle = 'rgba(250,230,160,0.55)'; x.lineWidth = S * 0.012; x.beginPath(); x.arc(cx, cx, pr * 1.06, 0, Math.PI * 2); x.stroke();
    x.strokeStyle = 'rgba(12,10,6,0.9)'; x.lineWidth = S * 0.022; x.beginPath(); x.arc(cx, cx, ir - S * 0.011, 0, Math.PI * 2); x.stroke();
    x.fillStyle = '#040403'; x.beginPath(); x.arc(cx, cx, pr, 0, Math.PI * 2); x.fill();
  });
}
/** Fin membrane: pale and translucent, with segmented, branching rays. `dusky` darkens
 *  the margin (the tail fin). v = 0 at the fin's base (canvas bottom), 1 at its edge. */
function finTexture(dusky: boolean) {
  return canvasTex(256, (x, S) => {
    const g = x.createLinearGradient(0, S, 0, 0);
    g.addColorStop(0, 'rgba(150,140,100,0.95)'); g.addColorStop(0.3, 'rgba(192,180,130,0.75)');
    g.addColorStop(0.8, 'rgba(212,202,160,0.52)'); g.addColorStop(1, 'rgba(222,214,180,0.4)');
    x.fillStyle = g; x.fillRect(0, 0, S, S);
    if (dusky) {
      const d = x.createLinearGradient(0, S * 0.3, 0, 0);
      d.addColorStop(0, 'rgba(60,64,62,0)'); d.addColorStop(0.7, 'rgba(60,64,62,0.55)'); d.addColorStop(1, 'rgba(40,42,40,0.8)');
      x.fillStyle = d; x.fillRect(0, 0, S, S * 0.3);
    }
    for (let i = 6; i < S; i += 12) {
      const top = S * 0.03, fork = S * (0.35 + Math.random() * 0.1);
      x.strokeStyle = 'rgba(80,70,44,0.8)'; x.lineWidth = 1.6;
      x.beginPath(); x.moveTo(i, S); x.lineTo(i, fork); x.stroke();
      x.lineWidth = 1.1; // rays branch toward the edge
      x.beginPath(); x.moveTo(i, fork); x.lineTo(i - 2.5, top); x.moveTo(i, fork); x.lineTo(i + 2.5, top); x.stroke();
      for (let j = S * 0.2; j < S * 0.95; j += 14 + Math.random() * 8) {
        x.strokeStyle = 'rgba(110,100,76,0.3)'; x.beginPath(); x.moveTo(i - 2, j); x.lineTo(i + 2, j); x.stroke();
      }
    }
  });
}

/* ---------- fins ---------- */
interface FinOpts { len: number; h: number; nu?: number; nv?: number; flare?: number; sweep?: number; prof: (u: number) => number }
function makeFinGeo(o: FinOpts) {
  const { len, h, nu = 18, nv = 10, flare = 0, sweep = 0, prof } = o;
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let j = 0; j <= nv; j++) {
    const v = j / nv;
    for (let i = 0; i <= nu; i++) {
      const u = i / nu, pr = prof(u);
      pos.push((u - 0.5) * len * (1 + flare * v) + sweep * v * pr, v * h * pr, 0); uv.push(u, v);
    }
  }
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1; idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry(); g.setIndex(idx);
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals(); g.userData.uv = Float32Array.from(uv);
  return g;
}
/** Travelling sine wave across a fin, amplitude growing toward the fin's free edge. */
export function waveFin(g: THREE.BufferGeometry, t: number, amp: number, freq: number, k: number, ph: number) {
  const p = g.attributes.position.array as Float32Array, uv = g.userData.uv as Float32Array, n = p.length / 3;
  for (let i = 0; i < n; i++) {
    const u = uv[i * 2], v = uv[i * 2 + 1];
    p[i * 3 + 2] = amp * Math.pow(v, 1.3) * Math.sin(t * freq * 6.2832 - u * k + ph);
  }
  g.attributes.position.needsUpdate = true; g.computeVertexNormals();
}

export interface Fin { geo: THREE.BufferGeometry; ref: THREE.Vector3; pivot: THREE.Object3D; mesh: THREE.Mesh; base: THREE.Vector3 }
export type FinName = 'dorsal' | 'anal' | 'caudal' | 'pecL' | 'pecR';
export interface Eye extends THREE.Object3D { userData: { ref: THREE.Vector3; n: THREE.Vector3; ball: THREE.Mesh } }

export const EYE_R = 0.14;
/** The model is built at a realistic, slimmer scale; this brings it up to the on-screen
 *  size the window is framed for. Applied by the renderer on top of growth. */
export const MODEL_SCALE = 1.2;

export function createFish() {
  const group = new THREE.Group(); group.rotation.order = 'YZX';

  /* body: bake both morph targets once, blend per frame */
  const sphere = new THREE.SphereGeometry(1, 170, 140);
  sphere.rotateZ(-Math.PI / 2); // poles -> head / tail
  sphere.rotateX(Math.PI);
  const vCount = sphere.attributes.position.count;
  const ref = Float32Array.from(sphere.attributes.position.array as Float32Array);
  const P0 = new Float32Array(vCount * 3), P1 = new Float32Array(vCount * 3), N0 = new Float32Array(vCount * 3), N1 = new Float32Array(vCount * 3);
  {
    const r = new THREE.Vector3(), n = new THREE.Vector3(), o: Vec3Arr = [0, 0, 0];
    for (let i = 0; i < vCount; i++) {
      r.set(ref[i * 3], ref[i * 3 + 1], ref[i * 3 + 2]).normalize();
      deform(r.x, r.y, r.z, 0, o); P0.set(o, i * 3);
      normalAt(r, 0, n); N0[i * 3] = n.x; N0[i * 3 + 1] = n.y; N0[i * 3 + 2] = n.z;
      deform(r.x, r.y, r.z, 1, o); P1.set(o, i * 3);
      normalAt(r, 1, n); N1[i * 3] = n.x; N1[i * 3 + 1] = n.y; N1[i * 3 + 2] = n.z;
    }
  }
  const bodyGeo = new THREE.BufferGeometry();
  bodyGeo.setIndex(sphere.index);
  bodyGeo.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(P0), 3));
  bodyGeo.setAttribute('normal', new THREE.BufferAttribute(Float32Array.from(N0), 3));
  bodyGeo.setAttribute('aRef', new THREE.BufferAttribute(ref, 3));
  bodyGeo.computeBoundingSphere();
  sphere.dispose();

  const uniforms = {
    uTime: { value: 0 }, uGill: { value: 0.5 }, uTone: { value: 1 }, uHover: { value: 0 }, uAngry: { value: 0 }, uDim: { value: 0 },
    uInflate: { value: 0 }, uWag: { value: 0 }, uWagPhase: { value: 0 },
    uEyeL: { value: EYE_REF_L.clone() }, uEyeR: { value: EYE_REF_R.clone() },
  };
  const bodyMat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.42, metalness: 0, clearcoat: 0.55, clearcoatRoughness: 0.28, specularIntensity: 0.8 });
  const colorCode = bodyFragColor({ gillT: PEC_T - 0.035, gillA: PEC_TH, pecT: PEC_T, pecA: PEC_TH });
  bodyMat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = 'attribute vec3 aRef;\nvarying vec3 vRef;\n' + WAG_GLSL +
      sh.vertexShader
        .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n vec2 wag = fuguWag(position.x);\n objectNormal = normalize(vec3(objectNormal.x - wag.y * objectNormal.z, objectNormal.yz));')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n vRef = aRef;\n transformed.z += wag.x;');
    sh.fragmentShader = BODY_FRAG_HEAD + sh.fragmentShader
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + colorCode)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = clamp(roughnessFactor + gRough, 0.05, 1.0);')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + BODY_FRAG_NORMAL)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + BODY_FRAG_SHEEN);
  };
  const body = new THREE.Mesh(bodyGeo, bodyMat); group.add(body);

  /* eyes: iris ball + additive clearcoat cornea; no eyelids, so no blinking */
  const eyeG = new THREE.SphereGeometry(EYE_R, 48, 32);
  {
    const p = eyeG.attributes.position, uv = eyeG.attributes.uv;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i) / EYE_R, y = p.getY(i) / EYE_R, z = p.getZ(i);
      if (z >= 0) uv.setXY(i, x * 0.5 + 0.5, y * 0.5 + 0.5);
      else { const l = Math.hypot(x, y) || 1; uv.setXY(i, 0.5 + 0.499 * x / l, 0.5 + 0.499 * y / l); }
    }
    uv.needsUpdate = true;
  }
  const eyeTex = eyeTexture(); eyeTex.anisotropy = 4;
  const eyeMat = new THREE.MeshPhysicalMaterial({ map: eyeTex, roughness: 0.4, metalness: 0 });
  const corneaMat = new THREE.MeshPhysicalMaterial({ color: 0x000000, roughness: 0.04, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.02, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const corneaG = new THREE.SphereGeometry(EYE_R * 1.04, 40, 28);
  const makeEye = (refV: THREE.Vector3): Eye => {
    const pivot = new THREE.Object3D() as Eye;
    const ball = new THREE.Mesh(eyeG, eyeMat); ball.add(new THREE.Mesh(corneaG, corneaMat));
    pivot.add(ball); group.add(pivot);
    pivot.userData = { ref: refV, n: new THREE.Vector3(), ball };
    return pivot;
  };
  const eyes = [makeEye(EYE_REF_L), makeEye(EYE_REF_R)];

  /* mouth: soft lips around a puffer's beak (fused tooth plates, upper and lower) and
     a dark red mouth cavity. Built facing +z in `face`, which is turned to point along
     the mouth group's +x; the group is aimed along the snout's surface normal in
     applyInflate. */
  const mouth = new THREE.Group(); group.add(mouth);
  const face = new THREE.Group(); face.rotation.y = Math.PI / 2; mouth.add(face);
  const R = MOUTH_R;
  const cavity = new THREE.Mesh(new THREE.CircleGeometry(R * 0.9, 32), new THREE.MeshBasicMaterial({ color: 0x3a0f0c }));
  const throat = new THREE.Mesh(new THREE.CircleGeometry(R * 0.5, 24), new THREE.MeshBasicMaterial({ color: 0x120404 }));
  throat.position.z = 0.001;
  const toothMat = new THREE.MeshPhysicalMaterial({ color: 0xf2eadb, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.15, side: THREE.DoubleSide });
  const TOOTH_IN = 0.62; // tooth plates: a crescent just inside the lips
  // Upper and lower plates cover only the top / bottom arcs, so the open mouth shows
  // two tooth plates with dark corners, not a white ring.
  const ARC = 0.42; // radians left open at each corner
  const upperTeeth = new THREE.Mesh(new THREE.RingGeometry(R * TOOTH_IN, R * 0.92, 32, 1, ARC, Math.PI - 2 * ARC), toothMat);
  const lowerTeeth = new THREE.Mesh(new THREE.RingGeometry(R * TOOTH_IN, R * 0.92, 32, 1, Math.PI + ARC, Math.PI - 2 * ARC), toothMat);
  upperTeeth.position.z = lowerTeeth.position.z = 0.003;
  // Lips: a flattened ring, a soft raised pucker rather than a washer on the nose.
  const lips = new THREE.Mesh(
    new THREE.TorusGeometry(R, 0.042, 18, 48),
    new THREE.MeshPhysicalMaterial({ color: 0xb59a8e, roughness: 0.38, clearcoat: 0.8, clearcoatRoughness: 0.2, sheen: 0.5, sheenColor: new THREE.Color(0xffe0d4) }),
  );
  lips.position.z = 0.004;
  face.add(cavity, throat, upperTeeth, lowerTeeth, lips);
  /** 0 = closed (the two tooth plates meet: a white beak between the lips), 1 = wide open. */
  function setMouth(open: number) {
    const o = Math.max(0, Math.min(1.2, open));
    const sy = 0.46 + 0.78 * o; // the opening's height
    lips.scale.set(1 + 0.08 * o, 0.52 + 0.72 * o, 0.45);
    cavity.scale.set(1, sy, 1);
    throat.scale.set(1, sy * 0.9, 1);
    upperTeeth.scale.set(1, sy, 1);
    lowerTeeth.scale.set(1, sy, 1);
    // closed: plates slide together until their inner edges meet in the middle
    const meet = R * TOOTH_IN * sy * (1 - Math.min(1, o)) * 0.97;
    upperTeeth.position.y = -meet;
    lowerTeeth.position.y = meet;
  }
  setMouth(0);

  /* fins: small dorsal and anal fins far back, opposite each other; rounded pectorals
     behind the gill slits; a broad, nearly straight-edged tail fin on the stalk */
  const finMat = new THREE.MeshPhysicalMaterial({ map: finTexture(false), transparent: true, side: THREE.DoubleSide, roughness: 0.4, metalness: 0, clearcoat: 0.35, depthWrite: false });
  const tailMat = finMat.clone(); tailMat.map = finTexture(true);
  const dorsalProf = (u: number) => Math.pow(Math.sin(Math.PI * (0.04 + 0.92 * u)), 0.7) * (0.4 + 0.6 * u);
  const pecProf = (u: number) => 0.55 + 0.45 * Math.sin(Math.PI * u);
  const finSpecs: Record<FinName, { geo: THREE.BufferGeometry; ref: THREE.Vector3 }> = {
    dorsal: { geo: makeFinGeo({ len: 0.26, h: 0.4, flare: 0.3, sweep: -0.26, prof: dorsalProf }), ref: DORSAL_REF },
    anal: { geo: makeFinGeo({ len: 0.24, h: 0.36, flare: 0.3, sweep: -0.24, prof: dorsalProf }), ref: ANAL_REF },
    caudal: { geo: makeFinGeo({ len: 0.2, h: 0.44, nu: 22, nv: 12, flare: 1.75, prof: (u) => 0.9 + 0.1 * Math.sin(Math.PI * u) }), ref: new THREE.Vector3(-1, 0, 0) },
    pecL: { geo: makeFinGeo({ len: 0.2, h: 0.34, flare: 0.9, prof: pecProf }), ref: refAt(PEC_T, PEC_TH) },
    pecR: { geo: makeFinGeo({ len: 0.2, h: 0.34, flare: 0.9, prof: pecProf }), ref: refAt(PEC_T, -PEC_TH) },
  };
  const fins = {} as Record<FinName, Fin>;
  for (const key of Object.keys(finSpecs) as FinName[]) {
    const s = finSpecs[key];
    const pivot = new THREE.Object3D(), mesh = new THREE.Mesh(s.geo, key === 'caudal' ? tailMat : finMat);
    pivot.add(mesh); group.add(pivot);
    fins[key] = { ...s, pivot, mesh, base: new THREE.Vector3() };
  }
  fins.anal.mesh.rotation.x = Math.PI;
  fins.caudal.mesh.rotation.z = Math.PI / 2;
  fins.pecL.mesh.rotation.z = Math.PI / 2;
  fins.pecR.mesh.rotation.z = Math.PI / 2;

  /* spines: fine prickles all over the ball, lying flat against the skin until it
     inflates. None on the snout, the tail stalk, or around the eyes, gills and fins. */
  const spineRefs: THREE.Vector3[] = [];
  {
    const N = 2300, ga = Math.PI * (3 - Math.sqrt(5));
    const avoid: [THREE.Vector3, number][] = [
      [EYE_REF_L, 0.26], [EYE_REF_R, 0.26], [fins.pecL.ref, 0.17], [fins.pecR.ref, 0.17], [GILL_REF_L, 0.12], [GILL_REF_R, 0.12],
    ];
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2, r = Math.sqrt(1 - y * y), th = ga * i;
      const v = new THREE.Vector3(y, Math.sin(th) * r, Math.cos(th) * r); // x is the long axis
      const t = Math.acos(v.x) / Math.PI, a = Math.abs(Math.atan2(v.z, v.y));
      if (t < 0.07 || t > 0.8) continue;
      if (t > 0.6 && (a < 0.3 || a > Math.PI - 0.3)) continue; // dorsal / anal fin bases
      if (avoid.some(([c, d]) => v.distanceTo(c) < d)) continue;
      spineRefs.push(v);
    }
  }
  // per-spine lean / puff position and normal, blended like the body
  const spineBake = spineRefs.map((r) => ({
    s0: surfaceAt(r, 0, new THREE.Vector3()), s1: surfaceAt(r, 1, new THREE.Vector3()),
    n0: normalAt(r, 0, new THREE.Vector3()).clone(), n1: normalAt(r, 1, new THREE.Vector3()).clone(),
    len: 0.8 + 0.4 * Math.random(),
  }));
  const spineGeo = new THREE.ConeGeometry(0.0095, 0.085, 5, 1); spineGeo.translate(0, 0.0425, 0);
  const spines = new THREE.InstancedMesh(spineGeo, new THREE.MeshStandardMaterial({ color: 0xe6e1d3, roughness: 0.42 }), spineRefs.length);
  group.add(spines);

  /* attach parts to the deforming surface */
  const _s = new THREE.Vector3(), _n = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4(), _sc = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 1, 0), _dir = new THREE.Vector3(), _back = new THREE.Vector3(), _minusX = new THREE.Vector3(-1, 0, 0);
  const _x = new THREE.Vector3(1, 0, 0);
  let lastK = -1;
  function applyInflate(k: number) {
    if (Math.abs(k - lastK) < 0.0008) return; lastK = k;
    uniforms.uInflate.value = k;
    const P = bodyGeo.attributes.position.array as Float32Array, N = bodyGeo.attributes.normal.array as Float32Array;
    for (let i = 0, l = vCount * 3; i < l; i++) { P[i] = P0[i] + (P1[i] - P0[i]) * k; N[i] = N0[i] + (N1[i] - N0[i]) * k; }
    bodyGeo.attributes.position.needsUpdate = true; bodyGeo.attributes.normal.needsUpdate = true; bodyGeo.computeBoundingSphere();
    for (const e of eyes) { const d = e.userData; surfaceAt(d.ref, k, _s); normalAt(d.ref, k, d.n); e.position.copy(_s).addScaledVector(d.n, -EYE_R * 0.4); }
    // on the skin (a hair proud of it, so the curved snout doesn't swallow the
    // cavity and beak), facing straight out of the snout
    surfaceAt(MOUTH_REF, k, _s); normalAt(MOUTH_REF, k, _n);
    mouth.position.copy(_s).addScaledVector(_n, 0.004);
    mouth.quaternion.setFromUnitVectors(_x, _n);
    for (const key of Object.keys(fins) as FinName[]) {
      const f = fins[key]; surfaceAt(f.ref, k, _s); normalAt(f.ref, k, _n);
      f.base.copy(_s).addScaledVector(_n, key === 'caudal' ? -0.01 : -0.03);
      f.pivot.position.copy(f.base);
    }
    // the dorsal and anal fins stand straight out of the sloping back / belly
    normalAt(DORSAL_REF, k, _n); fins.dorsal.pivot.rotation.z = Math.atan2(-_n.x, _n.y);
    normalAt(ANAL_REF, k, _n); fins.anal.pivot.rotation.z = Math.atan2(_n.x, -_n.y);
    const sk = Math.min(1, Math.max(0, (k - 0.22) / 0.6)), s = sk * sk * (3 - 2 * sk);
    spines.visible = s > 0.01;
    if (spines.visible) {
      for (let i = 0; i < spineBake.length; i++) {
        const b = spineBake[i];
        _s.lerpVectors(b.s0, b.s1, k); _n.lerpVectors(b.n0, b.n1, k).normalize();
        _back.copy(_minusX).addScaledVector(_n, -_n.dot(_minusX)).normalize();
        const tilt = (1 - s) * 1.3 + 0.1;
        _dir.copy(_n).multiplyScalar(Math.cos(tilt)).addScaledVector(_back, Math.sin(tilt)).normalize();
        _q.setFromUnitVectors(_up, _dir); _sc.set(0.4 + 0.6 * s, (0.15 + 0.85 * s) * b.len, 0.4 + 0.6 * s);
        _m.compose(_s.addScaledVector(_n, -0.008), _q, _sc); spines.setMatrixAt(i, _m);
      }
      spines.instanceMatrix.needsUpdate = true;
    }
  }
  applyInflate(0);

  /** Body wave while swimming (amp in body units, ~0.1). The rear fins ride on it;
   *  returns the tail fin's extra yaw so the rig can add its own flick on top. */
  function applyWag(amp: number, phase: number) {
    // an inflated ball doesn't bend
    const k = uniforms.uInflate.value, a = amp * Math.max(0, 1 - k / 0.35);
    uniforms.uWag.value = a; uniforms.uWagPhase.value = phase;
    for (const key of ['dorsal', 'anal', 'caudal'] as const) {
      const f = fins[key], w = wagAt(f.base.x, a, phase);
      f.pivot.position.set(f.base.x, f.base.y, f.base.z + w.dz);
      if (key !== 'caudal') f.pivot.rotation.y = -Math.atan(w.slope);
      else return -Math.atan(w.slope);
    }
    return 0;
  }

  /** Meshes that count as "on the fish" for click-through hit testing. */
  const hitTargets: THREE.Object3D[] = [body, eyes[0].userData.ball, eyes[1].userData.ball, ...Object.values(fins).map((f) => f.mesh)];

  return { group, body, eyes, mouth, setMouth, fins, finMat, finMats: [finMat, tailMat], spines, uniforms, applyInflate, applyWag, hitTargets };
}

export type Fish = ReturnType<typeof createFish>;
