# Fugu Pet (app)

Tauri 2 + TypeScript + Three.js. Developer notes; the user guide is the [top-level README](../README.md).

## Run

```bash
npm install
npm run tauri dev      # desktop app (hot reload)
npm run dev            # browser-only preview at http://localhost:1420 (no click-through / tray)
npm run tauri build    # release bundle
```

The panel uses the system Liquid Glass material on macOS 26+ (via `tauri-plugin-liquid-glass`);
older macOS and Windows get a frosted CSS fallback. Accents follow the system accent colour.

The pet has no Dock or taskbar icon. The **tray / menu-bar icon** has test animations, spit out a
file, show debug info (HUD + window bounds), reset position and quit.

## Using it

| Do this | What happens |
|---|---|
| Drop files / folders on the fish | It swallows them into the **belly** (references only — nothing is moved or copied), grows with their total size, and opens the **action menu** |
| Hover over the fish | It turns a shade lighter |
| Click the fish | Opens the panel: **Belly**, **Recent**, **Tidy**, **Settings**. Click elsewhere or press Esc to close |
| Tray → Play Mode | Click anywhere: the fish swims there. Double-click a Desktop file: it eats it (hidden until Play mode ends). Esc exits |
| Double-click the fish | Puffs up and stays puffed; double-click again to let it go |
| Drag the fish | Moves it; an open panel comes along |
| Drag the panel's top bar | Moves the panel; the fish comes along |
| Drag a row out of the panel | Copies that file to wherever you drop it (the original stays). From the Belly tab this also lets it out of the belly |
| Belly → select items | Quick actions for the selection, or "Let out" |
| Tidy tab | Previews where loose Desktop files would go, moves them only when you click **Tidy**, and can **Undo** |

Quick actions (outputs are new files next to the originals; **Undo** moves them to the Trash):

- **Compress image to under 1 MB:** JPG/PNG/WebP/BMP/TIFF/GIF, and HEIC on macOS. Re-encodes as JPEG, capping the long side at 4096 px.
- **Convert HEIC to JPG:** macOS only for now, via the built-in `sips`.
- **Merge PDFs:** two or more, in belly order.

Tidy rules (top-level Desktop **files** only; folders, hidden files and unknown types stay put; name clashes get " (2)"):

| Files | Go to |
|---|---|
| Screenshot… / Screen Recording… (also the names macOS uses in other system languages) | `Pictures/Screenshots/YYYY-MM` |
| PDFs | `Documents/PDF` |
| dmg, pkg, exe, msi… | `Downloads/Installers` |
| zip, rar, 7z… | `Downloads/Archives` |
| Other images | `Pictures/Desktop Images` |
| Office / text documents | `Documents/Desktop Documents` |

The belly and the last 20 tidy batches are kept in the app data folder
(`~/Library/Application Support/com.fugu.desktoppet/` on macOS).

### Testing without touching your real folders

`FUGU_TEST_HOME` points Recent and Tidy at a sandbox containing `Desktop/`, `Documents/`, `Pictures/` and `Downloads/`:

```bash
FUGU_TEST_HOME=/tmp/fugu-sandbox "src-tauri/target/release/bundle/macos/Fugu Pet.app/Contents/MacOS/fugu-pet"
```

To preview the panel in a browser with sample data, run `npm run dev` and open `/panel.html`
(add `?view=tidy`, `?view=recent` or `?view=actions` to start on a different view).

Browser preview shortcuts: `1` working, `2` happy, `3` puff, `4` error, `5` sleep, `0` idle,
`f` feed a fake 2.4 MB file, `g` feed a fake 3 GB item, `s` spit. `?state=puff` in the URL starts in that state.

## Layout

```
src/
  fish/model.ts       procedural geometry, materials, morph targets (inflate)
  fish/skin.ts        body shader (countershading, spots, gills, caustics)
  fish/rig.ts         parameter rig: targets → eased values → pose
  fish/states.ts      state machine (idle, catch, working, tidy, puff, sleep …)
  fish/growth.ts      belly size → growth curve
  fish/particles.ts   bubbles
  fish/renderer.ts    scene, adaptive frame-rate loop, raycast hit test
  platform/tauri.ts   click-through, window drag/resize, file drop, belly + panel wiring
  platform/browser.ts browser preview host
  panel/              the panel window (belly, recent, tidy, action menu)
src-tauri/src/
  pointer.rs          global cursor poller → frontend (drives click-through + eye tracking)
  belly.rs            F4 holding area, persisted
  recent.rs           F5 recent files (Desktop + Downloads)
  tidy.rs             F1 tidy preview / apply / undo log
  actions.rs          compress, HEIC → JPG, PDF merge, trash outputs
  panel.rs            panel window placement + drag-out icon
  files.rs, dirs.rs   shared helpers (folder sizes, unique names, user folders)
  tray.rs             tray menu
```

## How click-through works

The window starts with `setIgnoreCursorEvents(true)`, so every click falls through to whatever is
underneath. A Rust thread polls the global cursor (60 Hz over the pet, 30 Hz within the follow range set in Settings, ~8 Hz beyond it) and sends it
to the page in window-local pixels. The page raycasts against the fish's body, eyes and fins; when
the cursor is on the fish it turns cursor events back on, and turns them off again when it leaves.
The same approach works on macOS and Windows; it doesn't use any per-platform hit-test APIs.

## Performance check (macOS)

```bash
scripts/perf-mac.sh 30
```

This reports CPU as a percentage of one core, from CPU-time deltas, for the app and WebKit's
content/GPU helpers. The helpers are shared with Safari and Mail, so quit those first.

## Windows (VM / roommate's machine)

Prerequisites: [Rust](https://rustup.rs), Node 20+, and the "Desktop development with C++"
workload from Visual Studio Build Tools. WebView2 is preinstalled on Windows 10/11.

```bash
npm install
npm run tauri dev
```

What to check on Windows:

1. The window background is fully transparent, with no white box, border, or shadow.
2. Clicking next to the fish (inside the 280×240 window) reaches the app underneath.
3. Clicking the fish gives a nudge; three quick clicks make it puff; dragging it moves the window.
4. Dragging a file from Explorer onto the fish makes it open its mouth, then swallow the file
   (tray → Show Debug Info shows the belly count).
5. Task Manager → Details: CPU for `fugu-pet.exe` and `msedgewebview2.exe` while idle.
