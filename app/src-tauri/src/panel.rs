//! The pop-up panel next to the fish (belly / recent / tidy / actions after a drop).

use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use crate::anim;
use tauri::{AppHandle, Emitter, LogicalPosition, Manager, WebviewWindow, Window};

#[derive(Serialize, Clone)]
struct Open {
    view: String,
    /// Belly item ids the view is about (the "actions" view after a drop).
    ids: Vec<u64>,
}

/// How far the panel overlaps the pet window's transparent margin, so it sits
/// close to the fish rather than the window edge.
const TUCK: f64 = 50.0;
const GAP: f64 = 6.0;

/// Clicking the fish while the panel is open first blurs (hides) the panel; the
/// click's own toggle must not then reopen it.
static LAST_HIDE: Mutex<Option<Instant>> = Mutex::new(None);
const REOPEN_GRACE: Duration = Duration::from_millis(600);

/// Pressing on the fish keeps the panel open for a moment even though the panel loses
/// focus, so dragging the fish can carry the panel along.
static KEEP_UNTIL: Mutex<Option<Instant>> = Mutex::new(None);
const KEEP_FOR: Duration = Duration::from_millis(900);

/// Must match the panel card's CSS border-radius.
const CARD_RADIUS: f64 = 18.0;
static GLASS: AtomicBool = AtomicBool::new(false);

/// Bumped on every open, so a close animation that finishes late can't hide a reopened panel.
static GEN: AtomicU64 = AtomicU64::new(0);

/// The fish's centre on screen: where the panel zooms out of and back into.
fn fish_point(pet: &WebviewWindow) -> (f64, f64) {
    let (Ok(sf), Ok(p), Ok(s)) = (pet.scale_factor(), pet.outer_position(), pet.outer_size()) else { return (0.0, 0.0) };
    let (p, s) = (p.to_logical::<f64>(sf), s.to_logical::<f64>(sf));
    (p.x + s.width / 2.0, p.y + s.height / 2.0)
}

/// Close: shrink back into the fish, then hide. Tells the fish the panel closed.
fn hide(app: &AppHandle) -> Result<(), String> {
    let (pet, panel) = windows(app)?;
    *LAST_HIDE.lock().unwrap() = Some(Instant::now());
    if !panel.is_visible().unwrap_or(false) {
        return Ok(());
    }
    let _ = app.emit_to("main", "pet://panel-view", "closed");
    crate::bubble::bubble_hide(app.clone());
    let ticket = GEN.load(Ordering::SeqCst);
    let p = panel.clone();
    anim::zoom_out(&panel, fish_point(&pet), move || {
        if GEN.load(Ordering::SeqCst) == ticket {
            let _ = p.hide();
            anim::reset(&p);
        }
    });
    Ok(())
}

fn windows(app: &AppHandle) -> Result<(WebviewWindow, WebviewWindow), String> {
    let pet = app.get_webview_window("main").ok_or("pet window missing")?;
    let panel = app.get_webview_window("panel").ok_or("panel window missing")?;
    Ok((pet, panel))
}

/// Beside the fish: left if there's room, otherwise right; clamped to the screen.
fn place(pet: &WebviewWindow, panel: &WebviewWindow) -> tauri::Result<()> {
    let sf = pet.scale_factor()?;
    let pos = pet.outer_position()?.to_logical::<f64>(sf);
    let size = pet.outer_size()?.to_logical::<f64>(sf);
    let psize = panel.outer_size()?.to_logical::<f64>(panel.scale_factor()?);
    let Some(mon) = pet.current_monitor()? else { return Ok(()) };
    let msf = mon.scale_factor();
    let area_pos = mon.work_area().position.to_logical::<f64>(msf);
    let area = mon.work_area().size.to_logical::<f64>(msf);

    let left = pos.x + TUCK - psize.width - GAP;
    let x = if left >= area_pos.x { left } else { pos.x + size.width - TUCK + GAP };
    let x = x.clamp(area_pos.x, area_pos.x + area.width - psize.width);
    // Bottom of the panel level with the fish's belly.
    let y = (pos.y + size.height * 0.75 - psize.height).clamp(area_pos.y, area_pos.y + area.height - psize.height);
    panel.set_position(LogicalPosition::new(x, y))
}

