import type { Pet } from '../fish/renderer';

export const DRAG_THRESHOLD_PX = 4;
/** How long a lone click waits for a possible second click before opening the panel. */
const SINGLE_WAIT_MS = 250;

/**
 * Click handling, fed with the OS click count (`MouseEvent.detail`), so double-clicks
 * follow the user's system double-click speed. Every first click nudges the fish; a
 * double-click toggles a held puff; a lone click calls `onSingle` (opens the panel).
 * If a slow double-click arrives after `onSingle` already ran, `onSingleUndo` reverts it.
 */
export function bindClicks(pet: Pet, onSingle?: () => void, onSingleUndo?: () => void) {
  let single: ReturnType<typeof setTimeout> | undefined;
  let singleRan = false;
  return {
    click(x: number, count: number) {
      clearTimeout(single);
      if (count >= 2) {
        if (count % 2 === 0) {
          if (singleRan) onSingleUndo?.();
          singleRan = false;
          pet.states.togglePuff();
        }
        return;
      }
      singleRan = false;
      pet.states.poke(Math.sign(x - pet.fishScreen().x));
      if (onSingle) single = setTimeout(() => { singleRan = true; onSingle(); }, SINGLE_WAIT_MS);
    },
  };
}
