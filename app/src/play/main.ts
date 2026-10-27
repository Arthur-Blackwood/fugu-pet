// Play mode overlay. Click → the fish swims there. Double-click a Desktop file → the
// fish swims over, opens wide, and the file — spinning and shrinking — is drawn into
// its mouth while the fish grows. The real file is hidden (restored when play ends)
// and its spot keeps bubbling.
import './play.css';
import { invoke } from '@tauri-apps/api/core';
import { emitTo, listen, once } from '@tauri-apps/api/event';
import { createGlow } from './glow';
import { forwardLogs } from '../platform/log';

if ('__TAURI_INTERNALS__' in window) forwardLogs();

interface EatTarget {
  path: string; name: string;
  cx: number; cy: number; x: number; y: number; w: number; h: number;
  icon_size: number; image: string | null;
}
type Pt = { x: number; y: number };

const canvas = document.getElementById('fx') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const sprites = document.getElementById('sprites')!;
const toast = document.getElementById('toast')!;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

let glow: ReturnType<typeof createGlow> = null;
try { glow = createGlow(document.getElementById('glow') as HTMLCanvasElement); } catch (e) { console.error(e); }
if (!glow) document.body.classList.add('no-gl'); // CSS border instead

/* ---------- coordinates ---------- */
// Mouse events carry screen coordinates; subtracting the overlay's origin gives local
// drawing coordinates. The origin comes from Rust when play starts and is re-derived from
// every mouse event (screen − client), since window.screenX/Y is unreliable on macOS.
const origin: Pt = { x: 0, y: 0 };
const local = (p: Pt): Pt => ({ x: p.x - origin.x, y: p.y - origin.y });
const learnOrigin = (e: MouseEvent) => { origin.x = e.screenX - e.clientX; origin.y = e.screenY - e.clientY; };
addEventListener('pointerdown', learnOrigin, true);
addEventListener('pointermove', learnOrigin, true);

/* ---------- canvas effects: ripples, bubbles, inhaled water, splashes ---------- */
interface Ripple { x: number; y: number; t: number; dur: number; size: number; strong: number }
interface Bubble { x: number; y: number; r: number; vx: number; vy: number; ph: number; t: number; life: number; pop: number }
interface Spot { x: number; y: number; next: number }

const ripples: Ripple[] = [];
const bubbles: Bubble[] = [];
const spots: Spot[] = []; // where eaten files used to be: they keep bubbling
/** Water being drawn into the mouth while it sucks. */
let inhale: { at: () => Pt; from: Pt; t0: number; until: number } | null = null;

function resize() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener('resize', resize);
resize();

function spawnBubble(x: number, y: number, big = 1, vx = 0) {
  bubbles.push({
    x: x + (Math.random() - 0.5) * 14, y, r: (2.5 + Math.random() * 5.5) * big, vx,
    vy: 36 + Math.random() * 44, ph: Math.random() * 6.28, t: 0, life: 1.5 + Math.random() * 1.3, pop: 0,
  });
}

function drawBubble(b: Bubble) {
  const fade = Math.min(1, b.t * 5) * (b.pop > 0 ? 1 - b.pop : 1);
  const r = b.r * (1 + b.t * 0.12) * (b.pop > 0 ? 1 + b.pop * 0.7 : 1);
  const x = b.x + Math.sin(b.t * 3 + b.ph) * 4;
  ctx.globalAlpha = fade;
  if (b.pop > 0) {
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 0.9;
    ctx.beginPath(); ctx.arc(x, b.y, r, 0, Math.PI * 2); ctx.stroke();
  } else {
    const g = ctx.createRadialGradient(x - r * 0.35, b.y - r * 0.35, r * 0.05, x, b.y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.22)'); g.addColorStop(0.7, 'rgba(225,238,248,0.08)'); g.addColorStop(1, 'rgba(255,255,255,0.6)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, b.y, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.16)'; ctx.lineWidth = 0.75; ctx.stroke(); // reads on light wallpapers
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(x, b.y, r * 0.62, Math.PI * 1.1, Math.PI * 1.45); ctx.stroke(); // highlight
  }
  ctx.globalAlpha = 1;
}

