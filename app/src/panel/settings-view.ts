// Settings tab: tweaks to the fish, applied live (the fish window listens for changes).
import { api } from './api';
import { DEFAULT_SETTINGS, FOLLOW_FULL_SCREEN, type Settings } from '../settings';

type NumKey = { [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings];
type BoolKey = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];

type Control =
  | { kind: 'switch'; key: BoolKey; label: string; note?: string }
  | { kind: 'slider'; key: NumKey; label: string; min: number; max: number; step: number; fmt: (v: number) => string }
  | { kind: 'select'; key: NumKey; label: string; options: [number, string][] };

const times = (v: number) => `${v.toFixed(v < 1 ? 2 : 1)}×`;

const GROUPS: [string, Control[]][] = [
  ['Fish', [
    { kind: 'switch', key: 'showFish', label: 'Show fish', note: 'Hidden fish: open the panel from the menu bar icon.' },
    { kind: 'slider', key: 'size', label: 'Size', min: 0.6, max: 1.6, step: 0.05, fmt: times },
  ]],
  ['Motion', [
    { kind: 'slider', key: 'finSpeed', label: 'Fin speed', min: 0.25, max: 3, step: 0.05, fmt: times },
    { kind: 'slider', key: 'motion', label: 'Swimming sway', min: 0, max: 2, step: 0.05, fmt: (v) => (v === 0 ? 'Still' : times(v)) },
    { kind: 'switch', key: 'fidgets', label: 'Idle fidgets', note: 'Turns, little swims and bubbles now and then.' },
    { kind: 'switch', key: 'bodyFollow', label: 'Whole fish follows the cursor', note: 'Turns, tilts and leans toward the pointer.' },
    { kind: 'switch', key: 'eyesFollow', label: 'Eyes follow the cursor' },
    { kind: 'slider', key: 'followRange', label: 'Follow range', min: 150, max: FOLLOW_FULL_SCREEN, step: 50, fmt: (v) => (v >= FOLLOW_FULL_SCREEN ? 'Full screen' : `${v} px`) },
  ]],
  ['Effects', [
    { kind: 'slider', key: 'bubbles', label: 'Bubbles', min: 0, max: 3, step: 0.1, fmt: (v) => (v === 0 ? 'Off' : times(v)) },
    { kind: 'switch', key: 'hoverGlow', label: 'Lighten on hover' },
  ]],
  ['Power', [
    { kind: 'select', key: 'sleepMinutes', label: 'Fall asleep after', options: [[2, '2 min'], [5, '5 min'], [10, '10 min'], [30, '30 min'], [0, 'Never']] },
    { kind: 'switch', key: 'batterySaver', label: 'Battery saver', note: 'Halves the frame rate.' },
  ]],
];

let saveTimer: ReturnType<typeof setTimeout> | undefined;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

export async function renderSettings(body: HTMLElement, foot: HTMLElement, stillHere: () => boolean) {
  const s = await api.settingsGet();
  if (!stillHere()) return;
  const save = (now = false) => {
    clearTimeout(saveTimer);
    const go = () => api.settingsSet({ ...s }).catch(console.error);
    if (now) go(); else saveTimer = setTimeout(go, 60); // sliders: a few saves per second at most
  };

  const groups = GROUPS.map(([name, controls]) => {
    const section = el('section', 'settings-group');
    section.append(el('h3', '', name));
    for (const c of controls) {
      const row = el('label', `setting setting-${c.kind}`);
      const text = el('span', 'setting-text');
      text.append(el('span', 'setting-label', c.label));
      if (c.kind === 'switch' && c.note) text.append(el('span', 'setting-note', c.note));
      row.append(text);
      if (c.kind === 'switch') {
        const input = el('input', 'switch') as HTMLInputElement;
        input.type = 'checkbox';
        input.role = 'switch';
        input.checked = s[c.key];
        input.addEventListener('change', () => { s[c.key] = input.checked; save(true); });
        row.append(input);
      } else if (c.kind === 'slider') {
        const value = el('output', 'setting-value', c.fmt(s[c.key]));
        const input = el('input', 'slider') as HTMLInputElement;
        Object.assign(input, { type: 'range', min: String(c.min), max: String(c.max), step: String(c.step), value: String(s[c.key]) });
        input.setAttribute('aria-label', c.label);
        const fill = () => input.style.setProperty('--fill', `${((s[c.key] - c.min) / (c.max - c.min)) * 100}%`);
        input.addEventListener('input', () => { s[c.key] = Number(input.value); value.textContent = c.fmt(s[c.key]); fill(); save(); });
        fill();
        text.append(value);
        row.append(input);
      } else {
        const select = el('select', 'select') as HTMLSelectElement;
        for (const [v, label] of c.options) {
          const o = el('option', '', label) as HTMLOptionElement;
          o.value = String(v);
          o.selected = s[c.key] === v;
          select.append(o);
        }
        select.addEventListener('change', () => { s[c.key] = Number(select.value); save(true); });
        row.append(select);
      }
      section.append(row);
    }
    return section;
  });
  body.replaceChildren(...groups);

  const reset = el('button', 'btn', 'Reset to defaults');
  reset.addEventListener('click', async () => {
    await api.settingsSet({ ...DEFAULT_SETTINGS });
    if (stillHere()) renderSettings(body, foot, stillHere);
  });
  foot.replaceChildren(reset);
}
