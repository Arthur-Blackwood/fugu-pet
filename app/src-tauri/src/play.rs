//! Play mode: a full-screen overlay (gray glowing border) where clicking makes the fish
//! swim there and double-clicking a Desktop file feeds it to the fish.
//!
//! "Eaten" files are never moved or deleted: they get the macOS *hidden* flag
//! (`UF_HIDDEN`, like `chflags hidden`), so Finder stops showing them, and the flag is
//! removed again when play mode ends. The list of hidden files is saved to disk, so a
//! crash or force-quit is repaired at the next launch.
//!
//! Finding which icon was double-clicked asks Finder for its Desktop icon positions
//! via AppleScript (macOS asks the user once for "Automation → Finder" access).
//! macOS only for now; other platforms report that play mode isn't available.

use crate::{dirs::UserDirs, files::is_junk};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewWindow};

static ON: AtomicBool = AtomicBool::new(false);
/// Serialises hide / restore and their bookkeeping.
static HIDDEN_LOCK: Mutex<()> = Mutex::new(());
/// Bumped per swim so a newer swim cancels an older one.
static SWIM: AtomicU64 = AtomicU64::new(0);
/// How long the border takes to fade before the overlay hides.
const FADE_OUT: Duration = Duration::from_millis(450);

/// Overlay window level: above normal app windows (0), below the floating fish,
/// panel and bubble (3), below the Dock and menu bar (which stay usable).
#[cfg(target_os = "macos")]
const OVERLAY_LEVEL: i64 = 2;

#[derive(Serialize, Clone, Debug)]
pub struct DesktopItem {
    pub path: String,
    pub name: String,
    /// Icon centre and hit rectangle, screen logical px.
    pub cx: f64,
    pub cy: f64,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Serialize)]
pub struct EatTarget {
    #[serde(flatten)]
    item: DesktopItem,
    /// Icon edge length (px) as Finder draws it.
    icon_size: f64,
    /// PNG data URL of the icon / thumbnail, for the eating animation.
    image: Option<String>,
}

/* ---------- hidden-file bookkeeping ---------- */

#[derive(Serialize, Deserialize, Default)]
struct HiddenList {
    paths: Vec<String>,
}

fn hidden_file(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().map(|d| d.join("play-hidden.json")).unwrap_or_else(|_| "play-hidden.json".into())
}
fn read_hidden(app: &AppHandle) -> HiddenList {
    fs::read(hidden_file(app)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}
fn write_hidden(app: &AppHandle, list: &HiddenList) {
    let f = hidden_file(app);
    if let Some(d) = f.parent() {
        let _ = fs::create_dir_all(d);
    }
    if let Ok(json) = serde_json::to_vec_pretty(list) {
        let _ = fs::write(f, json);
    }
}

/// Unhide every file play mode hid. Safe to call any time (startup, exit, quit).
pub fn restore_all(app: &AppHandle) -> usize {
    let _guard = HIDDEN_LOCK.lock().unwrap();
    let mut list = read_hidden(app);
    let mut restored = 0;
    list.paths.retain(|p| match set_hidden(Path::new(p), false) {
        Ok(_) => {
            restored += 1;
            false
        }
        // Gone (moved / deleted by the user meanwhile): nothing to restore.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => {
            eprintln!("[play] couldn't restore {p}: {e}");
            true // keep it listed and try again next time
        }
    });
    write_hidden(app, &list);
    restored
}

