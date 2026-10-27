// How big the belly contents make the fish. Log scale, so small files still register
// and huge folders don't blow it up: 1 MB ≈ 0.07, 100 MB ≈ 0.46, 1 GB ≈ 0.70, 20 GB = 1.

const MB = 1e6;
/** Belly size at which growth maxes out. */
const FULL_BYTES = 20e9;

/** Overall size multiplier at full growth. */
export const MAX_SCALE = 1.6;

/** 0…1 growth for a byte count. */
export function growthOf(bytes: number) {
  if (bytes <= 0) return 0;
  return Math.min(1, Math.log10(1 + bytes / MB) / Math.log10(1 + FULL_BYTES / MB));
}

export const scaleOf = (growth: number) => 1 + (MAX_SCALE - 1) * growth;

export function formatBytes(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes, i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
