// The panel next to the fish: belly (F4), recent files (F5), tidy (F1), settings, and
// the action menu shown right after a drop. The fish reacts to which tab is showing.
import './panel.css';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { startDrag } from '@crabnebula/tauri-plugin-drag';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { api, inTauri, type ActionReport, type BellyItem, type Move, type RecentFile, type TidyReport } from './api';
import { formatBytes } from '../fish/growth';
import { forwardLogs } from '../platform/log';
import { renderSettings } from './settings-view';

if (inTauri) forwardLogs();

type View = 'belly' | 'recent' | 'tidy' | 'settings' | 'actions';

const body = document.getElementById('body')!;
const foot = document.getElementById('foot')!;
const tabs = [...document.querySelectorAll<HTMLButtonElement>('.tabs button')];
const SHOW_IN = navigator.userAgent.includes('Windows') ? 'Show in Explorer' : 'Show in Finder';

let view: View = 'belly';
let belly: BellyItem[] = [];
let focusIds: number[] = []; // items the actions view is about
const selected = new Set<number>();
/** Last row clicked without Shift: where a Shift-click range starts. */
let anchorId: number | null = null;
let busy = false; // an action / tidy is running: don't auto-hide
let dragging = false;
let iconPath = '';
/** A result card replaces the view until the user dismisses it. */
let result: { node: Node; buttons: HTMLElement[] } | null = null;

/* ---------- tiny DOM helper (text only: file names never become HTML) ---------- */
type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: Child[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids) if (k) el.append(k);
  return el;
}
const btn = (label: string, onclick: () => void, cls = 'btn') => h('button', { class: cls, onclick }, label);
const iconBtn = (label: string, path: string, onclick: (e: Event) => void) =>
  h('button', { class: 'icon-btn', 'aria-label': label, title: label, onclick }, svg(path));
function svg(d: string) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', d);
  s.append(p); return s;
}
const ICON = {
  reveal: 'M2 4.5h4l1.5 1.5H14v6.5H2zM2 4.5V3.5h4',
  out: 'M8 11V3M5 6l3-3 3 3M3 13h10',
  feed: 'M8 3v8M5 8l3 3 3-3M3 13h10',
};

/* ---------- formatting ---------- */
const KINDS: Record<string, string[]> = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'heic', 'heif', 'webp', 'tif', 'tiff', 'bmp', 'svg'],
  pdf: ['pdf'],
  doc: ['doc', 'docx', 'pages', 'txt', 'rtf', 'md', 'xls', 'xlsx', 'csv', 'numbers', 'ppt', 'pptx', 'key'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'dmg', 'pkg', 'exe', 'msi'],
  media: ['mp3', 'm4a', 'wav', 'mp4', 'mov', 'mkv', 'webm'],
};
function badge(ext: string | null, isDir = false) {
  const kind = isDir ? 'folder' : Object.keys(KINDS).find((k) => ext && KINDS[k].includes(ext)) ?? 'other';
  return h('span', { class: 'badge', 'data-kind': kind }, isDir ? 'DIR' : (ext ?? '?').slice(0, 4));
}
const parentName = (p: string) => p.split(/[\\/]/).slice(-2, -1)[0] ?? '';
function ago(ms: number) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 172800) return 'yesterday';
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/* ---------- drag out ---------- */
function draggableRow(row: HTMLElement, path: string, onDropped?: () => void) {
  row.draggable = true;
  row.addEventListener('dragstart', async (e) => {
    e.preventDefault();
    dragging = true;
    try {
      await startDrag({ item: [path], icon: iconPath || (iconPath = await api.dragIcon()), mode: 'copy' }, ({ result }) => {
        dragging = false;
        if (result === 'Dropped') onDropped?.();
      });
    } catch (err) {
      dragging = false;
      console.error(err);
    }
  });
}

/* ---------- views ---------- */
function setView(v: View) {
  view = v;
  result = null;
  for (const t of tabs) t.setAttribute('aria-selected', String(t.dataset.view === v || (v === 'actions' && t.dataset.view === 'belly')));
  api.showingView(v).catch(console.error);
  render();
}

async function render() {
  if (result) {
    body.replaceChildren(result.node);
    foot.replaceChildren(...result.buttons);
    return;
  }
  if (view === 'belly') renderBelly();
  else if (view === 'actions') await renderActions();
  else if (view === 'recent') await renderRecent();
  else if (view === 'settings') await renderSettings(body, foot, () => view === 'settings' && !result);
  else await renderTidy();
}