fn open(app: &AppHandle, view: String, ids: Vec<u64>) -> Result<(), String> {
    let (pet, panel) = windows(app)?;
    place(&pet, &panel).map_err(|e| e.to_string())?;
    GEN.fetch_add(1, Ordering::SeqCst);
    if !panel.is_visible().unwrap_or(false) {
        anim::zoom_in(&panel, fish_point(&pet)); // grows out of the fish
    }
    panel.set_focus().map_err(|e| e.to_string())?;
    panel.emit("panel://open", Open { view, ids }).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn panel_show(app: AppHandle, view: String, ids: Option<Vec<u64>>) -> Result<(), String> {
    open(&app, view, ids.unwrap_or_default())
}

#[tauri::command]
pub fn panel_toggle(app: AppHandle, view: String) -> Result<(), String> {
    let (_, panel) = windows(&app)?;
    let just_hidden = LAST_HIDE.lock().unwrap().is_some_and(|t| t.elapsed() < REOPEN_GRACE);
    if panel.is_visible().unwrap_or(false) {
        hide(&app)
    } else if just_hidden {
        Ok(())
    } else {
        open(&app, view, Vec::new())
    }
}

#[tauri::command]
pub fn panel_hide(app: AppHandle) -> Result<(), String> {
    hide(&app)
}

/// Tray: open the panel on the Belly tab.
pub fn open_from_tray(app: &AppHandle) {
    let _ = open(app, "belly".into(), Vec::new());
}

/// Pressing the fish blurs the panel at the same moment the fish's "keep" request is
/// sent; wait this long before deciding, so the keep request has arrived.
const BLUR_SETTLE: Duration = Duration::from_millis(160);

/// The panel lost focus: close it like a popover, unless the user is pressing or
/// dragging the fish (then it should come along instead).
#[tauri::command]
pub async fn panel_blurred(app: AppHandle) -> Result<(), String> {
    tokio_sleep(BLUR_SETTLE).await;
    let keep = KEEP_UNTIL.lock().unwrap().is_some_and(|t| Instant::now() < t);
    let (_, panel) = windows(&app)?;
    if keep || FOLLOW.lock().unwrap().leader.is_some() || panel.is_focused().unwrap_or(false) {
        return Ok(());
    }
    hide(&app)
}

async fn tokio_sleep(d: Duration) {
    // Off the main thread so the UI keeps running while we wait.
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
}

/// Called when the fish is pressed.
#[tauri::command]
pub fn panel_keep() {
    *KEEP_UNTIL.lock().unwrap() = Some(Instant::now() + KEEP_FOR);
}

/* ---------- Liquid Glass ---------- */

/// Put the system Liquid Glass material behind the panel (macOS 26+; older macOS gets
/// the vibrancy fallback, other platforms nothing — the CSS then draws its own backdrop).
pub fn apply_glass(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_liquid_glass::{LiquidGlassConfig, LiquidGlassExt};
        for (label, radius) in [("panel", CARD_RADIUS), ("bubble", crate::bubble::RADIUS)] {
            let Some(w) = app.get_webview_window(label) else { continue };
            let config = LiquidGlassConfig { corner_radius: radius, ..Default::default() };
            match app.liquid_glass().set_effect(&w, config) {
                Ok(()) => GLASS.store(true, Ordering::Relaxed),
                Err(e) => eprintln!("[{label}] liquid glass unavailable: {e}"),
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Whether a native glass backdrop is behind the panel / bubble.
#[tauri::command]
pub fn panel_glass() -> bool {
    GLASS.load(Ordering::Relaxed)
}

/* ---------- moving the fish and the panel together ---------- */

#[derive(Clone, Copy, PartialEq, Debug)]
enum Leader {
    Pet,
    Panel,
}

struct Follow {
    /// The window the user is dragging; the other one follows it.
    leader: Option<Leader>,
    last: (f64, f64),
}
static FOLLOW: Mutex<Follow> = Mutex::new(Follow { leader: None, last: (0.0, 0.0) });

/// The point that moves when the user drags: the fish's centre (it stays put when the
/// pet window resizes around a growing fish), or the panel's corner.
fn anchor(w: &WebviewWindow, leader: Leader) -> tauri::Result<(f64, f64)> {
    let sf = w.scale_factor()?;
    let p = w.outer_position()?.to_logical::<f64>(sf);
    Ok(match leader {
        Leader::Panel => (p.x, p.y),
        Leader::Pet => {
            let s = w.outer_size()?.to_logical::<f64>(sf);
            (p.x + s.width / 2.0, p.y + s.height / 2.0)
        }
    })
}

/// A window drag is starting ("pet" or "panel").
#[tauri::command]
pub fn follow_begin(app: AppHandle, leader: String) -> Result<(), String> {
    let leader = if leader == "panel" { Leader::Panel } else { Leader::Pet };
    let (pet, panel) = windows(&app)?;
    let w = if leader == Leader::Pet { &pet } else { &panel };
    let last = anchor(w, leader).map_err(|e| e.to_string())?;
    *FOLLOW.lock().unwrap() = Follow { leader: Some(leader), last };
    Ok(())
}

/// The drag ended. Give the panel focus back so clicking elsewhere still closes it.
#[tauri::command]
pub fn follow_end(app: AppHandle) -> Result<(), String> {
    let was = FOLLOW.lock().unwrap().leader.take();
    let (_, panel) = windows(&app)?;
    if was == Some(Leader::Pet) && panel.is_visible().unwrap_or(false) {
        panel.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Window-moved hook: when the dragged window moves, move the other one by the same amount.
pub fn on_moved(window: &Window) {
    let leader = match window.label() {
        "main" => Leader::Pet,
        "panel" => Leader::Panel,
        _ => return,
    };
    let Ok((pet, panel)) = windows(window.app_handle()) else { return };
    let (me, other) = if leader == Leader::Pet { (&pet, &panel) } else { (&panel, &pet) };
    let (dx, dy) = {
        let mut f = FOLLOW.lock().unwrap();
        if f.leader != Some(leader) {
            return; // a follower moving, or nobody dragging
        }
        let Ok(a) = anchor(me, leader) else { return };
        let d = (a.0 - f.last.0, a.1 - f.last.1);
        f.last = a;
        d
    }; // lock released before moving the other window (its Moved event re-enters here)
    if dx.abs() < 0.01 && dy.abs() < 0.01 {
        return;
    }
    crate::bubble::follow(window.app_handle(), dx, dy); // the speech bubble rides along
    if !panel.is_visible().unwrap_or(false) {
        return;
    }
    if let (Ok(sf), Ok(p)) = (other.scale_factor(), other.outer_position()) {
        let p = p.to_logical::<f64>(sf);
        let _ = other.set_position(LogicalPosition::new(p.x + dx, p.y + dy));
    }
}

/// A small "document" image used as the drag preview when dragging files out.
#[tauri::command]
pub fn drag_icon(app: AppHandle) -> Result<PathBuf, String> {
    let path = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("drag-icon.png");
    if !path.exists() {
        std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        draw_doc_icon(64).save(&path).map_err(|e| e.to_string())?;
    }
    Ok(path)
}

fn draw_doc_icon(s: u32) -> image::RgbaImage {
    let fold = s / 4;
    let (l, r, t, b) = (s / 8, s - s / 8, 0, s - 1);
    image::RgbaImage::from_fn(s, s, |x, y| {
        let inside = x >= l && x <= r && y >= t && y <= b && !(x > r - fold && y < t + fold && (r - x) + (y - t) < fold);
        let edge = inside && (x == l || x == r || y == t || y == b || (x > r - fold && y < t + fold && (r - x) + (y - t) <= fold + 1));
        let line = inside && (y - t) % 9 == 0 && y > t + fold && y < b - 6 && x > l + 8 && x < r - 8;
        match (inside, edge || line) {
            (true, true) => image::Rgba([120, 135, 140, 255]),
            (true, false) => image::Rgba([250, 251, 252, 255]),
            _ => image::Rgba([0, 0, 0, 0]),
        }
    })
}
