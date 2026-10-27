// HTML overlays drawn over the fish (gear while Settings is open).
import type { Pet } from './fish/renderer';

/** Gear outline: `teeth` square teeth around a ring with a hole, in a 48×48 box. */
function gearPath(teeth = 8, rOut = 22, rIn = 16.5, rHole = 7) {
  const c = 24, step = (Math.PI * 2) / teeth, tw = step * 0.26;
  let d = '';
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    const pts: [number, number][] = [
      [a - step / 2 + tw, rIn], [a - tw, rIn], [a - tw * 0.78, rOut], [a + tw * 0.78, rOut], [a + tw, rIn], [a + step / 2 - tw, rIn],
    ];
    for (const [ang, r] of pts) d += `${d ? 'L' : 'M'}${(c + Math.cos(ang) * r).toFixed(2)} ${(c + Math.sin(ang) * r).toFixed(2)}`;
  }
  d += 'Z';
  // hole (opposite winding via evenodd)
  d += `M${c + rHole} ${c}A${rHole} ${rHole} 0 1 0 ${c - rHole} ${c}A${rHole} ${rHole} 0 1 0 ${c + rHole} ${c}Z`;
  return d;
}

let gear: HTMLElement | null = null;
let on = false;

export function initOverlays(pet: Pet) {
  gear = document.createElement('div');
  gear.id = 'gear';
  gear.setAttribute('aria-hidden', 'true');
  gear.innerHTML = `<div class="pop"><svg viewBox="0 0 48 48"><path fill-rule="evenodd" d="${gearPath()}"/></svg></div>`;
  document.body.append(gear);
  const track = () => {
    if (on && gear) {
      const c = pet.fishScreen();
      gear.style.transform = `translate(${c.x}px, ${c.y}px)`;
      gear.style.setProperty('--s', String(pet.stats.scale));
    }
    requestAnimationFrame(track);
  };
  requestAnimationFrame(track);
}

/** Show the gear in the middle of the fish (Settings tab open). */
export function setGear(show: boolean) {
  on = show;
  gear?.classList.toggle('on', show);
}
