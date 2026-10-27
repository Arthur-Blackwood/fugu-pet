mod actions;
mod anim;
mod belly;
mod bubble;
mod dirs;
mod files;
mod panel;
mod play;
mod pointer;
mod recent;
mod settings;
mod tidy;
mod tray;

use tauri::{LogicalPosition, Manager, WebviewWindow};

/// Place the pet near the bottom-right corner of the primary monitor's work area.
/// Works in logical units: before the window is first shown its own scale factor can
/// still be 1.0 on a Retina display, so its physical size isn't trustworthy yet.
pub(crate) fn place_default(win: &WebviewWindow) {
    let Ok(Some(monitor)) = win.primary_monitor() else { return };
    let scale = monitor.scale_factor();
    let area = monitor.work_area().size.to_logical::<f64>(scale);
    let pos = monitor.work_area().position.to_logical::<f64>(scale);
    let Ok(size) = win.inner_size() else { return };
    let size = size.to_logical::<f64>(win.scale_factor().unwrap_or(scale));
    const MARGIN: f64 = 48.0;
    let x = pos.x + area.width - size.width - MARGIN;
    let y = pos.y + area.height - size.height - MARGIN;
    #[cfg(debug_assertions)]
    eprintln!("[place] work area {area:?} at {pos:?}, window {size:?} -> ({x}, {y})");
    let _ = win.set_position(LogicalPosition::new(x, y));
}

/// Frontend console output, mirrored to stderr for debugging without devtools.
#[tauri::command]
fn frontend_log(level: String, msg: String) {
    eprintln!("[web:{level}] {msg}");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_liquid_glass::init())
        .invoke_handler(tauri::generate_handler![
            frontend_log,
            belly::belly_list,
            belly::belly_add,
            belly::belly_remove,
            belly::belly_pop,
            recent::recent_files,
            tidy::tidy_preview,
            tidy::tidy_apply,
            tidy::tidy_last,
            tidy::tidy_undo,
            actions::actions_for,
            actions::run_action,
            actions::trash_outputs,
            panel::panel_show,
            panel::panel_toggle,
            panel::panel_hide,
            panel::drag_icon,
            panel::panel_blurred,
            panel::panel_keep,
            panel::panel_glass,
            panel::follow_begin,
            panel::follow_end,
            bubble::bubble_say,
            bubble::bubble_hide,
            settings::settings_get,
            settings::settings_set,
            play::play_set,
            play::play_get,
            play::play_items,
            play::play_item_at,
            play::play_hide,
            play::pet_swim,
            play::pet_center,
            play::pet_mouth,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Moved(_) = event {
                panel::on_moved(window);
            }
        })
        .setup(|app| {
            app.manage(belly::Belly::load(app.handle()));
            app.manage(settings::Store::load(app.handle()));
            // Desktop files hidden by a play session that never ended cleanly come back.
            let restored = play::restore_all(app.handle());
            if restored > 0 {
                eprintln!("[play] restored {restored} Desktop file(s) left hidden by a previous session");
            }

            // No Dock icon on macOS; the pet lives in the tray instead.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let win = app
                .get_webview_window("main")
                .expect("main window missing from tauri.conf.json");
            // Start fully click-through; the frontend turns hits back on over the fish.
            win.set_ignore_cursor_events(true)?;
            win.show()?;
            place_default(&win);
            settings::apply(app.handle(), &app.state::<settings::Store>().get());
            if let Some(b) = app.get_webview_window("bubble") {
                b.set_ignore_cursor_events(true)?; // the bubble never blocks clicks
            }

            panel::apply_glass(app.handle());
            tray::build(app.handle())?;
            pointer::spawn_poller(win);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // However the app ends, eaten Desktop files come back.
            if let tauri::RunEvent::Exit = event {
                play::restore_all(app);
            }
        });
}
