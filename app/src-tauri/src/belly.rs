//! F4 holding area ("the belly"). Holds *references* to files the user fed the fish —
//! nothing is copied or moved on the way in. Persisted as JSON in the app data dir.

use crate::files::{self, FileInfo};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct BellyItem {
    pub id: u64,
    #[serde(flatten)]
    pub file: FileInfo,
    /// Unix ms.
    pub added_at: u64,
}

#[derive(Serialize, Deserialize, Default)]
struct Saved {
    next_id: u64,
    items: Vec<BellyItem>,
}

pub struct Belly {
    inner: Mutex<Saved>,
    file: PathBuf,
}

/// Emitted to every window whenever the contents change: the full list.
const CHANGED: &str = "belly://changed";
/// Emitted when items leave the belly (removed, dragged out): their ids.
const REMOVED: &str = "belly://removed";
/// Emitted when items are swallowed (dropped on the fish, fed from the panel): the new items.
const ADDED: &str = "belly://added";

impl Belly {
    pub fn load(app: &AppHandle) -> Self {
        let file = app
            .path()
            .app_data_dir()
            .map(|d| d.join("belly.json"))
            .unwrap_or_else(|_| PathBuf::from("belly.json"));
        let mut saved: Saved = std::fs::read(&file)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        // Forget files that were moved or deleted while the app wasn't running.
        saved.items.retain(|i| Path::new(&i.file.path).exists());
        Belly { inner: Mutex::new(saved), file }
    }

    fn save(&self, saved: &Saved) {
        if let Some(dir) = self.file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_vec_pretty(saved) {
            let _ = std::fs::write(&self.file, json);
        }
    }

    /// Files the app itself moved (tidy, undo): keep the belly pointing at them.
    pub fn repath(&self, app: &AppHandle, moves: &[(String, String)]) {
        let mut saved = self.inner.lock().unwrap();
        let mut changed = false;
        for item in saved.items.iter_mut() {
            if let Some((_, to)) = moves.iter().find(|(from, _)| *from == item.file.path) {
                item.file.path = to.clone();
                changed = true;
            }
        }
        if changed {
            self.save(&saved);
            let _ = app.emit(CHANGED, &saved.items);
        }
    }

    fn remove(&self, app: &AppHandle, ids: &[u64]) -> Vec<u64> {
        let mut saved = self.inner.lock().unwrap();
        let before: Vec<u64> = saved.items.iter().map(|i| i.id).collect();
        saved.items.retain(|i| !ids.contains(&i.id));
        let removed: Vec<u64> = before.into_iter().filter(|id| ids.contains(id)).collect();
        if !removed.is_empty() {
            self.save(&saved);
            let _ = app.emit(REMOVED, &removed);
            let _ = app.emit(CHANGED, &saved.items);
        }
        removed
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[tauri::command]
pub fn belly_list(app: AppHandle, belly: State<'_, Belly>) -> Vec<BellyItem> {
    let mut saved = belly.inner.lock().unwrap();
    let n = saved.items.len();
    saved.items.retain(|i| Path::new(&i.file.path).exists());
    if saved.items.len() != n {
        belly.save(&saved);
        let _ = app.emit(CHANGED, &saved.items);
    }
    saved.items.clone()
}

/// Swallow dropped paths. Returns only the newly added items (paths already in the
/// belly are ignored).
#[tauri::command]
pub async fn belly_add(app: AppHandle, belly: State<'_, Belly>, paths: Vec<PathBuf>) -> Result<Vec<BellyItem>, String> {
    let fresh: Vec<PathBuf> = {
        let saved = belly.inner.lock().unwrap();
        paths
            .into_iter()
            .filter(|p| !saved.items.iter().any(|i| Path::new(&i.file.path) == p.as_path()))
            .collect()
    };
    let infos = files::describe_all(fresh).await?;
    let mut saved = belly.inner.lock().unwrap();
    let added: Vec<BellyItem> = infos
        .into_iter()
        .map(|file| {
            saved.next_id += 1;
            BellyItem { id: saved.next_id, file, added_at: now_ms() }
        })
        .collect();
    saved.items.extend(added.iter().cloned());
    belly.save(&saved);
    if !added.is_empty() {
        let _ = app.emit(ADDED, &added);
    }
    let _ = app.emit(CHANGED, &saved.items);
    Ok(added)
}

/// Let items out of the belly (the files themselves are untouched).
#[tauri::command]
pub fn belly_remove(app: AppHandle, belly: State<'_, Belly>, ids: Vec<u64>) -> Vec<u64> {
    belly.remove(&app, &ids)
}

/// Spit out the most recently swallowed item.
#[tauri::command]
pub fn belly_pop(app: AppHandle, belly: State<'_, Belly>) -> Option<u64> {
    let last = belly.inner.lock().unwrap().items.last().map(|i| i.id)?;
    belly.remove(&app, &[last]).first().copied()
}
