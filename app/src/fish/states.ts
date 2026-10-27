// Behaviour state machine. Each state only produces target parameters; the rig
// handles all blending. One-shot states return to the last persistent state.
import { BASE_YAW, defaultTargets, type Targets } from './rig';
import type { Bubbles } from './particles';
import { growthOf } from './growth';
import { settings } from '../settings';

export type PersistentState = 'idle' | 'working' | 'sleep' | 'ready' | 'drag' | 'swim' | 'eat';
export type OneShotState = 'catch' | 'happy' | 'spit' | 'puff' | 'error' | 'wake' | 'nudge' | 'settle' | 'tidy' | 'angry' | 'gulp';
export type State = PersistentState | OneShotState;

/** Durations of one-shot states, in seconds. */
/** `tidy` ends itself once all its gulps are done. */
const ONE_SHOT: Record<OneShotState, number> = { catch: 0.85, happy: 1.5, spit: 0.65, puff: 3.4, error: 1.7, wake: 0.9, nudge: 0.8, settle: 1.0, tidy: 99, angry: 1.9, gulp: 0.85 };
const isOneShot = (s: string): s is OneShotState => s in ONE_SHOT;

const WORKING_DEMO_MS = 3800;
/** Tidy plays one quick gulp per file, up to this many. */
const TIDY_MAX_GULPS = 6;
const TIDY_GULP_S = 0.35;

export interface HeldFile { id?: number; name: string; path?: string; /** bytes (folders: recursive total) */ size: number }

/** Pointer info the states need, in world units relative to the fish. */
export interface PointerCtx { following: boolean; dx: number; dy: number }

const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
const clampAbs = (v: number, m: number) => Math.max(-m, Math.min(m, v));
/** Yaw offset that points the nose along horizontal heading h ∈ [-1, 1] while still
 *  turned toward the viewer: 1 = the default ¾ view to the right, 0 = head-on (total
 *  yaw −π/2), −1 = the mirrored ¾ view to the left. */
export const headingYaw = (h: number) => (Math.PI / 2 + BASE_YAW) * (h - 1);

