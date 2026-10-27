//! Global cursor polling.
//!
//! While the window ignores cursor events (click-through), the webview receives no
//! pointer events at all, so it cannot tell when the cursor comes back over the fish.
//! This thread samples the global cursor position and forwards it to the frontend in
//! window-local CSS pixels; the frontend raycasts against the fish and toggles
//! `setIgnoreCursorEvents` accordingly. The same stream drives eye/body tracking even
//! when the cursor is outside the window.

use serde::Serialize;
use std::{thread, time::Duration};
use tauri::{Emitter, Manager, WebviewWindow};

#[derive(Serialize, Clone)]
struct CursorPayload {
    /// Cursor position relative to the window's top-left corner, in logical pixels.
    x: f64,
    y: f64,
}

/// Cursor further than this from the window (logical px) is polled at the slow rate,
/// unless the fish follows the cursor from further away (Settings → Follow range).
const NEAR_MARGIN: f64 = 360.0;
/// Cursor over the window: sample at ~60 Hz so hover and click-through feel immediate.
const INSIDE: Duration = Duration::from_millis(16);
const FAST: Duration = Duration::from_millis(33);
const SLOW: Duration = Duration::from_millis(120);

pub fn spawn_poller(win: WebviewWindow) {
    let app = win.app_handle().clone();
    thread::spawn(move || {
        let mut last: Option<(f64, f64)> = None;
        loop {
            let (Ok(cursor), Ok(origin), Ok(size), Ok(scale)) = (
                win.cursor_position(),
                win.outer_position(),
                win.outer_size(),
                win.scale_factor(),
            ) else {
                thread::sleep(SLOW);
                continue;
            };
            let x = (cursor.x - origin.x as f64) / scale;
            let y = (cursor.y - origin.y as f64) / scale;
            let w = size.width as f64 / scale;
            let h = size.height as f64 / scale;

            let margin = NEAR_MARGIN.max(app.state::<crate::settings::Store>().get().follow_radius());
            let near = x > -margin && y > -margin && x < w + margin && y < h + margin;
            let moved = last.is_none_or(|(lx, ly)| (x - lx).abs() >= 0.5 || (y - ly).abs() >= 0.5);
            if moved {
                last = Some((x, y));
                let _ = app.emit("pet://cursor", CursorPayload { x, y });
            }
            let inside = x >= 0.0 && y >= 0.0 && x <= w && y <= h;
            thread::sleep(if inside { INSIDE } else if near { FAST } else { SLOW });
        }
    });
}
