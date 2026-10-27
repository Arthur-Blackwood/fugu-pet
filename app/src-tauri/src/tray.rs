use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};

/// States that can be triggered from the tray for testing animations.
const TEST_STATES: &[(&str, &str)] = &[
    ("working", "Working"),
    ("happy", "Happy"),
    ("puff", "Puff up"),
    ("error", "Error"),
    ("sleep", "Sleep"),
    ("angry", "Angry"),
];

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let states = Submenu::with_id(app, "states", "Test Animations", true)?;
    for (id, label) in TEST_STATES {
        states.append(&MenuItem::with_id(app, format!("state:{id}"), *label, true, None::<&str>)?)?;
    }
    let open = MenuItem::with_id(app, "open", "Open Panel", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Show Fish", true, None::<&str>)?;
    let play = MenuItem::with_id(app, "play", "Play Mode (on / off)", true, None::<&str>)?;
    let spit = MenuItem::with_id(app, "spit", "Spit Out a File", true, None::<&str>)?;
    let debug = CheckMenuItem::with_id(app, "debug", "Show Debug Info", true, false, None::<&str>)?;
    let reset = MenuItem::with_id(app, "reset", "Reset Position", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Fugu Pet", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&open, &show, &play, &PredefinedMenuItem::separator(app)?, &states, &spit, &PredefinedMenuItem::separator(app)?, &debug, &reset, &PredefinedMenuItem::separator(app)?, &quit],
    )?;

    TrayIconBuilder::with_id("pet")
        .icon(app.default_window_icon().cloned().expect("bundle icon missing"))
        .tooltip("Fugu Pet")
        .menu(&menu)
        .on_menu_event(move |app, event| {
            let id = event.id().as_ref();
            match id {
                "quit" => app.exit(0),
                "open" => crate::panel::open_from_tray(app),
                "show" => crate::settings::show_fish(app),
                "play" => crate::play::toggle(app),
                "reset" => {
                    if let Some(win) = app.get_webview_window("main") {
                        crate::place_default(&win);
                    }
                }
                "debug" => {
                    let on = debug.is_checked().unwrap_or(false);
                    let _ = app.emit("pet://debug", on);
                }
                "spit" => {
                    let belly = app.state::<crate::belly::Belly>();
                    crate::belly::belly_pop(app.clone(), belly);
                }
                _ => {
                    if let Some(state) = id.strip_prefix("state:") {
                        let _ = app.emit("pet://state", state);
                    }
                }
            }
        })
        .build(app)?;
    Ok(())
}
