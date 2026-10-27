import './styles.css';
import { createPet } from './fish/renderer';
import { formatBytes } from './fish/growth';
import { initOverlays } from './overlay';

const canvas = document.getElementById('pet') as HTMLCanvasElement;
const hud = document.getElementById('hud')!;
const isTauri = '__TAURI_INTERNALS__' in window;

let debug = !isTauri;
const setDebug = (on: boolean) => { debug = on; document.body.classList.toggle('debug', on); };
setDebug(debug);

const pet = createPet(canvas, { pauseWhenHidden: isTauri });
initOverlays(pet);
if (import.meta.env.DEV) (window as unknown as { __fish: unknown }).__fish = pet;

setInterval(() => {
  if (!debug) return;
  const { stats, states } = pet;
  hud.textContent = `${states.state} · ${stats.fps}/${stats.cap} fps\ninflate ${stats.inflate.toFixed(2)} · belly ${states.holding.length} (${formatBytes(states.bellyBytes)}) · size ×${stats.scale.toFixed(2)} · bubbles ${stats.bubbles} (peak ${stats.bubblesPeak})`;
}, 250);

if (isTauri) {
  import('./platform/tauri').then((m) => m.attachTauri(pet, canvas, setDebug)).catch(console.error);
} else {
  import('./platform/browser').then((m) => m.attachBrowser(pet, canvas));
}
