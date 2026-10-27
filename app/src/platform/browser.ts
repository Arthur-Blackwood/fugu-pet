// Plain-browser host for `npm run dev` previews: no window tricks, keyboard shortcuts
// stand in for the tray menu.
import type { Pet } from '../fish/renderer';
import type { State } from '../fish/states';
import { bindClicks } from './input';
import { setGear } from '../overlay';

const KEYS: Record<string, State> = { '1': 'working', '2': 'happy', '3': 'puff', '4': 'error', '5': 'sleep', '6': 'angry', '0': 'idle' };
/** Preview what the panel tabs do to the fish: b = Belly, , = Settings, x = closed. */
const VIEWS: Record<string, string> = { b: 'belly', ',': 'settings', x: 'closed' };

export function attachBrowser(pet: Pet, canvas: HTMLCanvasElement) {
  const clicks = bindClicks(pet);
  window.addEventListener('pointermove', (e) => {
    pet.setPointer(e.clientX, e.clientY);
    const hit = pet.hitAt(e.clientX, e.clientY);
    pet.setHover(hit);
    canvas.style.cursor = hit ? 'grab' : 'default';
  });
  canvas.addEventListener('click', (e) => { if (pet.hitAt(e.clientX, e.clientY)) clicks.click(e.clientX, e.detail || 1); });
  window.addEventListener('keydown', (e) => {
    if (KEYS[e.key]) pet.states.set(KEYS[e.key]);
    else if (VIEWS[e.key]) { pet.states.panelView(VIEWS[e.key]); setGear(VIEWS[e.key] === 'settings'); }
    else if (e.key === 'f') pet.states.feed([{ name: `notes-${pet.states.holding.length + 1}.pdf`, size: 2.4e6 }]);
    else if (e.key === 'g') pet.states.feed([{ name: `dataset-${pet.states.holding.length + 1}`, size: 3e9 }]);
    else if (e.key === 's') pet.states.spit();
  });
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    pet.setPointer(e.clientX, e.clientY);
    if (pet.states.state !== 'ready' && pet.states.state !== 'catch') pet.states.set('ready');
  });
  window.addEventListener('dragleave', (e) => { if (!e.relatedTarget && pet.states.state === 'ready') pet.states.set('idle'); });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer?.files ?? []).map((f) => ({ name: f.name, size: f.size }));
    pet.states.feed(files.length ? files : [{ name: 'dropped item', size: 0 }]);
  });
  const initial = new URLSearchParams(location.search).get('state') as State | null;
  if (initial) pet.states.set(initial);
}
