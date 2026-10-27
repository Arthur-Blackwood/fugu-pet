// Desktop host: click-through, window dragging, file drops, the panel and tray commands.
import { currentMonitor, getCurrentWindow, LogicalPosition, LogicalSize } from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import type { Pet } from '../fish/renderer';
import type { HeldFile, State } from '../fish/states';
import { bindClicks, DRAG_THRESHOLD_PX } from './input';
import { forwardLogs } from './log';
import { applySettings, settings, type Settings } from '../settings';
import { setGear } from '../overlay';
import { formatBytes } from '../fish/growth';

interface BellyItem { id: number; path: string; name: string; ext: string | null; size: number; is_dir: boolean; size_complete: boolean }
const held = (i: BellyItem): HeldFile => ({ id: i.id, name: i.name, path: i.path, size: i.size });
/** Open the action menu once the swallow animation has played. */
const ACTIONS_AFTER_MS = 900;
/** How long the fish's speech bubble stays up. */
const BUBBLE_MS = 5000;

/** No `moved` event for this long ends a window drag. */
const DRAG_IDLE_MS = 300;
/** Window size at growth scale 1 (matches tauri.conf.json). */
const BASE_W = 280, BASE_H = 240;
/** Resize in steps of this much scale, not every frame. */
const RESIZE_STEP = 0.04;

