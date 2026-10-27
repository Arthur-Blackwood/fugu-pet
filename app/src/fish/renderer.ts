// Scene, render loop with adaptive frame rate, and raycast hit testing.
import * as THREE from 'three';
import { createFish, MODEL_SCALE } from './model';
import { createRig } from './rig';
import { createBubbles } from './particles';
import { createStates } from './states';
import { scaleOf } from './growth';
import { approach } from './rig';
import { settings, followRadius } from '../settings';

/** World units per CSS pixel. Fixed, so a bigger window shows more room, not a zoom:
 *  the default 280 px window spans 5.2 units (the fish is ~3.7 long incl. tail). */
const UNITS_PER_PX = 5.2 / 280;
/** Camera framing at the default 240 px window height; scales with the window. */
const BASE_H = 240;
const FLOOR_Y = -1.9;
/** How quickly the fish grows/shrinks toward its new size (1/s). */
const GROW_RATE = 2.2;
/** …while eating in play mode: it visibly grows as the file goes in. */
const GROW_RATE_EATING = 5;
const FOLLOW_TIMEOUT_MS = 3000;

export const FPS = { interactive: 60, idle: 30, sleep: 10 } as const;
/** Settings → Battery saver. */
const FPS_SAVER = { interactive: 30, idle: 15, sleep: 5 } as const;

