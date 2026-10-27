//! The fish's speech bubble: a small glass window placed near the fish so that it
//! never overlaps the panel, and moved along when either is dragged.

use crate::anim;
use serde::Serialize;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use tauri::{AppHandle, Emitter, LogicalPosition, Manager, WebviewWindow};

/// Bubble window size (matches tauri.conf.json).
pub const W: f64 = 250.0;
pub const H: f64 = 64.0;
/// Corner radius (matches the bubble's CSS).
pub const RADIUS: f64 = 20.0;
/// Space kept between the bubble and the fish / panel.
const GAP: f64 = 10.0;

/// Where the bubble zooms back to when it closes (screen logical px).
static ANCHOR: Mutex<(f64, f64)> = Mutex::new((0.0, 0.0));
/// Bumped on every show, so a close that finishes late can't hide a newer bubble.
static GEN: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize, Clone)]
struct Say {
    title: String,
    detail: String,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    fn overlaps(&self, o: &Rect, gap: f64) -> bool {
        self.x < o.x + o.w + gap && o.x < self.x + self.w + gap && self.y < o.y + o.h + gap && o.y < self.y + self.h + gap
    }
}

/// Bubble position for a fish whose top-centre is `top` and bottom is `bottom_y`,
/// avoiding `panel` (if open), inside `area`.
pub fn place(top: (f64, f64), bottom_y: f64, panel: Option<Rect>, area: Rect) -> (f64, f64) {
    let clamp = |x: f64, y: f64| (x.clamp(area.x, area.x + area.w - W), y.clamp(area.y, area.y + area.h - H));
    let away_from_panel = |x: f64| match panel {
        // Panel on the fish's left: start right of it; otherwise end left of it.
        Some(p) if p.x + p.w / 2.0 < top.0 => (p.x + p.w + GAP).max(x),
        Some(p) => (p.x - W - GAP).min(x),
        None => x,
    };
    let free = |(x, y): (f64, f64)| panel.is_none_or(|p| !Rect { x, y, w: W, h: H }.overlaps(&p, GAP / 2.0));
    let centred = top.0 - W / 2.0;
    let candidates = [
        clamp(centred, top.1 - H - GAP),                    // above the fish
        clamp(away_from_panel(centred), top.1 - H - GAP),   // above, slid away from the panel
        clamp(centred, bottom_y + GAP),                     // below the fish
        clamp(away_from_panel(centred), bottom_y + GAP),    // below, slid away
    ];
    candidates.into_iter().find(|&c| free(c)).unwrap_or(candidates[1])
}

fn rect_of(w: &WebviewWindow) -> Option<Rect> {
    let sf = w.scale_factor().ok()?;
    let p = w.outer_position().ok()?.to_logical::<f64>(sf);
    let s = w.outer_size().ok()?.to_logical::<f64>(sf);
    Some(Rect { x: p.x, y: p.y, w: s.width, h: s.height })
}

/// Say something. `top_*` / `bottom_y` are the fish's extent in pet-window logical px.
#[tauri::command]
pub fn bubble_say(app: AppHandle, title: String, detail: String, top_x: f64, top_y: f64, bottom_y: f64) -> Result<(), String> {
    let pet = app.get_webview_window("main").ok_or("pet window missing")?;
    let bubble = app.get_webview_window("bubble").ok_or("bubble window missing")?;
    let pet_r = rect_of(&pet).ok_or("pet window geometry")?;
    let panel = app.get_webview_window("panel").filter(|p| p.is_visible().unwrap_or(false)).and_then(|p| rect_of(&p));
    let mon = pet.current_monitor().map_err(|e| e.to_string())?.ok_or("no monitor")?;
    let msf = mon.scale_factor();
    let ap = mon.work_area().position.to_logical::<f64>(msf);
    let asz = mon.work_area().size.to_logical::<f64>(msf);
    let area = Rect { x: ap.x, y: ap.y, w: asz.width, h: asz.height };

    let top = (pet_r.x + top_x, pet_r.y + top_y);
    let (x, y) = place(top, pet_r.y + bottom_y, panel, area);
    bubble.set_position(LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
    bubble.emit("bubble://say", Say { title, detail }).map_err(|e| e.to_string())?;
    *ANCHOR.lock().unwrap() = top;
    GEN.fetch_add(1, Ordering::SeqCst);
    if !bubble.is_visible().unwrap_or(false) {
        anim::zoom_in(&bubble, top);
    }
    Ok(())
}

/// Close with the shrink-back-into-the-fish animation.
#[tauri::command]
pub fn bubble_hide(app: AppHandle) {
    let Some(bubble) = app.get_webview_window("bubble") else { return };
    if !bubble.is_visible().unwrap_or(false) {
        return;
    }
    let ticket = GEN.load(Ordering::SeqCst);
    let to = *ANCHOR.lock().unwrap();
    let b = bubble.clone();
    anim::zoom_out(&bubble, to, move || {
        if GEN.load(Ordering::SeqCst) == ticket {
            let _ = b.hide();
            anim::reset(&b);
        }
    });
}

/// Hide immediately (fish hidden from Settings).
pub fn hide_now(app: &AppHandle) {
    if let Some(b) = app.get_webview_window("bubble") {
        GEN.fetch_add(1, Ordering::SeqCst);
        let _ = b.hide();
    }
}

/// Move along with the fish (called while a drag moves the fish by dx, dy).
pub fn follow(app: &AppHandle, dx: f64, dy: f64) {
    let Some(b) = app.get_webview_window("bubble").filter(|b| b.is_visible().unwrap_or(false)) else { return };
    if let Some(r) = rect_of(&b) {
        let _ = b.set_position(LogicalPosition::new(r.x + dx, r.y + dy));
    }
    let mut a = ANCHOR.lock().unwrap();
    *a = (a.0 + dx, a.1 + dy);
}

#[cfg(test)]
mod tests {
    use super::*;

    const AREA: Rect = Rect { x: 0.0, y: 25.0, w: 1710.0, h: 1000.0 };

    #[test]
    fn above_the_fish_when_nothing_is_in_the_way() {
        let (x, y) = place((800.0, 500.0), 650.0, None, AREA);
        assert_eq!((x, y), (800.0 - W / 2.0, 500.0 - H - GAP));
    }

    #[test]
    fn never_overlaps_the_panel() {
        // Panel tucked to the fish's left and reaching above it, as it usually sits.
        let panel = Rect { x: 500.0, y: 300.0, w: 340.0, h: 460.0 };
        for top_x in [780.0, 820.0, 900.0] {
            let (x, y) = place((top_x, 420.0), 560.0, Some(panel), AREA);
            assert!(!Rect { x, y, w: W, h: H }.overlaps(&panel, 0.0), "top_x {top_x}: bubble at ({x}, {y})");
        }
    }

    #[test]
    fn stays_on_screen() {
        let (x, y) = place((1700.0, 30.0), 120.0, None, AREA);
        assert!(x + W <= AREA.x + AREA.w && y >= AREA.y);
    }
}