/// Set or clear the hidden flag on the item itself (never a symlink's target).
/// Returns whether anything changed.
#[cfg(target_os = "macos")]
fn set_hidden(path: &Path, hide: bool) -> std::io::Result<bool> {
    use std::{ffi::CString, os::macos::fs::MetadataExt, os::unix::ffi::OsStrExt};
    const UF_HIDDEN: u32 = 0x8000;
    let flags = fs::symlink_metadata(path)?.st_flags();
    let new = if hide { flags | UF_HIDDEN } else { flags & !UF_HIDDEN };
    if new == flags {
        return Ok(false);
    }
    let c = CString::new(path.as_os_str().as_bytes())?;
    if unsafe { libc::lchflags(c.as_ptr(), new as _) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(true)
}
#[cfg(not(target_os = "macos"))]
fn set_hidden(_path: &Path, _hide: bool) -> std::io::Result<bool> {
    Err(std::io::Error::other("play mode is macOS-only for now"))
}

/* ---------- Finder desktop icons ---------- */

const FINDER_SCRIPT: &str = r#"
tell application "Finder"
  set ps to desktop position of every item of desktop
  set us to URL of every item of desktop
  try
    set sz to icon size of icon view options of window of desktop
  on error
    set sz to 64
  end try
end tell
set out to (sz as text) & linefeed
repeat with i from 1 to count of ps
  set p to item i of ps
  set out to out & ((item 1 of p) as text) & tab & ((item 2 of p) as text) & tab & (item i of us) & linefeed
end repeat
return out
"#;

fn percent_decode(s: &str) -> String {
    let hex = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push(h << 4 | l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Parse the script's output into icon size and items inside `desktop`.
pub fn parse_finder(out: &str, desktop: &Path) -> (f64, Vec<DesktopItem>) {
    let mut lines = out.lines();
    let size: f64 = lines.next().and_then(|l| l.trim().replace(',', ".").parse().ok()).unwrap_or(64.0);
    let (cell_w, label_h) = (size.max(72.0) + 16.0, 34.0);
    let items = lines
        .filter_map(|l| {
            let mut f = l.split('\t');
            let x: f64 = f.next()?.trim().replace(',', ".").parse().ok()?;
            let y: f64 = f.next()?.trim().replace(',', ".").parse().ok()?;
            let url = f.next()?.trim();
            let path = PathBuf::from(percent_decode(url.strip_prefix("file://")?.trim_end_matches('/')));
            // Only plain Desktop items (not disks, not hidden clutter).
            if path.parent() != Some(desktop) {
                return None;
            }
            let name = path.file_name()?.to_string_lossy().into_owned();
            if is_junk(&name) {
                return None;
            }
            Some(DesktopItem {
                path: path.to_string_lossy().into_owned(),
                name,
                cx: x,
                cy: y,
                x: x - cell_w / 2.0,
                y: y - size / 2.0 - 8.0,
                w: cell_w,
                h: size + 8.0 + label_h,
            })
        })
        .collect();
    (size, items)
}

fn finder_items(app: &AppHandle) -> Result<(f64, Vec<DesktopItem>), String> {
    let desktop = UserDirs::resolve(app)?.desktop;
    let out = std::process::Command::new("/usr/bin/osascript").arg("-e").arg(FINDER_SCRIPT).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(if err.contains("-1743") || err.contains("Not authorized") {
            "Fugu Pet needs permission to see your Desktop icons: System Settings → Privacy & Security → Automation → Fugu Pet → Finder.".into()
        } else {
            format!("Couldn't read Desktop icons: {}", err.trim())
        });
    }
    Ok(parse_finder(&String::from_utf8_lossy(&out.stdout), &desktop))
}

/* ---------- icon images ---------- */

fn data_url(png: &[u8]) -> String {
    use base64::Engine;
    format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png))
}

/// A picture of the item for the eating animation: a real thumbnail for ordinary
/// images (as Finder shows them), the system icon otherwise.
fn item_image(app: &AppHandle, path: &str, size: u32) -> Option<String> {
    const THUMB: &[&str] = &["jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff"];
    let p = Path::new(path);
    let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let small = fs::metadata(p).map(|m| m.len() < 40_000_000).unwrap_or(false);
    if THUMB.contains(&ext.as_str()) && small {
        if let Ok(img) = image::open(p) {
            let mut png = Vec::new();
            let thumb = img.thumbnail(size * 2, size * 2);
            if thumb.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).is_ok() {
                return Some(data_url(&png));
            }
        }
    }
    system_icon(app, path, size).map(|png| data_url(&png))
}