export function createPet(canvas: HTMLCanvasElement, opts: { pauseWhenHidden: boolean }) {
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, premultipliedAlpha: true, powerPreference: 'low-power' });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 80);

  // Plain lights only: a PMREM environment renders black on some GPUs.
  // Soft, mostly-ambient light with a warm bounce from below: strong top light would
  // cancel the countershading (that's literally what countershading is for) and the
  // dark back / pale belly / spots would all read as one flat grey.
  const PI = Math.PI, DIR = 0.4 * PI;
  scene.add(new THREE.HemisphereLight(0xd6ecf2, 0xc2b8a3, 0.8 * PI));
  const addDir = (c: number, i: number, x: number, y: number, z: number) => {
    const l = new THREE.DirectionalLight(c, i * DIR); l.position.set(x, y, z); scene.add(l);
  };
  addDir(0xffffff, 0.45, 2, 0.5, 6);    // fill
  addDir(0xe8f6ff, 0.5, 0.5, 8, 1);     // top
  addDir(0xfff4e6, 1.3, -3, 5, 4);      // key
  addDir(0xbfe6ff, 0.9, 4, 2, -5);      // rim

  if (import.meta.env.DEV) (window as unknown as { __pet: unknown }).__pet = { renderer, scene, camera, THREE };
  const fish = createFish();
  scene.add(fish.group);
  const rig = createRig(fish);
  if (import.meta.env.DEV) Object.assign((window as unknown as { __pet: object }).__pet, { fish, rig });
  const bubbles = createBubbles(scene, fish.mouth, fish.group);
  const states = createStates(bubbles, reduceMotion);

  /* soft blob shadow (cheaper than real shadows) */
  const shadowTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d')!;
    const g = x.createRadialGradient(64, 64, 4, 64, 64, 62);
    g.addColorStop(0, 'rgba(0,0,0,0.55)'); g.addColorStop(0.5, 'rgba(0,0,0,0.22)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g; x.fillRect(0, 0, 128, 128); return new THREE.CanvasTexture(c);
  })();
  const shadowMat = new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false });
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), shadowMat);
  shadow.rotation.x = -Math.PI / 2; scene.add(shadow);

  /* ---------- pointer & hit testing ---------- */
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const planeLook = new THREE.Plane(new THREE.Vector3(0, 0, 1), -2.5);
  const pointer = { known: false, x: 0, y: 0, movedAt: 0 };
  const _c = new THREE.Vector3();

  /** Update the pointer from window-local CSS px (may lie outside the window). */
  function setPointer(x: number, y: number) {
    if (pointer.known && Math.abs(x - pointer.x) < 0.5 && Math.abs(y - pointer.y) < 0.5) return;
    pointer.known = true; pointer.x = x; pointer.y = y; pointer.movedAt = performance.now();
    ndc.set((x / canvas.clientWidth) * 2 - 1, -(y / canvas.clientHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    ray.ray.intersectPlane(planeLook, rig.lookWorld);
  }

  /** Is the window-local CSS point over the fish (body, eyes, fins)? */
  function hitAt(x: number, y: number) {
    if (x < 0 || y < 0 || x > canvas.clientWidth || y > canvas.clientHeight) return false;
    ndc.set((x / canvas.clientWidth) * 2 - 1, -(y / canvas.clientHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    fish.group.updateMatrixWorld();
    return ray.intersectObjects(fish.hitTargets, false).length > 0;
  }

  /** Fish size the window and model should have: belly growth × Settings size. */
  const targetScale = () => scaleOf(states.growth) * settings.size;

  /** Top-centre and bottom of the fish in window-local CSS px (for the speech bubble). */
  function fishExtent() {
    const s = stats.scale, half = (states.puffed ? 1.4 : 0.66) * MODEL_SCALE * s;
    const at = (dy: number) => {
      _c.copy(fish.group.position); _c.y += dy; _c.project(camera);
      return { x: (_c.x + 1) / 2 * canvas.clientWidth, y: (1 - _c.y) / 2 * canvas.clientHeight };
    };
    const top = at(half), bottom = at(-half);
    return { x: top.x, top: top.y, bottom: bottom.y };
  }

  /** Mouth position in window-local CSS px (play mode: where eaten files go). */
  const _m = new THREE.Vector3();
  function mouthScreen() {
    fish.group.updateMatrixWorld();
    fish.mouth.getWorldPosition(_m).project(camera);
    return { x: (_m.x + 1) / 2 * canvas.clientWidth, y: (1 - _m.y) / 2 * canvas.clientHeight };
  }

  /** Fish centre in window-local CSS px. */
  function fishScreen() {
    _c.copy(fish.group.position).project(camera);
    return { x: (_c.x + 1) / 2 * canvas.clientWidth, y: (1 - _c.y) / 2 * canvas.clientHeight };
  }

  /* ---------- sizing ---------- */
  function resize() {
    const w = Math.max(1, canvas.clientWidth), h = Math.max(1, canvas.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const halfH = (h * UNITS_PER_PX) / 2, k = h / BASE_H;
    camera.position.set(0, 0.2 * k, halfH / Math.tan(THREE.MathUtils.degToRad(15)));
    camera.lookAt(0, -0.15 * k, 0);
    camera.updateProjectionMatrix();
    bubbles.setCeiling(halfH - 0.15 * k - 0.15);
  }
  new ResizeObserver(resize).observe(canvas);
  resize();

  /* ---------- loop ---------- */
  const stats = { cap: FPS.idle as number, fps: 0, inflate: 0, scale: 1, bubbles: 0, bubblesPeak: 0 };
  /** Pointer over the fish: the skin eases a shade lighter. */
  let hoverTarget = 0, hover = 0;
  /** A springy size pop on top of growth (the swallow), as a fraction of size. */
  let swell = 0, swellV = 0;
  let externalBusy = () => false;
  let last = performance.now(), elapsed = 0, frames = 0, fpsT = last;

  function loop(now: number) {
    requestAnimationFrame(loop);
    if (opts.pauseWhenHidden && document.hidden) { last = now; return; } // occluded / hidden: 0 fps

    const recentPointer = now - pointer.movedAt < 2000;
    const growing = Math.abs(stats.scale - targetScale()) > 0.002 || Math.abs(hover - hoverTarget) > 0.01;
    const interactive = externalBusy() || growing || Math.abs(swell) > 0.002 || states.oneShot || recentPointer || states.microActive ||
      states.state === 'working' || states.state === 'ready' || states.state === 'drag' || bubbles.active();
    const fps = settings.batterySaver ? FPS_SAVER : FPS;
    stats.cap = states.state === 'sleep' ? fps.sleep : interactive ? fps.interactive : fps.idle;
    const since = now - last;
    if (since < 1000 / stats.cap - 1.5) return;
    const dt = Math.min(0.05, since / 1000); last = now; elapsed += dt;

    const fc = fishScreen();
    const radius = followRadius(settings); // Settings → Follow range
    const following = (settings.eyesFollow || settings.bodyFollow) && pointer.known && now - pointer.movedAt < FOLLOW_TIMEOUT_MS &&
      Math.hypot(pointer.x - fc.x, pointer.y - fc.y) < radius;
    const T = states.update(elapsed, dt, now, { following, dx: rig.lookWorld.x, dy: rig.lookWorld.y });
    const k = rig.step(T, elapsed, dt, now, states.state === 'sleep');
    stats.inflate = k;
    hover = approach(hover, hoverTarget, 14, dt);
    fish.uniforms.uHover.value = hover;

    // Growth: everything (offsets included) scales about the window centre.
    stats.scale = approach(stats.scale, targetScale(), states.eating ? GROW_RATE_EATING : GROW_RATE, dt);
    swellV += (-150 * swell - 9 * swellV) * dt; swell += swellV * dt; // bouncy spring back to 0
    const s = stats.scale * (1 + swell);
    fish.group.scale.setScalar(s * MODEL_SCALE);
    fish.group.position.multiplyScalar(s);

    const height = fish.group.position.y / s - FLOOR_Y;
    shadow.position.set(fish.group.position.x, FLOOR_Y * s, 0.2);
    const sw = (2.6 + k * 0.6) * (1 + height * 0.12) * s; shadow.scale.set(sw, sw * 0.42, 1);
    shadowMat.opacity = Math.max(0.1, 0.6 - height * 0.16);

    bubbles.update(dt, elapsed);
    stats.bubbles = bubbles.count(); stats.bubblesPeak = Math.max(stats.bubblesPeak, stats.bubbles);
    renderer.render(scene, camera);

    frames++;
    if (now - fpsT >= 500) { stats.fps = Math.round((frames * 1000) / (now - fpsT)); frames = 0; fpsT = now; }
  }
  requestAnimationFrame(loop);

  return {
    states, stats, setPointer, hitAt, fishScreen, fishExtent, mouthScreen,
    setHover(on: boolean) { hoverTarget = on && settings.hoverGlow ? 1 : 0; },
    /** Kick the size spring (e.g. 0.15 = a 15% pop that bounces back). */
    swell(amount: number) { swellV += amount * 16; },
    /** Size the window should be, relative to the default, so the fish fits. Never
     *  smaller than what's on screen, so shrinking happens before the window does. */
    windowScale() { return Math.max(stats.scale, targetScale()) * (states.eating ? 1.18 : 1); },
    /** Lets the host keep the frame rate up (e.g. while the window is being dragged). */
    setBusy(fn: () => boolean) { externalBusy = fn; },
  };
}

export type Pet = ReturnType<typeof createPet>;