let last = performance.now();
let running = false;
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  ctx.clearRect(0, 0, innerWidth, innerHeight);

  for (const s of spots) {
    if (now > s.next) { spawnBubble(s.x, s.y); s.next = now + 280 + Math.random() * 480; }
  }
  for (let i = ripples.length - 1; i >= 0; i--) {
    const rp = ripples[i]; rp.t += dt;
    const p = rp.t / rp.dur;
    if (p >= 1) { ripples.splice(i, 1); continue; }
    for (const lag of [0, 0.2, 0.38]) {
      const q = Math.max(0, p - lag) / (1 - lag);
      if (q <= 0) continue;
      const e = 1 - (1 - q) ** 3; // ease-out: fast spread, slow fade
      const rr = 5 + e * rp.size;
      ctx.strokeStyle = `rgba(255,255,255,${rp.strong * (1 - q) ** 1.5})`;
      ctx.lineWidth = 2.2 * (1 - q) + 0.4;
      ctx.beginPath(); ctx.ellipse(rp.x, rp.y, rr, rr * 0.5, 0, 0, Math.PI * 2); ctx.stroke();
    }
  }
  if (inhale) {
    // Rings of water contracting into the mouth, from around the file.
    const m = local(inhale.at());
    const life = (now - inhale.t0) / 1000;
    const ending = Math.max(0, (now - inhale.until) / 220);
    if (ending >= 1) inhale = null;
    else {
      const strength = Math.min(1, life * 4) * (1 - ending);
      const span = Math.hypot(inhale.from.x - m.x, inhale.from.y - m.y) + 40;
      for (let k = 0; k < 4; k++) {
        const ph = (life * 1.9 + k / 4) % 1; // each ring travels outer → mouth
        const rr = 6 + (1 - ph) * span;
        const a = strength * 0.42 * Math.sin(Math.PI * ph) * (0.5 + 0.5 * ph);
        ctx.strokeStyle = `rgba(255,255,255,${a})`;
        ctx.lineWidth = 0.6 + 1.6 * ph;
        ctx.beginPath(); ctx.ellipse(m.x, m.y, rr, rr * 0.62, 0, 0, Math.PI * 2); ctx.stroke();
      }
    }
  }
  for (let i = bubbles.length - 1; i >= 0; i--) {
    const b = bubbles[i]; b.t += dt;
    if (b.pop > 0) { b.pop += dt * 5; if (b.pop >= 1) { bubbles.splice(i, 1); continue; } }
    else { b.y -= b.vy * dt; b.x += b.vx * dt; b.vx *= 1 - 2 * dt; if (b.t > b.life) b.pop = 0.01; }
    drawBubble(b);
  }

  if (spots.length || ripples.length || bubbles.length || inhale) requestAnimationFrame(frame);
  else running = false;
}
function kick() { if (!running) { running = true; last = performance.now(); requestAnimationFrame(frame); } }
function ripple(at: Pt, size = 40, strong = 0.7, dur = 0.75) { ripples.push({ ...local(at), t: 0, dur, size, strong }); kick(); }

/* ---------- bubble trail while the fish swims ----------
   Rust reports the fish's centre, velocity and window width (~30 Hz) during a swim.
   Bubbles drop off behind the tail every so many px travelled, small ones escape from
   the gills now and then, and each new swim starts with a little burst. */
let trailDist = 0, gillAt = 0, wasStill = true;
listen<[number, number, number, number, number]>('pet://swim-v', ({ payload: [cx, cy, vx, vy, w] }) => {
  if (reduceMotion) return;
  const speed = Math.hypot(vx, vy);
  if (speed < 20) { wasStill = true; return; }
  const dir = { x: vx / speed, y: vy / speed };
  const c = local({ x: cx, y: cy });
  const tail = { x: c.x - dir.x * w * 0.3, y: c.y - dir.y * w * 0.3 };
  const jitter = () => (Math.random() - 0.5) * 12;
  const drift = -dir.x * (15 + Math.random() * 30); // left in the fish's wake
  if (wasStill) {
    wasStill = false;
    for (let i = 0; i < 5; i++) spawnBubble(tail.x + jitter(), tail.y + jitter(), 0.6 + Math.random() * 0.5, drift * 1.6);
  }
  trailDist += speed * 0.033;
  const every = 34 - 14 * Math.min(1, speed / 500); // faster → a denser trail
  while (trailDist > every) {
    trailDist -= every;
    spawnBubble(tail.x + jitter(), tail.y + jitter(), 0.45 + Math.random() * 0.45, drift);
  }
  const now = performance.now();
  if (now > gillAt) {
    gillAt = now + 550 + Math.random() * 700;
    const gill = { x: c.x + dir.x * w * 0.12, y: c.y - 4 };
    for (let i = 0; i < 2; i++) spawnBubble(gill.x + jitter() * 0.5, gill.y, 0.4 + Math.random() * 0.3, drift * 0.5);
  }
  kick();
});

