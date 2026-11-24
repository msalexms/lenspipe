# Changelog

All notable changes to LensPipe. Versions follow [Semantic Versioning](https://semver.org/).

## [1.0.0] — Unreleased

First official release.

### Added
- **Desktop app** (Tauri v2) for Windows, macOS and Linux. It bundles the server, so no Node.js install is needed:
  - system tray menu (open the studio, open it in a browser, OBS preview, quit);
  - a notification the first time the window is closed to the tray;
  - the server is restarted after a crash (up to 3 times in 2 minutes); if it cannot start, an error screen shows its output and a **Try again** button;
  - local OBS URL over plain HTTP on `127.0.0.1`, so OBS on the same PC needs no certificate.
- **Trust for OBS (1 click):** installs the local certificate in the OS trust store (Windows, macOS, Linux NSS).
- User data folders for the desktop app (`%APPDATA%\LensPipe`, `~/Library/Application Support/LensPipe`, `~/.local/share/lenspipe`) and the `LENSPIPE_DATA_DIR` override.
- The certificate is renewed automatically 30 days before it expires.
- CI on every push to `main` and every pull request: typecheck, unit tests, build, desktop-mode server and relay smoke tests. Release builds also test the compiled server binary on each OS.

### Changed
- **License: GPL-3.0-or-later** (was MIT). The LensPipe name and logos are not covered by the license.
- Phone: **Mic** and **Mute** are one key (**Mic off / Mic live / Muted**).
- Phone: the top bar shows only the route and FPS; tap it for bitrate, size and encoder queue.
- Studio: one **Settings** button (in the Stream panel) and one **About** button (in the header, also on small screens). **Force keyframe** is now a lighter **Keyframe** button; `K` still works.
- All pages, including `/obs` and `/diag`, use a strict Content-Security-Policy with no inline styles.
- `/api/health` only reports ports and platform to this PC.
- Firewall help no longer assumes the server runs as Node.js.
- The page HTML files moved from the repository root to `pages/`.
- Shorter README for users; build, architecture, tests and release steps moved to `docs/DEVELOPMENT.md`.

### Removed
- The single-field remote commands `set-orientation`, `set-preset`, `set-bitrate` and `set-codec`: everything goes through `set-encoding`.
- Migration of settings and the pairing key from the pre-release name "Camera Link". Phones paired before the rename must scan the QR code once more.
- The unused root `index.html` (`/` redirects to `/control`).

### Fixed
- `/diag` rendered without styles: the strict CSP blocked its inline `<style>`.
- An expired certificate was never regenerated.
- `esbuild` was used by the sidecar build without being declared.