#[cfg(target_os = "macos")]
fn system_icon(app: &AppHandle, path: &str, size: u32) -> Option<Vec<u8>> {
    let (tx, rx) = std::sync::mpsc::channel();
    let path = path.to_string();
    app.run_on_main_thread(move || {
        let _ = tx.send(unsafe { mac::icon_png(&path, size as f64 * 2.0) });
    })
    .ok()?;
    rx.recv_timeout(Duration::from_secs(2)).ok().flatten()
}
#[cfg(not(target_os = "macos"))]
fn system_icon(_app: &AppHandle, _path: &str, _size: u32) -> Option<Vec<u8>> {
    None
}

/* ---------- commands ---------- */

#[derive(Serialize, Clone)]
struct PlayState {
    on: bool,
    /// Files put back when play ended.
    restored: usize,
    /// The overlay's top-left on screen (logical px), for screen ↔ overlay conversion.
    origin: (f64, f64),
}

#[tauri::command]
pub fn play_set(app: AppHandle, on: bool) -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("Play mode is only available on macOS for now.".into());
    }
    let overlay = app.get_webview_window("play").ok_or("play window missing")?;
    if on == ON.swap(on, Ordering::SeqCst) {
        return Ok(());
    }
    let mut restored = 0;
    if on {
        let _ = crate::panel::panel_hide(app.clone());
        cover_screen(&app, &overlay).map_err(|e| e.to_string())?;
        overlay.show().map_err(|e| e.to_string())?;
        #[cfg(target_os = "macos")]
        set_level(&overlay, OVERLAY_LEVEL);
        let _ = overlay.set_focus();
    } else {
        SWIM.fetch_add(1, Ordering::SeqCst); // stop any swim in progress
        restored = restore_all(&app);
        // Let the border fade out (the overlay animates on play://changed), then hide.
        let o = overlay.clone();
        std::thread::spawn(move || {
            std::thread::sleep(FADE_OUT);
            if !ON.load(Ordering::SeqCst) {
                let _ = o.hide();
            }
        });
    }
    let origin = window_origin(&overlay).unwrap_or((0.0, 0.0));
    let _ = app.emit("play://changed", PlayState { on, restored, origin });
    Ok(())
}

#[tauri::command]
pub fn play_get() -> bool {
    ON.load(Ordering::SeqCst)
}

/// Tray / pet window: flip play mode.
pub fn toggle(app: &AppHandle) {
    let _ = play_set(app.clone(), !ON.load(Ordering::SeqCst));
}

/// Overlay covers the work area of the screen the fish is on (menu bar and Dock stay usable).
fn cover_screen(app: &AppHandle, overlay: &WebviewWindow) -> tauri::Result<()> {
    let pet = app.get_webview_window("main").expect("pet window");
    let Some(mon) = pet.current_monitor()?.or(pet.primary_monitor()?) else { return Ok(()) };
    let sf = mon.scale_factor();
    let pos = mon.work_area().position.to_logical::<f64>(sf);
    let size = mon.work_area().size.to_logical::<f64>(sf);
    overlay.set_position(LogicalPosition::new(pos.x, pos.y))?;
    overlay.set_size(LogicalSize::new(size.width, size.height))
}

fn window_origin(w: &WebviewWindow) -> Option<(f64, f64)> {
    let sf = w.scale_factor().ok()?;
    let p = w.outer_position().ok()?.to_logical::<f64>(sf);
    Some((p.x, p.y))
}

/// The fish reports its mouth in its own window's px; forward it to the overlay in
/// screen px. (`window.screenX/Y` inside the webview isn't reliable on macOS, so the
/// conversion is done here from the window's real position.)
#[tauri::command]
pub fn pet_mouth(app: AppHandle, x: f64, y: f64) {
    let Some(pet) = app.get_webview_window("main") else { return };
    if let Some((ox, oy)) = window_origin(&pet) {
        let _ = app.emit_to("play", "pet://mouth", serde_json::json!({ "x": ox + x, "y": oy + y }));
    }
}

/// All Desktop icons (for debugging the hit areas).
#[tauri::command]
pub fn play_items(app: AppHandle) -> Result<Vec<DesktopItem>, String> {
    Ok(finder_items(&app)?.1)
}