/* ---------- the fish ---------- */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const swim = (p: Pt) => invoke('pet_swim', { x: p.x, y: p.y }).catch(console.error);

/** Latest mouth position on screen. While eating, the fish streams it every frame. */
let mouthLive: Pt | null = null;
listen<Pt>('pet://mouth', ({ payload }) => { mouthLive = payload; });
async function askMouth(fallback: Pt): Promise<Pt> {
  const got = new Promise<Pt>((resolve) => { once<Pt>('pet://mouth', (e) => resolve(e.payload)); });
  await emitTo('main', 'pet://mouth-req');
  return Promise.race([got, sleep(400).then(() => fallback)]);
}
const fishCentre = () => invoke<[number, number] | null>('pet_center').then((c) => (c ? { x: c[0], y: c[1] } : null)).catch(() => null);

function showToast(msg: string) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 6000);
}

/* ---------- animation helpers ---------- */
function tween(ms: number, step: (p: number) => void) {
  return new Promise<void>((done) => {
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / ms);
      step(p);
      if (p < 1) requestAnimationFrame(tick); else done();
    };
    requestAnimationFrame(tick);
  });
}
const easeOutBack = (t: number) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;

/* ---------- eating ---------- */
let eating = false;
const eaten = new Set<string>();
/** Gap between the mouth and the near edge of the icon when the fish stops. */
const MOUTH_GAP = 22;

async function eat(at: Pt) {
  if (eating) return;
  eating = true;
  try {
    const target = await invoke<EatTarget | null>('play_item_at', { x: at.x, y: at.y });
    if (!target || eaten.has(target.path)) return;
    const size = target.icon_size;
    const icon: Pt = { x: target.cx, y: target.cy };

    // 1. Swim over and turn to face the file, then fine-tune so the mouth (not the
    //    fish's centre) ends just beside the icon.
    const fish = await fishCentre();
    const fromRight = (fish?.x ?? at.x + 1) >= icon.x;
    const heading = fromRight ? -1 : 1;
    const side = fromRight ? 1 : -1;
    const mouthSpot: Pt = { x: icon.x + side * (size / 2 + MOUTH_GAP), y: icon.y };
    await emitTo('main', 'pet://eat', { phase: 'approach', heading });
    await swim({ x: mouthSpot.x + side * 62, y: mouthSpot.y + 4 });
    await sleep(160); // let the turn settle
    const fishNow = await fishCentre();
    const m0 = await askMouth(mouthSpot);
    if (fishNow && Math.hypot(m0.x - mouthSpot.x, m0.y - mouthSpot.y) > 6) {
      await swim({ x: fishNow.x + (mouthSpot.x - m0.x), y: fishNow.y + (mouthSpot.y - m0.y) });
    }

    // 2. Mouth wide; the icon — drawn exactly where Finder had it — stands in for the
    //    real file, which is hidden in the same moment.
    await emitTo('main', 'pet://eat', { phase: 'open', heading });
    const el = document.createElement('div');
    el.className = 'sprite';
    Object.assign(el.style, { width: `${size}px`, height: `${size}px` });
    const img = document.createElement('img');
    img.alt = '';
    if (target.image) img.src = target.image;
    el.append(img);
    const c = local(icon);
    const put = (x: number, y: number, rot: number, sx: number, sy: number, opacity = 1, blur = 0) => {
      el.style.transform = `translate3d(${x - size / 2}px, ${y - size / 2}px, 0) rotate(${rot}rad) scale(${sx}, ${sy})`;
      el.style.opacity = String(opacity);
      el.style.filter = `drop-shadow(0 ${3 + 3 * sx}px ${5 + 4 * sx}px rgb(0 0 0 / ${0.32 * opacity})) blur(${blur}px)`;
    };
    put(c.x, c.y, 0, 1, 1);
    sprites.append(el);
    await sleep(40); // sprite painted before the real icon disappears
    try {
      await invoke('play_hide', { path: target.path });
    } catch (e) {
      el.remove();
      await emitTo('main', 'pet://eat', { phase: 'cancel', heading });
      showToast(`Couldn’t eat “${target.name}”: ${e}`);
      return;
    }
    eaten.add(target.path);

    // 3. Caught by the pull: lifts, leans toward the mouth, trembles.
    const lean = -side * 0.22;
    await tween(reduceMotion ? 1 : 340, (p) => {
      const e = easeOutBack(p);
      const tremble = Math.sin(p * Math.PI * 16) * 0.035 * p;
      const pull = 6 * e;
      put(c.x - side * pull, c.y - 7 * e, lean * e + tremble, 1 + 0.1 * e, 1 + 0.1 * e - 0.04 * Math.sin(p * Math.PI));
    });

    // 4. Drawn in: the fish starts swallowing (and growing) while the icon spirals into
    //    its mouth — slow at first, then quick — spinning and shrinking to nothing.
    const dur = reduceMotion ? 260 : 900;
    await emitTo('main', 'pet://eat', { phase: 'suck', heading, ms: dur });
    invoke('belly_add', { paths: [target.path] }).catch(console.error); // growth starts now
    const start = { x: c.x - side * 6, y: c.y - 7 };
    const mouthNow = () => mouthLive ?? mouthSpot;
    inhale = { at: mouthNow, from: start, t0: performance.now(), until: performance.now() + dur };
    kick();
    await tween(dur, (p) => {
      const m = local(mouthNow());
      const e = p * p * (3 - 2 * p) * 0.35 + p * p * p * 0.65; // gentle start, rushing finish
      const arc = Math.sin(Math.PI * e) * Math.min(28, Math.hypot(m.x - start.x, m.y - start.y) * 0.35);
      const x = start.x + (m.x - start.x) * e;
      const y = start.y + (m.y - start.y) * e - arc;
      const spin = lean + heading * 3.5 * Math.PI * e ** 1.2; // ~1¾ turns, quickening toward the mouth
      const s = 1.1 * (1 - e) ** 1.05 + 0.02;
      const opacity = e < 0.82 ? 1 : 1 - (e - 0.82) / 0.18;
      put(x, y, spin, s, s, opacity, 1.2 * e * e);
    });
    el.remove();

    // 5. Chomp: the mouth snaps shut, the fish swells with a bounce, a splash and a burp.
    await emitTo('main', 'pet://eat', { phase: 'chomp', heading });
    const m = mouthNow();
    ripple(m, 26, 0.85, 0.6);
    for (let i = 0; i < 6; i++) {
      const ml = local(m);
      spawnBubble(ml.x + side * 4, ml.y - 4, 0.9 + Math.random() * 0.5, side * (20 + Math.random() * 40));
    }
    // 6. Where the file was, bubbles keep rising.
    spots.push({ x: c.x, y: c.y + size * 0.15, next: performance.now() + 420 });
    kick();
  } catch (e) {
    showToast(String(e));
  } finally {
    eating = false;
  }
}