/** Belly items in the order the list shows them (newest first). */
const shownBelly = () => [...belly].reverse();

/** Click a row: toggle it. Shift-click: select everything from the anchor row to this one. */
function clickRow(id: number, shift: boolean) {
  const order = shownBelly().map((i) => i.id);
  const a = anchorId === null ? -1 : order.indexOf(anchorId);
  const b = order.indexOf(id);
  if (shift && a >= 0 && b >= 0) {
    for (const rid of order.slice(Math.min(a, b), Math.max(a, b) + 1)) selected.add(rid);
  } else {
    selected.has(id) ? selected.delete(id) : selected.add(id);
    anchorId = id;
  }
  renderBelly();
}

function bellyRow(item: BellyItem, withCheck: boolean) {
  const meta = `${formatBytes(item.size)}${item.size_complete ? '' : '+'} · ${parentName(item.path)}`;
  const kids: Child[] = [];
  if (withCheck) {
    const cb = h('input', { type: 'checkbox', class: 'check', 'aria-label': `Select ${item.name}` }) as HTMLInputElement;
    cb.checked = selected.has(item.id);
    kids.push(cb);
  }
  const row = h('li', { class: `row${withCheck ? ' has-check' : ''}${selected.has(item.id) ? ' selected' : ''}`, title: item.path },
    ...kids,
    badge(item.ext, item.is_dir),
    h('div', { class: 'text' }, h('div', { class: 'name' }, item.name), h('div', { class: 'meta' }, meta)),
    h('div', { class: 'tools' },
      iconBtn(SHOW_IN, ICON.reveal, () => revealItemInDir(item.path).catch(console.error)),
      iconBtn('Let it out of the belly', ICON.out, () => api.bellyRemove([item.id]))),
  );
  if (withCheck) {
    // The whole row selects (Shift extends); the row's own buttons keep their jobs.
    row.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.tools')) return;
      if (target.classList.contains('check')) e.preventDefault(); // one toggle path, ours
      clickRow(item.id, e.shiftKey);
    });
  }
  // Dragging an item out is the fish "spitting" it at the drop target.
  draggableRow(row, item.path, () => api.bellyRemove([item.id]));
  return row;
}

function renderBelly() {
  for (const id of [...selected]) if (!belly.some((i) => i.id === id)) selected.delete(id);
  if (!belly.length) {
    body.replaceChildren(h('div', { class: 'empty' },
      h('strong', {}, 'The belly is empty'),
      'Drop files on the fish to hold them here, then drag them out wherever you need them.'));
    foot.replaceChildren();
    return;
  }
  body.replaceChildren(
    h('p', { class: 'note' }, 'Drag a file out to drop it anywhere (it’s copied, the original stays). Click files to select them (Shift-click for a range) for quick actions.'),
    h('ul', { class: 'list' }, ...shownBelly().map((i) => bellyRow(i, true))),
  );
  const sel = belly.filter((i) => selected.has(i.id));
  if (!sel.length) {
    foot.replaceChildren(); // the fish's speech bubble already says how much it holds
    return;
  }
  const out = btn(`Let out ${sel.length}`, () => api.bellyRemove(sel.map((i) => i.id)));
  foot.replaceChildren(out);
  api.actionsFor(sel.map((i) => i.path)).then((acts) => {
    if (view !== 'belly' || result) return;
    foot.replaceChildren(...acts.map((a) => btn(a.label, () => runAction(a.id, sel.map((i) => i.path)), 'btn small primary')), h('span', { class: 'spacer' }), out);
  });
}

async function renderActions() {
  const items = belly.filter((i) => focusIds.includes(i.id));
  if (!items.length) return setView('belly');
  const total = items.reduce((s, i) => s + i.size, 0);
  body.replaceChildren(
    h('h2', {}, `Swallowed ${plural(items.length, 'item')}`),
    h('p', { class: 'note' }, `${formatBytes(total)} · held in the belly until you let it out.`),
    h('ul', { class: 'list' }, ...items.map((i) => bellyRow(i, false))),
  );
  foot.replaceChildren(btn('Keep in belly', () => api.hide()));
  const acts = await api.actionsFor(items.map((i) => i.path));
  if (view !== 'actions' || result) return;
  body.append(acts.length
    ? h('div', { class: 'actions' }, ...acts.map((a) => btn(a.label, () => runAction(a.id, items.map((i) => i.path)))))
    : h('p', { class: 'note' }, 'No quick actions for these yet. They’ll wait in the belly.'));
}

