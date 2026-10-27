//! User settings (Settings tab), persisted as JSON and broadcast to every window.

use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub show_fish: bool,
    /// Fish size multiplier.
    pub size: f64,
    pub fin_speed: f64,
    /// Bobbing / rolling amount.
    pub motion: f64,
    /// Bubble amount multiplier (0 = off).
    pub bubbles: f64,
    pub eyes_follow: bool,
    /// The whole fish turns and leans toward the cursor, not just its eyes.
    pub body_follow: bool,
    /// How far from the fish (logical px) the cursor is followed; FOLLOW_FULL_SCREEN
    /// or more means anywhere on screen.
    pub follow_range: f64,
    pub fidgets: bool,
    pub hover_glow: bool,
    /// Minutes of inactivity before sleeping; 0 = never.
    pub sleep_minutes: u32,
    /// Lower frame rates.
    pub battery_saver: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            show_fish: true,
            size: 1.0,
            fin_speed: 1.0,
            motion: 1.0,
            bubbles: 1.0,
            eyes_follow: true,
            body_follow: true,
            follow_range: 900.0,
            fidgets: true,
            hover_glow: true,
            sleep_minutes: 10,
            battery_saver: false,
        }
    }
}

impl Settings {
    /// Keep values in the ranges the UI offers, whatever the JSON says.
    fn clamped(mut self) -> Self {
        self.size = self.size.clamp(0.6, 1.6);
        self.fin_speed = self.fin_speed.clamp(0.25, 3.0);
        self.motion = self.motion.clamp(0.0, 2.0);
        self.bubbles = self.bubbles.clamp(0.0, 3.0);
        self.sleep_minutes = self.sleep_minutes.min(240);
        self.follow_range = self.follow_range.clamp(150.0, FOLLOW_FULL_SCREEN);
        self
    }
}

/// Follow range at the top of the slider: the whole screen.
pub const FOLLOW_FULL_SCREEN: f64 = 2000.0;

impl Settings {
    /// Cursor-follow radius in logical px (infinite at the slider's maximum).
    pub fn follow_radius(&self) -> f64 {
        if self.follow_range >= FOLLOW_FULL_SCREEN { f64::INFINITY } else { self.follow_range }
    }
}

pub struct Store {
    current: Mutex<Settings>,
    file: PathBuf,
}

impl Store {
    pub fn load(app: &AppHandle) -> Self {
        let file = app.path().app_data_dir().map(|d| d.join("settings.json")).unwrap_or_else(|_| "settings.json".into());
        let current = std::fs::read(&file)
            .ok()
            .and_then(|b| serde_json::from_slice::<Settings>(&b).ok())
            .unwrap_or_default()
            .clamped();
        Store { current: Mutex::new(current), file }
    }

    pub fn get(&self) -> Settings {
        self.current.lock().unwrap().clone()
    }
}

/// Apply the parts the backend owns (window visibility).
pub fn apply(app: &AppHandle, s: &Settings) {
    // Only touch the window when visibility actually changes: show() activates it,
    // which would steal focus from the panel and close it mid-adjustment.
    if let Some(pet) = app.get_webview_window("main") {
        let visible = pet.is_visible().unwrap_or(true);
        if s.show_fish && !visible {
            crate::panel::panel_keep(); // showing the fish blurs the panel; keep it open
            let _ = pet.show();
            if let Some(panel) = app.get_webview_window("panel").filter(|p| p.is_visible().unwrap_or(false)) {
                let _ = panel.set_focus();
            }
        } else if !s.show_fish && visible {
            let _ = pet.hide();
        }
    }
    if !s.show_fish {
        crate::bubble::hide_now(app);
    }
}

#[tauri::command]
pub fn settings_get(store: State<'_, Store>) -> Settings {
    store.get()
}

#[tauri::command]
pub fn settings_set(app: AppHandle, store: State<'_, Store>, settings: Settings) -> Settings {
    let s = settings.clamped();
    *store.current.lock().unwrap() = s.clone();
    if let Some(dir) = store.file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_vec_pretty(&s) {
        let _ = std::fs::write(&store.file, json);
    }
    apply(&app, &s);
    let _ = app.emit("settings://changed", &s);
    s
}

/// Tray: bring a hidden fish back.
pub fn show_fish(app: &AppHandle) {
    let store = app.state::<Store>();
    let mut s = store.get();
    if !s.show_fish {
        s.show_fish = true;
        settings_set(app.clone(), store, s);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_and_out_of_range_fields_are_safe() {
        let s: Settings = serde_json::from_str(r#"{"size": 9, "bubbles": -1}"#).unwrap();
        let s = s.clamped();
        assert_eq!(s.size, 1.6);
        assert_eq!(s.bubbles, 0.0);
        assert!(s.show_fish, "unspecified fields take defaults");
    }
}