export function createStates(bubbles: Bubbles, reduceMotion: boolean) {
  let state: State = 'idle', persist: PersistentState = 'idle', queued: OneShotState | null = null;
  let stateT = 0;
  let lastActivity = performance.now(), workingUntil = 0;
  let catchDone = false, spitDone = false, jetDone = false;
  let pokeSide = 1;
  let micro: { type: 'turn' | 'rise' | 'bubble'; t0: number } | null = null;
  let nextMicro = performance.now() + 9000;
  const holding: HeldFile[] = [];
  const pendingCatch: HeldFile[] = [];
  /** Specific items to let out on the next spit (empty: the last one). */
  let pendingSpit: HeldFile[] = [];
  let tidyGulps = 0;
  /** Double-click puff: held until the next double-click, layered over any state. */
  let puffHeld = false, panelPuff = false, panelDim = false, deflateUntil = 0;
  /** Play mode: face a given way (h ∈ [-1, 1], see headingYaw) until headingUntil. */
  let headingH = 1, headingUntil = 0;
  /** Play mode swimming: the window's velocity (screen px/s, smoothed) and which way it faces. */
  const swimV = { x: 0, y: 0, tx: 0, ty: 0 };
  let swimFacing = 1;
  /** Play mode eating: 'open' (mouth wide) → 'suck' (file being drawn in) → chomp. */
  let eatPhase: 'none' | 'open' | 'suck' = 'none', suckT0 = 0, suckMs = 700;
  /** A real task is running; 'working' lasts until finishWork instead of a demo timer. */
  let realWork = false;
  let bellyBytes = 0;
  let nextBelch = performance.now() + 5000;
  const recount = () => { bellyBytes = holding.reduce((sum, f) => sum + f.size, 0); };
  /** Bubble burst size for swallowing / spitting `bytes`: a few for a text file, a stream for gigabytes. */
  const burst = (bytes: number) => (reduceMotion ? 2 : 2 + Math.round(18 * growthOf(bytes)));

  function enter(s: State) {
    state = s; stateT = 0; catchDone = spitDone = jetDone = false;
    if (s === 'happy') bubbles.emit(reduceMotion ? 3 : 9, { jet: 0.25 });
    if (s === 'working') workingUntil = realWork ? Infinity : performance.now() + WORKING_DEMO_MS;
    lastActivity = performance.now();
  }

  function set(s: State) {
    if (state === 'sleep' && s !== 'sleep' && s !== 'drag' && s !== 'wake') {
      // wake up first, then play whatever was asked for
      persist = isOneShot(s) ? 'idle' : s;
      if (isOneShot(s)) queued = s;
      enter('wake');
      return;
    }
    if (!isOneShot(s)) persist = s;
    enter(s);
  }

  function endOneShot() {
    if (queued) { const q = queued; queued = null; enter(q); return; }
    enter(persist);
  }

  // Belly roundness follows how much is inside, capped well below a full puff so it
  // never looks like the disk-full alarm.
  const holdInflate = () => (holding.length === 0 ? 0 : 0.06 + 0.29 * growthOf(bellyBytes));

  /** Swallow files: they enter the belly midway through the catch animation. */
  function feed(files: HeldFile[]) {
    pendingCatch.push(...files);
    persist = 'idle';
    set('catch');
  }
  function spit() { if (holding.length) { pendingSpit = []; set('spit'); } }
  /** Items left the belly elsewhere (dragged out of the panel, removed, tray). */
  function spitIds(ids: number[]) {
    const out = holding.filter((f) => f.id !== undefined && ids.includes(f.id));
    if (!out.length) return;
    pendingSpit = out;
    set('spit');
  }
  /** Load the persisted belly without animating. */
  function restore(items: HeldFile[]) { holding.splice(0, holding.length, ...items); recount(); }
  /** A real task started / finished (as opposed to the tray's timed demo). */
  function startWork() { realWork = true; set('working'); }
  function finishWork(ok: boolean) { realWork = false; persist = 'idle'; set(ok ? 'happy' : 'error'); }
  /** Puffed by a double-click, or while the panel shows the Belly tab. */
  const puffed = () => puffHeld || panelPuff;
  function setPuff(held: boolean, panel: boolean) {
    const was = puffed();
    puffHeld = held; panelPuff = panel;
    if (was && !puffed()) {
      deflateUntil = performance.now() + 1100; // let the spring bounce on the way down
      bubbles.emit(12, { jet: 1.1, size: 0.032 });
    }
    lastActivity = performance.now();
  }
  function togglePuff() { setPuff(!puffHeld, panelPuff); }
  /** What the panel is showing: Belly puffs the fish up, Settings dims it. */
  function panelView(view: string) {
    if (view === 'belly' && state === 'sleep') set('idle');
    setPuff(puffHeld, view === 'belly');
    panelDim = view === 'settings';
  }
  /** Keep facing horizontal heading h for a while (play mode). */
  function face(h: number, ms: number) { headingH = h; headingUntil = performance.now() + ms; }
  /** The window is about to be moved by (dx, dy) screen px: swim that way. */
  function swimStart(dx: number, dy: number) {
    if (Math.abs(dx) > 8) swimFacing = Math.sign(dx);
    const was = state === 'swim';
    persist = 'swim';
    if (!was) {
      set('swim');
      // the first kick: a puff of bubbles from the gills
      if (!reduceMotion && Math.hypot(dx, dy) > 60) bubbles.emit(3, { size: 0.02, jet: 0.2 });
    }
  }
  /** Live velocity of the swim (screen px/s; y down). */
  function swimVel(vx: number, vy: number) { swimV.tx = vx; swimV.ty = vy; }
  function swimEnd() {
    swimV.tx = swimV.ty = 0;
    if (state === 'swim') {
      // drift to a stop still facing the way it swam, then turn back to the viewer
      face(swimFacing * 0.85, 1400);
      persist = 'idle'; set('idle');
    }
  }
  /** Beside a file it's about to eat: mouth wide, facing it. */
  function eatOpen(h: number) { face(h, 8000); eatPhase = 'open'; persist = 'eat'; set('eat'); }
  /** The file is on its way in (takes `ms`): keep sucking, cheeks filling. */
  function eatSuck(ms: number) { eatPhase = 'suck'; suckT0 = performance.now(); suckMs = ms; }
  /** It's in: snap shut, swell, then a satisfied spin. */
  function eatChomp() { eatPhase = 'none'; persist = 'idle'; queued = 'happy'; set('gulp'); }
  function eatCancel() { eatPhase = 'none'; persist = 'idle'; set('idle'); }
  /** Swallowed during play-mode eating: into the belly without the usual catch animation. */
  function absorb(files: HeldFile[]) { holding.push(...files); recount(); }
  /** Tidy: a quick gulp per file (a few at most), then happy. */
  function tidy(files: number) { tidyGulps = Math.max(1, Math.min(TIDY_MAX_GULPS, files)); persist = 'idle'; set('tidy'); }
  function poke(side: number) {
    if (state === 'sleep') { set('idle'); return; }
    if (!isOneShot(state) || state === 'nudge') { pokeSide = side || 1; set('nudge'); }
  }
  function endDrag() { if (state === 'drag') { persist = 'idle'; set('settle'); } }
  function touch() { lastActivity = performance.now(); }

  function update(t: number, dt: number, now: number, ptr: PointerCtx): Targets {
    stateT += dt;
    if (isOneShot(state) && stateT >= ONE_SHOT[state]) endOneShot();
    const sleepAfter = settings.sleepMinutes * 60_000;
    if (state === 'idle' && sleepAfter > 0 && now - lastActivity > sleepAfter) set('sleep');

    const T = defaultTargets();
    T.inflate = holdInflate();
    T.gill = 0.45 + 0.35 * Math.sin(t * Math.PI);
    const bob = Math.sin((t * 2 * Math.PI) / 3.6) * 0.07 * settings.motion;
    T.y = bob; T.roll = Math.sin((t * 2 * Math.PI) / 5.1) * 0.03 * settings.motion;
    T.mouth = Math.pow(Math.max(0, Math.sin(t * 1.6)), 14) * 0.28;
    if (ptr.following) {
      if (settings.eyesFollow) T.look = 'pointer';
      if (settings.bodyFollow) {
        // Whole fish: face the cursor (right → usual ¾ view, above/below → head-on,
        // left → turned around), tilt toward it and lean that way.
        T.yaw = headingYaw(Math.tanh(ptr.dx / 1.2));
        T.pitch = clampAbs(ptr.dy * 0.18, 0.45);
        T.x = clampAbs(ptr.dx * 0.1, 0.35) * settings.motion;
        T.y += clampAbs(ptr.dy * 0.1, 0.22) * settings.motion;
      } else {
        T.yaw = clampAbs(ptr.dx * 0.16, 0.55);
        T.pitch = clampAbs(ptr.dy * 0.1, 0.28);
      }
    }
    // A full belly lets bubbles escape now and then; the fuller, the more often.
    const g = growthOf(bellyBytes);
    if (g > 0.02 && state !== 'sleep' && now > nextBelch) {
      if (!reduceMotion) bubbles.emit(1 + Math.round(2 * g), { size: 0.018 + 0.012 * g });
      nextBelch = now + (9 - 7.5 * g) * 1000 * (0.7 + 0.6 * Math.random());
    }

    const st = stateT;
    switch (state) {
      case 'idle': {
        if (!reduceMotion && settings.fidgets && !micro && now > nextMicro) {
          const r = Math.random();
          micro = { type: r < 0.5 ? 'turn' : r < 0.8 ? 'rise' : 'bubble', t0: t };
          nextMicro = now + 20000 + Math.random() * 40000; // plan: one every 20–60 s
        }
        if (micro) {
          const mt = t - micro.t0;
          if (micro.type === 'turn') {
            const p = mt < 1.4 ? ease(mt / 1.4) : mt < 2.6 ? 1 : 1 - ease((mt - 2.6) / 1.4);
            T.yaw += p * 1.0; T.finFreq = 8; if (mt > 4) micro = null;
          } else if (micro.type === 'rise') {
            T.y += Math.sin(Math.PI * clamp01(mt / 3)) * 0.45; T.tail = mt < 1 ? 0.35 : 0.05; T.finFreq = 8.5; if (mt > 3) micro = null;
          } else { bubbles.emit(1, { size: 0.024 }); micro = null; }
        }
        break;
      }
      case 'ready': // a file is being dragged over: mouth open, ready to suck it in
        T.mouth = 0.6 + 0.1 * Math.sin(t * 6); T.gill = 0.9; T.finFreq = 9.5; T.flap = 0.36; T.look = 'pointer';
        T.yaw = Math.max(-0.6, Math.min(0.6, ptr.dx * 0.2));
        break;
      case 'catch':
        T.mouth = st < 0.45 ? 1 : 0; T.gill = st < 0.5 ? 1 : 0.5; T.finFreq = 10; T.flap = 0.38;
        T.x = -0.1 * Math.sin(Math.PI * clamp01((st - 0.4) / 0.45));
        if (!catchDone && st > 0.42) {
          catchDone = true;
          const caught = pendingCatch.splice(0);
          holding.push(...caught);
          recount();
          const bytes = caught.reduce((sum, f) => sum + f.size, 0);
          bubbles.emit(burst(bytes), { size: 0.02, jet: 0.15 + 0.35 * growthOf(bytes) });
        }
        break;
      case 'working': {
        const chew = Math.sin(t * 2 * Math.PI * 3); // beak gnawing ~3 Hz
        T.mouth = 0.32 + 0.32 * chew; T.y += 0.012 * chew; T.finFreq = 8; T.look = 'forward';
        if (Math.floor(t * 2) !== Math.floor((t - dt) * 2)) bubbles.emit(1, { size: 0.022 });
        if (now > workingUntil) { persist = 'idle'; set('happy'); }
        break;
      }
      case 'tidy': {
        const phase = st / TIDY_GULP_S;
        T.mouth = Math.abs(Math.sin(Math.PI * phase)); T.gill = 0.9; T.finFreq = 10; T.flap = 0.4; T.tail = 0.4;
        T.x = 0.06 * Math.sin(2 * Math.PI * phase); T.look = 'dart';
        if (Math.floor(phase) !== Math.floor((st - dt) / TIDY_GULP_S)) bubbles.emit(2, { size: 0.02 });
        if (phase >= tidyGulps) set('happy');
        break;
      }
      case 'swim': {
        // Body side-on to the direction of travel (turning through the front, so the
        // face shows mid-turn), nose up or down with the climb, eyes looking ahead,
        // and a body wave + fins that work harder the faster it goes.
        const sm = 1 - Math.exp(-8 * dt);
        swimV.x += (swimV.tx - swimV.x) * sm; swimV.y += (swimV.ty - swimV.y) * sm;
        const speed = Math.hypot(swimV.x, swimV.y), sp = clamp01(speed / 420);
        if (Math.abs(swimV.x) > 25) swimFacing = Math.sign(swimV.x);
        // how side-on: fully when moving sideways, more head-on for steep climbs/dives
        const side = speed > 1 ? Math.abs(swimV.x) / speed : 1;
        const lateral = 0.35 + 0.65 * side;
        // total yaw: -π/2 = facing the viewer; ≈0 = side-on swimming right; ≈-π = left
        const yawTotal = -Math.PI / 2 + swimFacing * lateral * (Math.PI / 2 - 0.22);
        T.yaw = yawTotal - BASE_YAW;
        T.pitch = clampAbs(Math.atan2(-swimV.y, Math.abs(swimV.x) + 40) * 0.75, 0.55);
        T.roll = reduceMotion ? 0 : Math.sin(t * 2.3) * 0.04 + swimFacing * clampAbs(swimV.y / 1500, 0.08);
        T.wag = reduceMotion ? 0.03 : 0.05 + 0.13 * sp;
        T.wagFreq = 1.2 + 2.4 * sp;
        T.tail = 0.3 + 0.5 * sp; T.finFreq = 9 + 6 * sp; T.flap = 0.34 + 0.14 * sp; T.finAmp = 0.24 + 0.08 * sp;
        T.gill = 0.6 + 0.35 * Math.sin(t * 7); T.mouth = 0.08 + 0.08 * Math.max(0, Math.sin(t * 3.5));
        T.x = 0; T.y = 0.04 * Math.sin(t * 2 * Math.PI * T.wagFreq * 0.5);
        T.look = 'dir';
        T.lookDir = speed > 1 ? [swimV.x / speed, -swimV.y / speed] : [swimFacing, 0];
        break;
      }
      case 'eat': {
        // Mouth wide and quivering, gills flared, leaning toward the file; while it's
        // being drawn in the cheeks fill and the fins work harder.
        const p = eatPhase === 'suck' ? clamp01((now - suckT0) / suckMs) : 0;
        T.mouth = 1.05 + (reduceMotion ? 0 : 0.05 * Math.sin(t * 34));
        T.gill = 1; T.eyeWide = 1.12; T.look = 'forward';
        T.finFreq = eatPhase === 'suck' ? 14 : 11; T.flap = 0.44; T.finAmp = 0.3; T.tail = 0.25;
        T.x = headingH * (0.05 + 0.1 * p);
        T.inflate = holdInflate() + 0.08 + 0.2 * p;
        T.pitch = 0.04;
        break;
      }
      case 'gulp': {
        // Snap shut; the swallow bulges the body and it wobbles back; a little recoil.
        T.mouth = st < 0.05 ? 0.6 : 0;
        T.inflate = holdInflate() + 0.3 * Math.exp(-st * 4.5);
        T.stiff = 170; T.damp = 7; // under-damped: a jelly wobble
        T.x = -headingH * 0.07 * Math.sin(Math.PI * clamp01(st / 0.35));
        T.eyeWide = 1 + 0.15 * Math.exp(-st * 5); T.finFreq = 12; T.flap = 0.42; T.tail = 0.6 * (1 - st);
        if (st >= 0.08 && st - dt < 0.08) bubbles.emit(6, { jet: 0.35, size: 0.026 }); // burp
        break;
      }
      case 'angry': {
        // Flushes red, huffs up, shakes and gnashes its beak, glaring at whoever clicked.
        const env = clamp01(st / 0.12) * (1 - clamp01((st - 1.35) / 0.55));
        T.angry = env;
        T.inflate = holdInflate() + 0.34 * env; T.stiff = 90; T.damp = 2 * Math.sqrt(90);
        const shake = reduceMotion ? 0 : env * (1 - 0.5 * clamp01(st / 1.4));
        T.x += Math.sin(t * 55) * 0.045 * shake; T.roll = Math.sin(t * 38) * 0.09 * shake;
        T.mouth = env * (0.2 + 0.45 * Math.abs(Math.sin(t * 22)));
        T.gill = 1; T.finFreq = 13; T.flap = 0.46; T.finAmp = 0.32; T.tail = 0.55 * env;
        T.eyeWide = 1 + 0.14 * env; T.look = 'pointer'; T.pitch = 0.08 * env;
        for (const at of [0.15, 0.6, 1.05]) {
          if (st >= at && st - dt < at) bubbles.emit(3, { jet: 0.55, size: 0.026 }); // steam
        }
        break;
      }
      case 'happy':
        T.spin = reduceMotion ? 0 : ease(clamp01(st / 0.75)) * Math.PI * 2;
        T.y += Math.sin(Math.PI * clamp01(st / 0.95)) * (reduceMotion ? 0.15 : 0.42);
        T.tail = st < 0.7 ? 1 : 0.1; T.finFreq = 10; T.flap = 0.4; T.look = 'forward';
        break;
      case 'spit':
        T.mouth = st < 0.35 ? 1 : 0; T.x = -0.14 * Math.sin(Math.PI * clamp01(st / 0.5)); T.finFreq = 9;
        if (!spitDone && st > 0.08) {
          spitDone = true;
          const out = pendingSpit.length ? pendingSpit : holding.slice(-1);
          for (const f of out) holding.splice(holding.indexOf(f), 1);
          pendingSpit = [];
          recount();
          bubbles.emit(3 + burst(out.reduce((sum, f) => sum + f.size, 0)), { jet: 0.9, size: 0.03 });
        }
        T.inflate = holdInflate();
        break;
      case 'puff':
        if (st < 2.5) { T.inflate = 1; T.stiff = 70; T.damp = 2 * Math.sqrt(70); }
        else {
          T.stiff = 60; T.damp = 5.5; // underdamped: bounces twice while deflating
          if (!jetDone) { jetDone = true; bubbles.emit(12, { jet: 1.1, size: 0.032 }); }
        }
        T.finFreq = 11; T.flap = 0.42; T.finAmp = 0.3; T.eyeWide = 1.1;
        T.y = Math.sin((t * 2 * Math.PI) / 5) * 0.12 + 0.1; T.roll = Math.sin(t * 1.3) * 0.06; T.mouth = st < 0.6 ? 0.7 : 0;
        break;
      case 'error':
        T.inflate = holdInflate() + 0.38 * Math.sin(Math.PI * clamp01(st / 0.95)); // a sigh
        T.y = -0.22 * Math.sin(Math.PI * clamp01(st / 1.6)); T.finFreq = 3; T.flap = 0.12; T.tone = 0.88;
        T.pitch = -0.12 * Math.sin(Math.PI * clamp01(st / 1.6)); T.look = 'down';
        if (!jetDone && st > 0.9) { jetDone = true; bubbles.emit(4, { jet: 0.5, size: 0.025 }); }
        break;
      case 'sleep':
        // sinks and darkens; eyes stay open (puffers have no eyelids)
        T.y = -1.0; T.roll = 0.17; T.pitch = -0.08; T.tone = 0.7; T.finFreq = 1.1; T.finAmp = 0.06; T.flap = 0.05;
        T.tail = 0; T.mouth = 0; T.gill = 0.3 + 0.2 * Math.sin(t * Math.PI * 0.45); T.look = 'rest'; T.yaw = 0;
        if (Math.floor(t / 6) !== Math.floor((t - dt) / 6)) bubbles.emit(1, { slow: true, size: 0.02 });
        break;
      case 'wake': {
        const p = ease(clamp01(st / 0.9));
        T.y = -1.0 * (1 - p) + bob * p; T.tone = 0.7 + 0.3 * p; T.finFreq = 2 + 6 * p; T.look = p > 0.3 ? 'scan' : 'rest';
        break;
      }
      case 'drag':
        T.finFreq = 12; T.flap = 0.48; T.finAmp = 0.32; T.tail = 0.6; T.roll = Math.sin(t * 9) * 0.12; T.y = 0;
        T.look = 'dart'; T.mouth = 0.25 + 0.2 * Math.sin(t * 7);
        break;
      case 'settle': // dropped: sinks a little, then the fins catch it
        T.y = -0.28 * Math.sin(Math.PI * clamp01(st / 0.9)); T.finFreq = 10; T.flap = 0.4; T.tail = 0.3 * (1 - st);
        break;
      case 'nudge':
        T.x = -pokeSide * 0.32 * Math.sin(Math.PI * clamp01(st / 0.8));
        T.yaw += pokeSide * 0.25 * Math.sin(Math.PI * clamp01(st / 0.8));
        T.finFreq = 10.5; T.flap = 0.4; T.tail = 0.45 * (1 - st); T.eyeWide = 1.05;
        break;
    }
    if (now < headingUntil && state !== 'swim') T.yaw = headingYaw(headingH);
    if (panelDim) T.dim = 1;
    if (puffed() && state !== 'sleep') {
      T.inflate = 1; T.stiff = 70; T.damp = 2 * Math.sqrt(70);
      T.eyeWide = 1.1; T.finFreq = Math.max(T.finFreq, 9.5); T.flap = Math.max(T.flap, 0.38); T.finAmp = Math.max(T.finAmp, 0.26);
    } else if (now < deflateUntil) {
      T.stiff = 60; T.damp = 5.5; // underdamped: bounces twice while deflating
    }
    return T;
  }

  return {
    get state() { return state; },
    get microActive() { return micro !== null; },
    get oneShot() { return isOneShot(state); },
    get puffHeld() { return puffHeld; },
    get puffed() { return puffed(); },
    /** Play-mode eating in progress (open / sucking / swallowing). */
    get eating() { return eatPhase !== 'none' || state === 'gulp'; },
    get bellyBytes() { return bellyBytes; },
    /** 0…1 growth from belly contents, counting files already being swallowed. */
    get growth() { return growthOf(bellyBytes + pendingCatch.reduce((sum, f) => sum + f.size, 0)); },
    holding, set, feed, spit, spitIds, restore, startWork, finishWork, tidy, togglePuff, panelView, face, swimStart, swimVel, swimEnd, eatOpen, eatSuck, eatChomp, eatCancel, absorb, poke, endDrag, touch, update,
  };
}

export type States = ReturnType<typeof createStates>;
