# Fugu Pet 🐡

A realistic 3D pufferfish that lives on your Mac's desktop. Feed it files, let it tidy your Desktop, and in Play mode watch it swim to wherever you click and gobble up Desktop files.

Built with [Tauri 2](https://tauri.app), TypeScript and [Three.js](https://threejs.org). The fish is fully procedural: no 3D model files, just geometry and shaders, all in code.

## Download

Get the latest **`Fugu-Pet-…-macOS-arm64.zip`** from the [Releases page](https://github.com/Arthur-Blackwood/fugu-pet/releases/latest).

**Requirements:** a Mac with Apple silicon (M1 or newer) running macOS 11 or later. On macOS 26 and later the panels use Apple's Liquid Glass; earlier versions get a frosted-glass look instead.

### Install

1. Unzip the download and drag **Fugu Pet.app** into your **Applications** folder.
2. Open it. The app isn't signed with an Apple Developer ID, so macOS blocks it the first time ("Apple could not verify…"). To allow it:
   - Open **System Settings → Privacy & Security**, scroll down, and click **Open Anyway** next to the Fugu Pet message. Confirm with your password.
   - *Or*, in Terminal: `xattr -dr com.apple.quarantine "/Applications/Fugu Pet.app"`, then open it normally.
3. The fish appears near the bottom-right corner of your screen. There's no Dock icon; everything else is in the **menu-bar icon** (Open Panel, Show Fish, Play Mode, test animations, Quit).

When you use a feature that needs it, macOS may ask whether Fugu Pet may **control Finder** (Play mode reads where your Desktop icons are) or **access your Desktop / Documents / Downloads** folders (Recent and Tidy). Allow these for those features to work.

## What it does

| Do this | What happens |
|---|---|
| Hover over the fish | It turns a shade lighter, and its eyes (and whole body) follow your cursor |
| Click the fish | Opens the glass panel, which zooms out of the fish: **Belly**, **Recent**, **Tidy**, **Settings** |
| Double-click the fish | Puffs up into a spiky ball and stays that way; double-click again to deflate |
| Drag the fish | Moves it, and an open panel moves with it (dragging the panel's top bar moves the fish too) |
| Drop files or folders on the fish | It swallows them into its **belly** and grows with their total size. This keeps references only: nothing is moved or copied |
| Belly tab | Click rows to select (Shift-click for a range), then use quick actions or **Let out**. The fish puffs up and tells you what's inside |
| Tidy tab | Previews where loose Desktop files would go, moves them only when you click **Tidy**, and can **Undo** (the fish gets angry when you do 😤) |
| Settings tab | Size, fin speed, sway, bubbles, cursor following and its range (up to full screen), idle fidgets, sleep timer, battery saver |

**Quick actions** (results are new files next to the originals, and Undo moves them to the Trash):
- Compress an image to under 1 MB
- Convert HEIC to JPG
- Merge PDFs

### Play mode

Turn it on from the menu-bar icon or the Belly tab. A shimmering silver border lights up around the screen.

- **Click anywhere** and the fish swims there: it turns to face the way it's going, beats its tail, and leaves a trail of bubbles.
- **Double-click a Desktop file** and the fish swims over, opens wide, and sucks the file in as it spins and shrinks into its mouth. The fish grows, and the spot keeps bubbling.
- **Press Esc** (or the exit button) to end Play mode. **Every eaten file comes back.** Files are only *hidden* while you play, never moved or deleted, and they're restored even if the app quits unexpectedly.

### Safety

Fugu Pet never deletes or overwrites your files.
- The belly only holds references to files.
- Tidy moves files only after you confirm, and remembers how to undo the move.
- Play mode only hides Desktop files temporarily.
- Quick-action results go to the Trash on Undo, so you can still get them back.

## Build from source

You need [Node.js](https://nodejs.org) 20+, [Rust](https://rustup.rs), and Xcode Command Line Tools (`xcode-select --install`).

```bash
git clone https://github.com/Arthur-Blackwood/fugu-pet.git
cd fugu-pet/app
npm install
npm run tauri dev                      # run with hot reload
npm run tauri build -- --bundles app   # → src-tauri/target/release/bundle/macos/Fugu Pet.app
```

More developer notes, including the code layout, how click-through works and testing in a sandbox, are in [`app/README.md`](app/README.md). The original design plan (in Chinese) is [`desktop-pet-plan.md`](desktop-pet-plan.md).

## Status

- Version 0.1.0.
- macOS on Apple silicon is the supported platform. A Windows build is planned but not tested yet.
- The release is unsigned, so the first launch needs the "Open Anyway" step above.
