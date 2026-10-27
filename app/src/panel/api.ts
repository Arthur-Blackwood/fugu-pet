// Typed wrappers around the Rust commands the panel uses.
import { invoke } from '@tauri-apps/api/core';
import { emitTo } from '@tauri-apps/api/event';
import { DEFAULT_SETTINGS, type Settings } from '../settings';

export interface BellyItem { id: number; path: string; name: string; ext: string | null; size: number; is_dir: boolean; size_complete: boolean; added_at: number }
export interface RecentFile { path: string; name: string; ext: string | null; size: number; time: number; folder: string }
export interface Move { from: string; to: string; rule: string }
export interface TidyReport { moved: Move[]; failed: [string, string][] }
export interface ActionInfo { id: string; label: string; count: number }
export interface ActionReport { outputs: string[]; message: string; skipped: string[] }

export const inTauri = '__TAURI_INTERNALS__' in window;

const tauriApi = {
  bellyList: () => invoke<BellyItem[]>('belly_list'),
  bellyAdd: (paths: string[]) => invoke<BellyItem[]>('belly_add', { paths }),
  bellyRemove: (ids: number[]) => invoke<number[]>('belly_remove', { ids }),
  recent: () => invoke<RecentFile[]>('recent_files', { limit: 10 }),
  tidyPreview: () => invoke<Move[]>('tidy_preview'),
  tidyApply: (moves: Move[]) => invoke<TidyReport>('tidy_apply', { moves }),
  tidyLast: () => invoke<{ at: number; count: number } | null>('tidy_last'),
  tidyUndo: () => invoke<TidyReport>('tidy_undo'),
  actionsFor: (paths: string[]) => invoke<ActionInfo[]>('actions_for', { paths }),
  runAction: (id: string, paths: string[]) => invoke<ActionReport>('run_action', { id, paths }),
  trashOutputs: (paths: string[]) => invoke<void>('trash_outputs', { paths }),
  hide: () => invoke<void>('panel_hide'),
  blurred: () => invoke<void>('panel_blurred'),
  glass: () => invoke<boolean>('panel_glass'),
  followBegin: () => invoke<void>('follow_begin', { leader: 'panel' }),
  dragIcon: () => invoke<string>('drag_icon'),
  settingsGet: () => invoke<Settings>('settings_get'),
  settingsSet: (settings: Settings) => invoke<Settings>('settings_set', { settings }),
  /** Tell the fish what the panel is showing ("belly", "settings", …). */
  showingView: (view: string) => emitTo('main', 'pet://panel-view', view),
  play: () => invoke<void>('play_set', { on: true }),
  /** Make the fish react, e.g. "angry". */
  emote: (kind: 'angry') => emitTo('main', 'pet://emote', kind),
};

/* Browser preview (`npm run dev`, then /panel.html): sample data, no filesystem. */
const now = Date.now();
const MB = 1e6;
let mockBelly: BellyItem[] = [
  { id: 1, path: '/Users/me/Downloads/lecture_week05.pdf', name: 'lecture_week05.pdf', ext: 'pdf', size: 4.2 * MB, is_dir: false, size_complete: true, added_at: now },
  { id: 2, path: '/Users/me/Desktop/IMG_4821.HEIC', name: 'IMG_4821.HEIC', ext: 'heic', size: 2.9 * MB, is_dir: false, size_complete: true, added_at: now },
  { id: 3, path: '/Users/me/Documents/STAT1008 project', name: 'STAT1008 project', ext: null, size: 380 * MB, is_dir: true, size_complete: true, added_at: now },
];
const mockApi: typeof tauriApi = {
  bellyList: async () => mockBelly,
  bellyAdd: async () => [],
  bellyRemove: async (ids) => { mockBelly = mockBelly.filter((i) => !ids.includes(i.id)); return ids; },
  recent: async () => [
    { path: '/Users/me/Downloads/Assignment 2 rubric.docx', name: 'Assignment 2 rubric.docx', ext: 'docx', size: 88e3, time: now - 4 * 60e3, folder: 'Downloads' },
    { path: '/Users/me/Desktop/Screenshot 2026-10-10 at 14.02.11.png', name: 'Screenshot 2026-10-10 at 14.02.11.png', ext: 'png', size: 1.3 * MB, time: now - 3 * 3600e3, folder: 'Desktop' },
    { path: '/Users/me/Downloads/dataset.zip', name: 'dataset.zip', ext: 'zip', size: 640 * MB, time: now - 26 * 3600e3, folder: 'Downloads' },
  ],
  tidyPreview: async () => [
    { from: '/Users/me/Desktop/Screenshot 1.png', to: '/Users/me/Pictures/Screenshots/2026-10/Screenshot 1.png', rule: 'Screenshots' },
    { from: '/Users/me/Desktop/Screenshot 2.png', to: '/Users/me/Pictures/Screenshots/2026-10/Screenshot 2.png', rule: 'Screenshots' },
    { from: '/Users/me/Desktop/paper.pdf', to: '/Users/me/Documents/PDF/paper.pdf', rule: 'PDFs' },
    { from: '/Users/me/Desktop/Zoom.pkg', to: '/Users/me/Downloads/Installers/Zoom.pkg', rule: 'Installers' },
  ],
  tidyApply: async (moves) => ({ moved: moves, failed: [] }),
  tidyLast: async () => null,
  tidyUndo: async () => ({ moved: [], failed: [] }),
  actionsFor: async (paths) => [
    ...(paths.some((p) => /\.(heic|png|jpe?g)$/i.test(p)) ? [{ id: 'image.compress', label: 'Compress image to under 1 MB', count: 1 }, { id: 'image.heic_to_jpg', label: 'Convert HEIC to JPG', count: 1 }] : []),
  ],
  runAction: async () => { await new Promise((r) => setTimeout(r, 900)); return { outputs: ['/Users/me/Desktop/IMG_4821 (compressed).jpg'], message: 'Created IMG_4821 (compressed).jpg', skipped: [] }; },
  trashOutputs: async () => {},
  hide: async () => {},
  blurred: async () => {},
  glass: async () => false,
  followBegin: async () => {},
  dragIcon: async () => '',
  settingsGet: async () => ({ ...mockSettings }),
  settingsSet: async (s) => (mockSettings = { ...s }),
  showingView: async () => {},
  play: async () => {},
  emote: async () => {},
};
let mockSettings: Settings = { ...DEFAULT_SETTINGS };

// The mock only exists in dev builds.
export const api = inTauri || !import.meta.env.DEV ? tauriApi : mockApi;
