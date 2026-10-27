// User settings shared by the fish modules. The Rust side persists them; the fish
// window receives updates over `settings://changed` and modules read this object live.

export interface Settings {
  showFish: boolean;
  /** Fish size multiplier. */
  size: number;
  finSpeed: number;
  /** Bobbing / rolling amount. */
  motion: number;
  /** Bubble amount multiplier (0 = off). */
  bubbles: number;
  eyesFollow: boolean;
  /** The whole fish turns and leans toward the cursor. */
  bodyFollow: boolean;
  /** How far from the fish (CSS px) the cursor is followed; FOLLOW_FULL_SCREEN = anywhere. */
  followRange: number;
  fidgets: boolean;
  hoverGlow: boolean;
  /** Minutes idle before sleeping; 0 = never. */
  sleepMinutes: number;
  batterySaver: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  showFish: true,
  size: 1,
  finSpeed: 1,
  motion: 1,
  bubbles: 1,
  eyesFollow: true,
  bodyFollow: true,
  followRange: 900,
  fidgets: true,
  hoverGlow: true,
  sleepMinutes: 10,
  batterySaver: false,
};

/** Follow range at the top of the slider: the whole screen. */
export const FOLLOW_FULL_SCREEN = 2000;
export const followRadius = (s: Settings) => (s.followRange >= FOLLOW_FULL_SCREEN ? Infinity : s.followRange);

export const settings: Settings = { ...DEFAULT_SETTINGS };

export function applySettings(s: Partial<Settings>) {
  Object.assign(settings, s);
}
