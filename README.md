# Fugu Pet

A realistic 3D pufferfish that lives on your desktop. Drop files on it and it swallows them into its belly (references only — nothing is moved), grows with their size, tidies your Desktop, and offers quick actions (compress, HEIC → JPG, merge PDFs). In Play mode it swims to wherever you click and eats Desktop files (they are only hidden, and come back when Play mode ends).

Built with Tauri 2, TypeScript and Three.js. macOS first; Windows is planned.

- App source, build and usage: [`app/`](app/README.md)
- Design plan (Chinese): [`desktop-pet-plan.md`](desktop-pet-plan.md)
- Early visual prototype: [`fugu-pet-prototype.html`](fugu-pet-prototype.html)

## Quick start

```bash
cd app
npm install
npm run tauri dev
```

Release build: `npm run tauri build -- --bundles app` → `app/src-tauri/target/release/bundle/macos/Fugu Pet.app`.