export async function attachTauri(pet: Pet, canvas: HTMLCanvasElement, setDebug: (on: boolean) => void) {
  const win = getCurrentWindow();
  const webview = getCurrentWebview();
  forwardLogs();
  console.info(`[pet] attached, dpr ${window.devicePixelRatio}, ${innerWidth}x${innerHeight}`);

  /* ---- click-through: only the fish itself catches the mouse ---- */
  let ignoring = true; // Rust starts the window click-through
  const setIgnore = (v: boolean) => {
    if (v === ignoring) return;
    ignoring = v;
    if (import.meta.env.DEV) console.info(v ? '[hit] off fish → click-through' : '[hit] on fish → capture');
    win.setIgnoreCursorEvents(v).catch(console.error);
  };

  let pressed: { x: number; y: number } | null = null;
  let windowDrag = false, lastMovedAt = 0, fileOver = false;

  await listen<{ x: number; y: number }>('pet://cursor', ({ payload: { x, y } }) => {
    pet.setPointer(x, y);
    if (pressed || windowDrag) return; // keep capturing for the whole gesture
    const hit = pet.hitAt(x, y);
    if (hit) pet.states.touch();
    pet.setHover(hit);
    canvas.style.cursor = hit ? 'grab' : '';
    setIgnore(!hit);
  });


  /* ---- clicks and dragging the window by the fish ---- */
  // A single click opens the panel; three quick clicks puff instead.
  const clicks = bindClicks(pet,
    () => invoke('panel_toggle', { view: 'belly' }).catch(console.error),
    () => invoke('panel_hide').catch(console.error));
  canvas.addEventListener('pointermove', (e) => {
    pet.setPointer(e.clientX, e.clientY);
    if (pressed && Math.hypot(e.clientX - pressed.x, e.clientY - pressed.y) > DRAG_THRESHOLD_PX) {
      pressed = null;
      windowDrag = true; lastMovedAt = performance.now();
      pet.states.set('drag');
      canvas.style.cursor = 'grabbing';
      // The panel (if open) follows the fish. Native drag: the OS moves the window
      // and swallows the mouse-up.
      invoke('follow_begin', { leader: 'pet' })
        .finally(() => win.startDragging().catch(console.error));
    }
  });
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !pet.hitAt(e.clientX, e.clientY)) return;
    pressed = { x: e.clientX, y: e.clientY };
    invoke('panel_keep').catch(() => {}); // pressing the fish shouldn't close the panel
  });
  // A press that didn't turn into a drag is a click; `click` carries the OS click count.
  let clickArmed = false;
  canvas.addEventListener('pointerup', () => {
    clickArmed = !!pressed;
    pressed = null;
  });
  canvas.addEventListener('click', (e) => {
    if (!clickArmed) return;
    clickArmed = false;
    clicks.click(e.clientX, e.detail || 1);
  });
  await win.onMoved(() => { if (windowDrag) lastMovedAt = performance.now(); });
  setInterval(() => {
    if (windowDrag && performance.now() - lastMovedAt > DRAG_IDLE_MS) {
      windowDrag = false;
      pet.states.endDrag();
      invoke('follow_end').catch(console.error);
    }
  }, 100);
  pet.setBusy(() => windowDrag || fileOver);

  /* ---- grow the window with the fish, keeping its centre where it is ---- */
  let windowScale = 1, resizing = false;
  setInterval(async () => {
    if (resizing || windowDrag) return;
    const want = Math.ceil(pet.windowScale() / RESIZE_STEP) * RESIZE_STEP;
    if (Math.abs(want - windowScale) < RESIZE_STEP / 2) return;
    resizing = true;
    try {
      const sf = await win.scaleFactor();
      const pos = (await win.outerPosition()).toLogical(sf);
      const size = (await win.innerSize()).toLogical(sf);
      const w = Math.round(BASE_W * want), h = Math.round(BASE_H * want);
      const cx = pos.x + size.width / 2, cy = pos.y + size.height / 2;
      let x = cx - w / 2, y = cy - h / 2;
      // Keep the grown window on screen (the fish slides inward rather than off the edge).
      const mon = await currentMonitor();
      if (mon) {
        const area = mon.workArea, msf = mon.scaleFactor;
        const ax = area.position.x / msf, ay = area.position.y / msf;
        const aw = area.size.width / msf, ah = area.size.height / msf;
        x = Math.min(Math.max(x, ax), ax + aw - w);
        y = Math.min(Math.max(y, ay), ay + ah - h);
      }
      await win.setSize(new LogicalSize(w, h));
      await win.setPosition(new LogicalPosition(Math.round(x), Math.round(y)));
      windowScale = want;
    } catch (err) {
      console.error('resize failed', err);
    } finally {
      resizing = false;
    }
  }, 120);

  /* ---- file drops: the fish swallows them ---- */
  await webview.onDragDropEvent(async ({ payload: p }) => {
    if (p.type === 'enter' || p.type === 'over') {
      fileOver = true;
      const dpr = window.devicePixelRatio || 1;
      pet.setPointer(p.position.x / dpr, p.position.y / dpr);
      const s = pet.states.state;
      if (s !== 'ready' && s !== 'catch') pet.states.set('ready');
    } else if (p.type === 'leave') {
      fileOver = false;
      if (pet.states.state === 'ready') pet.states.set('idle');
    } else if (p.type === 'drop') {
      fileOver = false;
      try {
        const added = await invoke<BellyItem[]>('belly_add', { paths: p.paths });
        console.info('[drop]', added.map((i) => `${i.name} (${i.size} B)`).join(', '));
        if (!added.length) { pet.states.set('idle'); return; } // already in the belly
        const ids = added.map((i) => i.id);
        setTimeout(() => invoke('panel_show', { view: 'actions', ids }).catch(console.error), ACTIONS_AFTER_MS);
      } catch (err) {
        console.error(err);
        pet.states.set('error');
      }
    }
  });

  /* ---- belly (persisted in Rust) ---- */
  pet.states.restore((await invoke<BellyItem[]>('belly_list')).map(held));
  await listen<BellyItem[]>('belly://added', ({ payload }) => {
    // Eaten in play mode: the eating animation is the swallow; just take it in.
    if (pet.states.eating) pet.states.absorb(payload.map(held));
    else pet.states.feed(payload.map(held));
  });
  await listen<number[]>('belly://removed', ({ payload }) => pet.states.spitIds(payload));

  /* ---- work done from the panel ---- */
  await listen<'start' | 'done' | 'error'>('pet://work', ({ payload }) => {
    if (payload === 'start') pet.states.startWork();
    else pet.states.finishWork(payload === 'done');
  });
  await listen<number>('pet://tidy', ({ payload }) => pet.states.tidy(payload));

  /* ---- settings ---- */
  applySettings(await invoke<Settings>('settings_get'));
  await listen<Settings>('settings://changed', ({ payload }) => applySettings(payload));

  /* ---- what the panel shows: Belly → puff + speech bubble, Settings → dim + gear ---- */
  let bubbleTimer: ReturnType<typeof setTimeout> | undefined;
  const hideBubble = () => { clearTimeout(bubbleTimer); invoke('bubble_hide').catch(console.error); };
  await listen<string>('pet://panel-view', ({ payload: view }) => {
    pet.states.panelView(view);
    setGear(view === 'settings');
    if (view !== 'belly' || !settings.showFish) return hideBubble();
    clearTimeout(bubbleTimer);
    // Let the puff get going first so the bubble sits above the round fish.
    bubbleTimer = setTimeout(() => {
      const { holding, bellyBytes } = pet.states;
      const n = holding.length;
      const [title, detail] = n === 0
        ? ['My belly’s empty', 'Drop files on me and I’ll hold them.']
        : [`${n} ${n === 1 ? 'item' : 'items'} in my belly`, `${formatBytes(bellyBytes)} in total${bellyBytes > 1e9 ? ' · I’m stuffed!' : ''}`];
      const e = pet.fishExtent();
      invoke('bubble_say', { title, detail, topX: e.x, topY: e.top, bottomY: e.bottom }).catch(console.error);
      bubbleTimer = setTimeout(hideBubble, BUBBLE_MS);
    }, 220);
  });
  await listen<'angry'>('pet://emote', ({ payload }) => pet.states.set(payload));

  /* ---- play mode: swimming around the screen and eating Desktop files ---- */
  let playing = await invoke<boolean>('play_get');
  await listen<{ on: boolean }>('play://changed', ({ payload }) => { playing = payload.on; });
  await listen<[number, number, number]>('pet://swim', ({ payload: [dx, dy] }) => pet.states.swimStart(dx, dy));
  await listen<[number, number, number, number, number]>('pet://swim-v', ({ payload: [, , vx, vy] }) => pet.states.swimVel(vx, vy));
  await listen('pet://swim-end', () => pet.states.swimEnd());
  const sendMouth = () => {
    const m = pet.mouthScreen();
    invoke('pet_mouth', { x: m.x, y: m.y }).catch(console.error); // Rust adds the window's real position
  };
  /** While eating, the overlay aims the file at the mouth every frame. */
  const streamMouth = () => {
    sendMouth();
    if (pet.states.eating) requestAnimationFrame(streamMouth);
  };
  type EatPhase = 'approach' | 'open' | 'suck' | 'chomp' | 'cancel';
  await listen<{ phase: EatPhase; heading: number; ms?: number }>('pet://eat', ({ payload: { phase, heading, ms } }) => {
    if (phase === 'approach') pet.states.face(heading, 8000);
    else if (phase === 'open') { pet.states.eatOpen(heading); streamMouth(); }
    else if (phase === 'suck') pet.states.eatSuck(ms ?? 700);
    else if (phase === 'chomp') { pet.states.eatChomp(); pet.swell(0.16); pet.states.face(heading, 2500); }
    else pet.states.eatCancel();
  });
  await listen('pet://mouth-req', sendMouth);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && playing) invoke('play_set', { on: false }).catch(console.error);
  });

  /* ---- tray ---- */
  await listen<State>('pet://state', ({ payload }) => pet.states.set(payload));
  await listen<boolean>('pet://debug', ({ payload }) => setDebug(payload));
}