/* ---------- input ---------- */
addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('.hint') || e.detail > 1) return;
  const at = { x: e.screenX, y: e.screenY };
  ripple(at);
  if (!eating) swim(at);
});
addEventListener('dblclick', (e) => {
  if ((e.target as HTMLElement).closest('.hint')) return;
  eat({ x: e.screenX, y: e.screenY });
});
const exit = () => invoke('play_set', { on: false }).catch(console.error);
document.getElementById('exit')!.addEventListener('click', exit);
addEventListener('keydown', (e) => { if (e.key === 'Escape') exit(); });

// Debug aid: press D to outline the Desktop icon hit areas Finder reports.
addEventListener('keydown', async (e) => {
  if (e.key !== 'd') return;
  const items = await invoke<EatTarget[]>('play_items').catch((err) => { showToast(String(err)); return []; });
  for (const it of items) {
    const box = document.createElement('div');
    const p = local({ x: it.x, y: it.y });
    Object.assign(box.style, { position: 'absolute', left: `${p.x}px`, top: `${p.y}px`, width: `${it.w}px`, height: `${it.h}px`, outline: '1px dashed rgba(255,80,80,.9)', pointerEvents: 'none' });
    sprites.append(box);
    setTimeout(() => box.remove(), 4000);
  }
});

function setOn(on: boolean) {
  document.body.classList.toggle('on', on);
  glow?.show(on);
  if (!on) {
    spots.length = 0; bubbles.length = 0; ripples.length = 0; inhale = null;
    eaten.clear();
    sprites.replaceChildren();
  }
}
listen<{ on: boolean; origin: [number, number] }>('play://changed', ({ payload }) => {
  origin.x = payload.origin[0]; origin.y = payload.origin[1];
  setOn(payload.on);
});
if ('__TAURI_INTERNALS__' in window) invoke<boolean>('play_get').then(setOn).catch(() => {});
else setOn(true); // browser preview (npm run dev → /play.html)