async function renderRecent() {
  body.replaceChildren(h('p', { class: 'note' }, h('span', { class: 'spinner' }), 'Looking…'));
  foot.replaceChildren();
  let files: RecentFile[];
  try { files = await api.recent(); } catch (e) { return showError(String(e)); }
  if (view !== 'recent' || result) return;
  if (!files.length) {
    body.replaceChildren(h('div', { class: 'empty' }, h('strong', {}, 'Nothing recent'), 'New files in Downloads and on the Desktop show up here.'));
    return;
  }
  body.replaceChildren(
    h('p', { class: 'note' }, 'Newest in Downloads and on the Desktop. Drag one out, or feed it to the fish.'),
    h('ul', { class: 'list' }, ...files.map((f) => {
      const row = h('li', { class: 'row', title: f.path },
        badge(f.ext),
        h('div', { class: 'text' }, h('div', { class: 'name' }, f.name), h('div', { class: 'meta' }, `${formatBytes(f.size)} · ${f.folder} · ${ago(f.time)}`)),
        h('div', { class: 'tools' },
          iconBtn(SHOW_IN, ICON.reveal, () => revealItemInDir(f.path).catch(console.error)),
          iconBtn('Feed to the fish', ICON.feed, () => api.bellyAdd([f.path]).catch(console.error))),
      );
      draggableRow(row, f.path);
      return row;
    })),
  );
}

async function renderTidy() {
  body.replaceChildren(h('p', { class: 'note' }, h('span', { class: 'spinner' }), 'Looking at your Desktop…'));
  foot.replaceChildren();
  let moves: Move[], last: { count: number } | null;
  try { [moves, last] = await Promise.all([api.tidyPreview(), api.tidyLast()]); } catch (e) { return showError(String(e)); }
  if (view !== 'tidy' || result) return;
  const undoBtn = last ? btn(`Undo last tidy (${plural(last.count, 'file')})`, undoTidy) : null;
  if (!moves.length) {
    body.replaceChildren(h('div', { class: 'empty' }, h('strong', {}, 'Your Desktop is tidy'), 'Loose screenshots, PDFs, installers, archives, images and documents get filed away here.'));
    foot.replaceChildren(...(undoBtn ? [undoBtn] : []));
    return;
  }
  const groups = new Map<string, Move[]>();
  for (const m of moves) groups.set(m.rule, [...(groups.get(m.rule) ?? []), m]);
  body.replaceChildren(
    h('p', { class: 'note' }, 'These loose files on your Desktop will be filed away. Nothing is deleted or overwritten, and you can undo.'),
    ...[...groups].map(([rule, ms]) => h('details', { class: 'group' },
      h('summary', {},
        h('div', {}, h('div', {}, h('strong', {}, rule)), h('div', { class: 'dest' }, `→ ${shortDir(ms[0].to)}`)),
        h('span', { class: 'count' }, String(ms.length))),
      h('ul', {}, ...ms.map((m) => h('li', {}, m.from.split(/[\\/]/).pop()!))))),
  );
  foot.replaceChildren(
    btn(`Tidy ${plural(moves.length, 'file')}`, () => applyTidy(moves), 'btn primary'),
    h('span', { class: 'spacer' }),
    ...(undoBtn ? [undoBtn] : []),
  );
}
/** "/Users/me/Pictures/Screenshots/2026-10/x.png" → "Pictures/Screenshots/2026-10" */
function shortDir(p: string) {
  const parts = p.split(/[\\/]/).slice(0, -1);
  const i = parts.findLastIndex((x) => ['Documents', 'Pictures', 'Downloads'].includes(x));
  return parts.slice(Math.max(0, i)).join('/');
}

/* ---------- running things ---------- */
function working(text: string) {
  busy = true;
  body.replaceChildren(h('p', { class: 'note' }, h('span', { class: 'spinner' }), text));
  foot.replaceChildren();
}

function showResult(lines: { text: string; bad?: boolean; details?: string[] }, buttons: HTMLElement[]) {
  busy = false;
  const node = h('div', { class: `result${lines.bad ? ' bad' : ''}` },
    h('p', {}, lines.text),
    lines.details?.length ? h('ul', {}, ...lines.details.map((d) => h('li', {}, d))) : null);
  const done = btn('Done', () => setView(view === 'actions' ? 'belly' : view), 'btn primary');
  result = { node, buttons: [...buttons, h('span', { class: 'spacer' }), done] };
  render();
}
const showError = (msg: string) => showResult({ text: msg, bad: true }, []);