/// The Desktop item under a screen point, with a picture of it, or None.
#[tauri::command]
pub async fn play_item_at(app: AppHandle, x: f64, y: f64) -> Result<Option<EatTarget>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (icon_size, items) = finder_items(&app)?;
        let hit = items
            .into_iter()
            .filter(|i| x >= i.x && x <= i.x + i.w && y >= i.y && y <= i.y + i.h)
            .min_by(|a, b| {
                let d = |i: &DesktopItem| (i.cx - x).powi(2) + (i.cy - y).powi(2);
                d(a).total_cmp(&d(b))
            });
        Ok(hit.map(|item| {
            let image = item_image(&app, &item.path, icon_size as u32);
            EatTarget { item, icon_size, image }
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Hide an eaten Desktop file (restored when play mode ends).
#[tauri::command]
pub fn play_hide(app: AppHandle, path: String) -> Result<(), String> {
    if !ON.load(Ordering::SeqCst) {
        return Err("play mode is off".into());
    }
    let p = PathBuf::from(&path);
    let desktop = UserDirs::resolve(&app)?.desktop;
    if p.parent() != Some(desktop.as_path()) {
        return Err("only Desktop items can be eaten".into());
    }
    let _guard = HIDDEN_LOCK.lock().unwrap();
    // Record first: if we crash right after hiding, startup still restores it.
    let mut list = read_hidden(&app);
    if !list.paths.contains(&path) {
        list.paths.push(path.clone());
        write_hidden(&app, &list);
    }
    match set_hidden(&p, true) {
        Ok(true) => Ok(()),
        Ok(false) => {
            // Already hidden before play mode: not ours to un-hide later.
            list.paths.retain(|x| x != &path);
            write_hidden(&app, &list);
            Ok(())
        }
        Err(e) => {
            list.paths.retain(|x| x != &path);
            write_hidden(&app, &list);
            Err(e.to_string())
        }
    }
}

/// Where the fish's centre is on screen (logical px).
#[tauri::command]
pub fn pet_center(app: AppHandle) -> Option<(f64, f64)> {
    let pet = app.get_webview_window("main")?;
    let sf = pet.scale_factor().ok()?;
    let p = pet.outer_position().ok()?.to_logical::<f64>(sf);
    let s = pet.outer_size().ok()?.to_logical::<f64>(sf);
    Some((p.x + s.width / 2.0, p.y + s.height / 2.0))
}

/// Swim the fish so its centre ends at (x, y) (screen logical px). Resolves on arrival
/// (or when a newer swim takes over).
#[tauri::command]
pub async fn pet_swim(app: AppHandle, x: f64, y: f64) -> Result<(), String> {
    let pet = app.get_webview_window("main").ok_or("pet window missing")?;
    let sf = pet.scale_factor().map_err(|e| e.to_string())?;
    let pos = pet.outer_position().map_err(|e| e.to_string())?.to_logical::<f64>(sf);
    let size = pet.outer_size().map_err(|e| e.to_string())?.to_logical::<f64>(sf);
    let from = (pos.x, pos.y);
    let mut to = (x - size.width / 2.0, y - size.height / 2.0);
    if let Ok(Some(mon)) = pet.current_monitor() {
        // Keep the fish itself on screen (its window may hang over the edge a bit).
        let msf = mon.scale_factor();
        let ap = mon.work_area().position.to_logical::<f64>(msf);
        let az = mon.work_area().size.to_logical::<f64>(msf);
        let (mx, my) = (size.width / 2.0 - 50.0, size.height / 2.0 - 40.0);
        to.0 = to.0.clamp(ap.x - mx, ap.x + az.width - size.width + mx);
        to.1 = to.1.clamp(ap.y - my, ap.y + az.height - size.height + my);
    }
    let (dx, dy) = (to.0 - from.0, to.1 - from.1);
    let dist = dx.hypot(dy);
    if dist < 2.0 {
        return Ok(());
    }
    let path = SwimPath::new(from, (dx, dy), dist);
    let dur = path.dur;
    let ticket = SWIM.fetch_add(1, Ordering::SeqCst) + 1;
    let _ = pet.emit_to("main", "pet://swim", (dx, dy, dur.as_millis() as u64));
    let half = (size.width / 2.0, size.height / 2.0);
    tauri::async_runtime::spawn_blocking(move || {
        let start = Instant::now();
        let mut last = (from, 0.0_f64);
        let mut next_report = 0.0;
        loop {
            if SWIM.load(Ordering::SeqCst) != ticket {
                return; // superseded
            }
            let secs = start.elapsed().as_secs_f64();
            let t = (secs / dur.as_secs_f64()).min(1.0);
            let p = path.at(t);
            let _ = pet.set_position(LogicalPosition::new(p.0, p.1));
            // ~30 Hz: velocity for the fish (heading, body wave) and the overlay (bubble trail)
            if secs >= next_report || t >= 1.0 {
                let dt = (secs - last.1).max(1e-3);
                let v = ((p.0 - last.0 .0) / dt, (p.1 - last.0 .1) / dt);
                let v = if t >= 1.0 { (0.0, 0.0) } else { v };
                let report = (p.0 + half.0, p.1 + half.1, v.0, v.1, size.width);
                let _ = pet.emit_to("main", "pet://swim-v", report);
                let _ = pet.emit_to("play", "pet://swim-v", report);
                last = (p, secs);
                next_report = secs + 0.033;
            }
            if t >= 1.0 {
                break;
            }
            std::thread::sleep(Duration::from_millis(8));
        }
        let _ = pet.emit_to("main", "pet://swim-end", ());
    })
    .await
    .map_err(|e| e.to_string())
}

/// A fish's swim between two window positions: a gentle arc rather than a straight
/// line, and speed that comes in strokes — each beat of the tail pushes, then it
/// coasts — under an overall launch / cruise / glide-to-a-stop envelope.
struct SwimPath {
    from: (f64, f64),
    d: (f64, f64),
    /// Bezier control point offset from the straight line's midpoint.
    bend: (f64, f64),
    /// Unit vector across the path, for the slight side-to-side sway of each stroke.
    across: (f64, f64),
    beats: f64,
    /// Cumulative distance fraction sampled over time (monotonic, 0 → 1).
    table: Vec<f64>,
    dur: Duration,
}

impl SwimPath {
    const SAMPLES: usize = 400;

    fn new(from: (f64, f64), d: (f64, f64), dist: f64) -> Self {
        // An unhurried pace: ~280 px/s on average, never more than a few seconds.
        let secs = (0.6 + dist / 280.0).min(4.2);
        let across = (-d.1 / dist, d.0 / dist);
        // Bow the path upward (screen up = -y); sideways for straight up/down swims.
        let sign = if across.1.abs() > 0.2 { -across.1.signum() } else { across.0.signum() };
        let amount = (dist * 0.12).min(60.0) * sign;
        let bend = (across.0 * amount, across.1 * amount);
        // About two tail beats a second, a whole number so the last one ends the glide.
        let beats = (secs * 2.0).round().max(1.0);
        let mut table = Vec::with_capacity(Self::SAMPLES + 1);
        let mut acc = 0.0;
        table.push(0.0);
        for i in 1..=Self::SAMPLES {
            let t = (i as f64 - 0.5) / Self::SAMPLES as f64;
            // envelope: quick launch, steady cruise, long glide in
            let env = (std::f64::consts::PI * t.powf(0.8)).sin().max(0.0).powf(1.3);
            let stroke = 1.0 + 0.42 * (std::f64::consts::TAU * beats * t).sin();
            acc += env * stroke;
            table.push(acc);
        }
        for v in &mut table {
            *v /= acc;
        }
        SwimPath { from, d, bend, across: (across.0 * sign, across.1 * sign), beats, table, dur: Duration::from_secs_f64(secs) }
    }

    /// Window position at time fraction t ∈ [0, 1].
    fn at(&self, t: f64) -> (f64, f64) {
        let f = t * Self::SAMPLES as f64;
        let i = (f.floor() as usize).min(Self::SAMPLES - 1);
        let s = self.table[i] + (self.table[i + 1] - self.table[i]) * (f - i as f64);
        // quadratic Bezier: from → (mid + bend) → to
        let k = 2.0 * s * (1.0 - s);
        let x = self.from.0 + self.d.0 * s + self.bend.0 * k;
        let y = self.from.1 + self.d.1 * s + self.bend.1 * k;
        // a slight sway across the path with each stroke, fading at both ends
        let sway = 2.0 * (std::f64::consts::TAU * self.beats * t).sin() * (std::f64::consts::PI * t).sin();
        (x + self.across.0 * sway, y + self.across.1 * sway)
    }
}

/* ---------- macOS glue ---------- */

#[cfg(target_os = "macos")]
fn set_level(win: &WebviewWindow, level: i64) {
    let w = win.clone();
    let _ = win.run_on_main_thread(move || unsafe {
        if let Ok(ns) = w.ns_window() {
            mac::set_level(ns.cast(), level);
        }
    });
}

#[cfg(target_os = "macos")]
#[allow(unsafe_op_in_unsafe_fn)] // pure Objective-C glue
mod mac {
    use objc::{class, msg_send, runtime::Object, sel, sel_impl};
    use std::ffi::CString;

    type Id = *mut Object;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NSSize {
        w: f64,
        h: f64,
    }

    pub unsafe fn set_level(ns_window: Id, level: i64) {
        let _: () = msg_send![ns_window, setLevel: level];
    }

    /// The Finder icon for `path`, rendered at `px` pixels, as PNG bytes.
    pub unsafe fn icon_png(path: &str, px: f64) -> Option<Vec<u8>> {
        let c = CString::new(path).ok()?;
        let ns_path: Id = msg_send![class!(NSString), stringWithUTF8String: c.as_ptr()];
        let ws: Id = msg_send![class!(NSWorkspace), sharedWorkspace];
        let img: Id = msg_send![ws, iconForFile: ns_path];
        if img.is_null() {
            return None;
        }
        let _: () = msg_send![img, setSize: NSSize { w: px, h: px }];
        let null: *const std::ffi::c_void = std::ptr::null();
        let nil: Id = std::ptr::null_mut();
        let cg: *mut std::ffi::c_void = msg_send![img, CGImageForProposedRect: null context: nil hints: nil];
        if cg.is_null() {
            return None;
        }
        let rep: Id = msg_send![class!(NSBitmapImageRep), alloc];
        let rep: Id = msg_send![rep, initWithCGImage: cg];
        let props: Id = msg_send![class!(NSDictionary), dictionary];
        // NSBitmapImageFileTypePNG = 4
        let png: Id = msg_send![rep, representationUsingType: 4u64 properties: props];
        let out = if png.is_null() {
            None
        } else {
            let len: usize = msg_send![png, length];
            let bytes: *const u8 = msg_send![png, bytes];
            Some(std::slice::from_raw_parts(bytes, len).to_vec())
        };
        let _: () = msg_send![rep, release];
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_finder_output_and_keeps_only_desktop_items() {
        let desktop = Path::new("/Users/me/Desktop");
        let out = "64\n120\t200\tfile:///Users/me/Desktop/Week%205%20notes.pdf\n300\t200\tfile:///Users/me/Desktop/Project/\n10\t10\tfile:///Volumes/USB/\n50\t50\tfile:///Users/me/Desktop/.hidden\n";
        let (size, items) = parse_finder(out, desktop);
        assert_eq!(size, 64.0);
        let names: Vec<_> = items.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(names, ["Week 5 notes.pdf", "Project"]);
        let a = &items[0];
        assert!(a.x < 120.0 && a.x + a.w > 120.0 && a.y < 200.0 && a.y + a.h > 230.0, "hit area covers icon and label");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn hide_and_restore_round_trip() {
        let f = std::env::temp_dir().join(format!("fugu-hide-{}", std::process::id()));
        fs::write(&f, b"x").unwrap();
        assert!(set_hidden(&f, true).unwrap());
        assert!(!set_hidden(&f, true).unwrap(), "already hidden: no change");
        assert!(set_hidden(&f, false).unwrap());
        fs::remove_file(&f).unwrap();
    }
}
