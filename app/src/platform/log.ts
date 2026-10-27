import { invoke } from '@tauri-apps/api/core';

/** Mirror console warnings/errors and drop logs into the terminal running the app. */
export function forwardLogs() {
  for (const level of ['info', 'warn', 'error'] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig(...args);
      const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      invoke('frontend_log', { level, msg }).catch(() => {});
    };
  }
  window.addEventListener('error', (e) => console.error(`${e.message} @ ${e.filename}:${e.lineno}`));
  window.addEventListener('unhandledrejection', (e) => console.error('unhandled rejection', String(e.reason)));
}
