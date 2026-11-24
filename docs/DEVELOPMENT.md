# Development

How LensPipe is built, tested and released. For using the app, see the [README](../README.md).

## Run from source

Requires Node.js `20+`.

```sh
npm install
npm run build
npm start          # https://localhost:8443/control
npm run dev        # rebuilds server and pages on change
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8443` | HTTPS port. If it is busy, the next free port is used (up to 10 tries). |
| `LOG_LEVEL` | `info` | Server log level. |
| `LENSPIPE_DATA_DIR` | repo folder / user data folder (desktop) | Where `certs/` and `diagnostics/` are stored. |
| `LENSPIPE_LOCAL_HTTP` | off (`1` in the desktop app) | Also serve plain HTTP on `127.0.0.1`, for a local OBS without certificates. |
| `LOCAL_HTTP_PORT` | `PORT + 1` | Port of that loopback listener. |

The first start creates `certs/`: the private key, the local CA certificate, the list of IPs it covers, and the pairing key. Delete the folder to reset everything, or only `certs/pairing-token` to unpair all devices.

## Project layout

```text
pages/          HTML entry points (control, sender, obs, diag), built to dist/<page>.html
public/         Favicon and audio worklets, copied as-is
src/
  sender/       Phone: capture, WebCodecs encoder, camera controls
  control/      PC studio: preview, settings, connection and OBS dialogs, telemetry
  obs/          OBS Browser source
  diag/         Per-lens format benchmark (/diag)
  amstech-ui/   Shared UI tokens, components and fonts
  receiver.ts   Shared decoder (WebGL2 / Canvas 2D) and PCM audio player
  health.ts     Link / encoder / PC bottleneck detection and suggested fixes
  h264-sps.ts   Rewrites the H.264 SPS to max_num_reorder_frames = 0 (no decoder delay)
  protocol.ts, socket.ts, stream-settings.ts, pairing.ts
server/
  index.ts      Fastify HTTPS (+ loopback HTTP) server, security headers, API routes
  relay.ts      WebSocket relay: config cache, zero-copy forwarding, per-receiver backpressure
  network.ts    USB tethering and LAN discovery, Windows firewall check
  certificates.ts, cert-trust.ts, pairing.ts, paths.ts, wire.ts
src-tauri/      Desktop app: window, tray, server supervision, splash and error screen
scripts/        Tests, sidecar and icon builders
```

## How it works

The phone encodes with WebCodecs (H.264 or HEVC) and sends binary packets over a WebSocket. The PC server relays them, without decoding, to the studio (`/control`) and to OBS (`/obs`), which decode them with WebCodecs.

Every packet starts with a 1-byte tag. Timestamps are big-endian `Float64` microseconds.

| Tag | Payload |
| --- | --- |
| `0x01` | JSON video decoder config and orientation |
| `0x02` | Timestamp + keyframe |
| `0x03` | Timestamp + delta frame |
| `0x04` | JSON audio config (`pcm-s16le`) |
| `0x05` | Timestamp + 16-bit mono PCM |
| `0x10` | JSON control: commands (`set-encoding`, …), state, ping/pong, telemetry, `ack` |

- The relay caches the latest `0x01` / `0x04` so a new receiver starts on the next keyframe.
- Flow control: the relay acknowledges received bytes, and the phone skips frames when more than ~`250 ms` of video is unacknowledged. A slow link drops frames instead of adding delay.
- Each receiver has its own queue (~`200 ms`), so a slow or hidden tab never stalls OBS.

## Desktop app

The Tauri app runs the server as a sidecar: `server/` bundled by esbuild into a Node single-executable (`npm run build:sidecar`). The server prints `LENSPIPE_READY {json}` when it listens; the app then opens the studio. If the server stops, the app restarts it up to 3 times in 2 minutes, then shows an error screen with **Try again**.

```sh
npm run tauri:dev      # build pages + sidecar, run the app
npm run tauri:build    # installers in src-tauri/target/release/bundle/
```

## Tests

```sh
npm run typecheck
npm test               # unit suites: receiver, SPS, health, pairing, orientation, formats, paths, cert trust
npm run test:desktop   # desktop-mode server (add --binary <path> to test a built sidecar)
```

With the server running (`npm start`):

```sh
npm run test:relay     # pages, relay, acknowledgements, control round-trip
npm run test:ui        # headless Chrome layout checks (CHROME_PATH to pick the browser)
npm run screenshots    # regenerate docs/screenshots/
npm run test:audio     # audio playback under bursty delivery
npm run measure:pc     # PC decode + draw time while streaming
```

CI (`.github/workflows/ci.yml`) runs typecheck, unit, desktop and relay tests on every pull request and push to `main`.

Camera and encoder changes must be checked on a real phone: desktop browsers cannot emulate phone lenses or hardware encoders.

## Release

1. Update the version in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` (numbers only, e.g. `1.1.0`: the Windows MSI rejects pre-release labels), and add the changes to `CHANGELOG.md`.
2. Push a `v<version>` tag. `desktop-build.yml` tests the server binary on each OS, builds every installer and attaches them to a draft GitHub release.
3. Review the draft and publish it.