async function runAction(id: string, paths: string[]) {
  working('The fish is on it…');
  let report: ActionReport;
  try { report = await api.runAction(id, paths); } catch (e) { return showError(String(e)); }
  showResult({ text: report.message, details: report.skipped }, [
    btn(SHOW_IN, () => revealItemInDir(report.outputs[0]).catch(console.error)),
    btn('Undo', async () => {
      api.emote('angry').catch(console.error); // the fish is not pleased
      console.info('[panel] undo action', report.outputs);
      try { await api.trashOutputs(report.outputs); showResult({ text: `Moved ${plural(report.outputs.length, 'new file')} to the Trash.` }, []); }
      catch (e) { showError(String(e)); }
    }),
  ]);
}

const failures = (r: TidyReport) => r.failed.map(([p, why]) => `${p.split(/[\\/]/).pop()}: ${why}`);

async function applyTidy(moves: Move[]) {
  working(`Tidying ${plural(moves.length, 'file')}…`);
  let r: TidyReport;
  try { r = await api.tidyApply(moves); } catch (e) { return showError(String(e)); }
  showResult({ text: `Filed away ${plural(r.moved.length, 'file')}.`, bad: !r.moved.length, details: failures(r) },
    r.moved.length ? [btn('Undo', undoTidy), btn(SHOW_IN, () => revealItemInDir(r.moved[0].to).catch(console.error))] : []);
}

async function undoTidy() {
  api.emote('angry').catch(console.error);
  working('Putting files back…');
  let r: TidyReport;
  try { r = await api.tidyUndo(); } catch (e) { return showError(String(e)); }
  showResult({ text: `Put ${plural(r.moved.length, 'file')} back on the Desktop.`, bad: !!r.failed.length && !r.moved.length, details: failures(r) }, []);
}

/* ---------- wiring ---------- */
for (const t of tabs) t.addEventListener('click', () => setView(t.dataset.view as View));
document.getElementById('close')!.addEventListener('click', () => api.hide());
document.getElementById('play')!.addEventListener('click', () => api.play().catch((e) => showError(String(e))));
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') api.hide(); });
// Behave like a popover: clicking anywhere else closes it (Rust keeps it open while
// the fish is being pressed or dragged, so it can come along).
if (inTauri) getCurrentWindow().onFocusChanged(({ payload: focused }) => {
  if (!focused && !busy && !dragging) api.blurred().catch(console.error);
});

// Drag the panel by its top bar; the fish follows. Clicks on tabs still work because
// the drag only starts once the pointer actually moves.
const bar = document.querySelector<HTMLElement>('.bar')!;
let barPress: { x: number; y: number } | null = null;
bar.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || (e.target as HTMLElement).closest('#close, #play')) return;
  barPress = { x: e.clientX, y: e.clientY };
});
window.addEventListener('pointerup', () => { barPress = null; bar.classList.remove('dragging'); });
bar.addEventListener('pointermove', (e) => {
  if (!barPress || Math.hypot(e.clientX - barPress.x, e.clientY - barPress.y) < 3) return;
  barPress = null;
  bar.classList.add('dragging');
  if (inTauri) api.followBegin().finally(() => getCurrentWindow().startDragging().catch(console.error));
});

api.glass().then((on) => document.body.classList.toggle('glass', on));

function setBelly(items: BellyItem[]) {
  belly = items;
  if ((view === 'belly' || view === 'actions') && !result && !busy) render();
}
if (inTauri) listen<BellyItem[]>('belly://changed', ({ payload }) => setBelly(payload));
if (inTauri) listen<{ view: View; ids: number[] }>('panel://open', async ({ payload }) => {
  belly = await api.bellyList();
  focusIds = payload.ids;
  selected.clear();
  if (!busy) setView(payload.view);
  else api.showingView(view).catch(console.error);
  if (!document.body.classList.contains('glass')) {
    // No native zoom here (Windows / older macOS): a CSS pop-in instead.
    document.body.classList.remove('opening');
    void document.body.offsetWidth;
    document.body.classList.add('opening');
  }
});
api.bellyList().then((items) => {
  setBelly(items);
  const v = new URLSearchParams(location.search).get('view') as View | null; // preview: ?view=tidy
  if (!inTauri) { focusIds = [items[0]?.id ?? 0, items[1]?.id ?? 0]; setView(v ?? 'belly'); }
});
api.dragIcon().then((p) => { iconPath = p; }).catch(console.error);
