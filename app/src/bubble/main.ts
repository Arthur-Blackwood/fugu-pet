// The fish's speech bubble window: shows whatever the fish says (see bubble.rs).
import './bubble.css';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';

const title = document.getElementById('title')!;
const detail = document.getElementById('detail')!;

listen<{ title: string; detail: string }>('bubble://say', ({ payload }) => {
  title.textContent = payload.title;
  detail.textContent = payload.detail;
});
invoke<boolean>('panel_glass').then((on) => document.body.classList.toggle('glass', on)).catch(() => {});
