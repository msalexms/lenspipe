# iPhone Camera Link

<sub>**An AMSTech project** · Open source · MIT</sub>

Use your iPhone as a low-latency studio camera on your PC and in OBS, over a USB cable or Wi-Fi. It runs entirely on your own network with **WebCodecs and binary WebSockets**: no app to install on the iPhone, no cloud relay, no account, no WebRTC, no UI framework and no browser extension.

<p align="center">
  <img src="docs/screenshots/control-desktop.png" alt="PC studio with live preview, telemetry and remote camera controls" width="720">
  <img src="docs/screenshots/sender-controls-mobile.png" alt="iPhone sender with lens, torch, mic and OLED-off controls" width="220">
</p>

- Fastify HTTPS server with automatic first-run certificate generation
- Separate, continuously refreshed USB tethering and Wi-Fi/LAN URLs + QR codes
- H.264 High or HEVC, with the lowest codec level that fits each format; HEVC High tier above 40 Mbps; 20–200 Mbps
- VBR or CBR, and a **quality** (lookahead) or **realtime** encoder mode, each with automatic fallback
- End-to-end flow control: the server acknowledges received bytes (coalesced to at most one acknowledgement per 25 ms, and flushed within 1 s when the stream pauses), and the iPhone skips frames before encoding when more than about 250 ms of video — measured at the encoder's *actual* output rate — is unacknowledged. A link slower than the bitrate costs frames, not ever-growing lag.
- One-tap **Max quality** / **Low latency** profiles; settings live in a dedicated dialog on both the iPhone and the PC, and the iPhone remembers them
- 16:9 video modes (4K60, 4K30, 1080p60, 1080p30) with the iPhone's full video processing, plus 4:3 full-sensor photo modes (12 MP, 1920×1440, 1440×1080) marked with a warning, in landscape or portrait
- Fixed output orientation that never flips by itself, a 180° turn for upside-down mounts, and a warning on the iPhone and in the studio when the phone is held the wrong way
- iPhone lens hot-swap, zoom, torch, focus/exposure, microphone, and OLED blackout
- Hardware-preferred canvas decoding, zero-copy server frame forwarding, and live telemetry
- Full-screen `/obs` source with cached codec configurations and automatic reconnection

> H.264 and HEVC are lossy codecs: no encoder can guarantee literally lossless video or zero blocking under every motion/network condition. High bitrates, hardware encoding, and constant bitrate where supported are used to minimize artifacts. Because the WebSocket link runs over TCP (no packet loss), periodic keyframes are spaced 2 seconds apart so the bitrate goes into detail rather than repeated I-frames; joins and congestion recovery request an on-demand keyframe instead (coalesced to at most one every 250 ms).

## Security and privacy

The server listens on your local network, so it protects the camera from other devices on it:

- **Pairing key.** Devices other than this PC need a random key to send or watch the stream. It is created on first start in `certs/pairing-token` and is part of every QR code and of the copied OBS URL, after `#k=`. The URL fragment never reaches the server logs. Each device remembers the key, so reloading the plain URL keeps working. Pages opened on the PC itself (`https://localhost:8443/control`, or OBS on the same PC) need no key. A request only counts as local if it comes from this PC *and* is addressed to it (`Host` is `localhost` or one of its addresses) with no proxy headers. A tunnel or port forwarder running on the PC (ngrok, VS Code / Dev Tunnels port forwarding, Tailscale Funnel, `netsh portproxy`) therefore cannot hand outside visitors keyless access. Network details (`/api/network`) are for paired devices only. To unpair every device, stop the server, delete `certs/pairing-token`, and start it again.
- **Same-origin WebSockets.** Browsers can only connect from pages served by this server, so another website open in a tab cannot reach the stream.
- **Hardened responses.** Every page ships `Content-Security-Policy` (scripts, styles, fonts and connections restricted to this origin, framing by other sites forbidden), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and `X-Frame-Options: SAMEORIGIN`. WebSocket messages are capped at 32 MiB, far above any real frame, so a paired-but-malicious client cannot make the relay allocate huge buffers.
- **Constrained certificate.** The self-signed certificate is a CA, because iOS only allows full trust for CA certificates. It carries name constraints, so it can only ever vouch for `localhost` and private IPv4 addresses (`10/8`, `172.16/12`, `192.168/16`, `127/8`). Even a leaked `local-key.pem` cannot impersonate a public website.

Anyone who has the pairing key can watch the camera, so treat the QR code and the OBS URL like a password.

## Requirements

- **PC:** Node.js 20+ and npm (verified on Node 22)
- **Phone:** a recent iOS Safari with WebCodecs `VideoEncoder` support (iOS 16.4+; a current iOS release is recommended)
- **USB:** an iPhone data cable and Personal Hotspot support
- **Network:** PC and iPhone on the same unrestricted LAN when using Wi-Fi. Disable AP/client isolation.

## Start

```sh
npm install
npm run dev
```

The development command watches both TypeScript projects and serves the built application over one HTTPS origin. For a normal production run:

```sh
npm run build
npm start
```

Open **https://localhost:8443/control** on the PC. Set `PORT=...` before startup to use a different port. On Windows, allow Node.js through the firewall on **Private networks** when prompted.

The first startup creates:

```text
certs/local-key.pem
certs/local-cert.pem
```

Both files are gitignored. For the best persistent-trust experience, connect the intended USB/Wi-Fi interface **before the first certificate generation**, so its IP address is included in the certificate. If you change PCs or need to regenerate it, stop the server, remove the generated `certs` directory, and start again.

## Connect the iPhone

In the studio, choose **Connect iPhone**. USB is listed first when detected; interface scanning continues every three seconds, including after a cable is attached.

### USB cable (preferred)

1. Connect the iPhone to the PC with a data/sync cable and tap **Trust** if iOS asks.
2. On iPhone, open **Settings → Personal Hotspot**, enable **Allow Others to Join**, and leave that page open briefly while the interface appears. Cellular service is not required for the local video path.
3. Scan the **USB Cable** QR code, or copy the URL shown by the app. It looks like `https://172.20.10.x:8443/sender#k=…` and includes the pairing key.
4. Keep Personal Hotspot enabled while streaming.

**If the USB page never loads on the iPhone:** Windows puts the new iPhone network ("Apple Mobile Device Ethernet") on the **Public** profile, while the firewall prompt only allowed Node.js on **Private** networks. The server detects this, prints the fix in its console, and shows it in **Connect iPhone**. To fix it, run the shown command once in an administrator PowerShell. It opens only the app's port, only to the iPhone's USB subnet:

```powershell
New-NetFirewallRule -DisplayName 'Camera Link (local sender)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8443 -RemoteAddress 172.20.10.0/28 -Profile Public
```

Alternatively, set that adapter's network profile to Private (**Settings → Network & internet → Ethernet → the Apple adapter → Network profile type**).

### Wi-Fi / LAN

1. Put the iPhone and PC on the same LAN.
2. Scan the **Wi-Fi LAN** QR code, or copy the URL shown by the app (`https://192.168.x.x:8443/sender#k=…`).
3. If the iPhone says **Not paired**, scan the QR code again. This can happen when Safari drops the key while you accept the certificate warning.
4. If the phone cannot connect, check the Windows firewall, VPN virtual adapters, guest-network isolation, and the PC's active network interface.

The defaults aim for the best picture with the least fuss: **4K30, 16:9, H.264, 60 Mbps, VBR, quality mode**. **Restore defaults** at the bottom of the iPhone settings brings them back. On a busy Wi-Fi network, use the **Low latency** profile (1080p60, H.264, 40 Mbps, CBR, realtime). Over USB, **Max quality** (4K30, HEVC, 80 Mbps, VBR, quality mode) gives the most detail. On Windows the iPhone's USB network adapter links at 100 Mbps, so bitrates near or above that cannot fit through the cable. If the link, the iPhone encoder or the PC falls behind for a few seconds, both the iPhone and the studio show a warning. The warning names the cause (link saturated, iPhone encoder saturated, or PC not drawing fast enough) and has a one-tap fix: a lower bitrate based on what actually got through, a lighter format, or H.264.

### Trust the local certificate on iOS

The certificate is generated locally and is not issued by a public CA. Safari's warning is expected.

**Fast, per-site option:** on the Safari warning page, open **Show Details / Advanced**, review the address, and choose **visit this website**. Camera and WebCodecs access then work on that accepted HTTPS origin.

**Persistent trust option:** transfer only `certs/local-cert.pem` to your own iPhone (AirDrop or a cable), open it, and approve the downloaded profile in iOS Settings. Then enable it under **Settings → General → About → Certificate Trust Settings**. Never transfer `local-key.pem`, and only trust a certificate you generated on your own PC.

QR codes and URLs use the PC's current IP; HTTPS itself does not require an internet connection.

Upgrading from a version without certificate name constraints regenerates the certificate once on startup. Trust the new `local-cert.pem` again on the iPhone and in OBS.

## Use the sender

Tap **Start camera** and grant access. Back lenses often appear only after this first permission grant.

- Lens buttons swap capture without reconnecting the WebSocket.
- **Formats.** The **16:9** formats (4K and 1080p, 30 or 60 fps) are iOS video modes. They get the iPhone's full video processing: temporal noise reduction, video HDR, tone mapping, and downscaling from the whole sensor. Use them for the best picture. The **4:3** formats are the whole sensor (12 MP 4032×3024 and 1920×1440 at 30 fps, 1440×1080 at 60 fps), with a wider field of view. Safari delivers them as photo modes, without most of that processing, so they look noisier and flatter. When one is selected, the iPhone settings, the studio settings dialog and the studio's stream summary show a warning. 12 MP may be cropped to the largest size the iPhone can encode, and needs a PC GPU that decodes H.264/HEVC level 6.0.
- **Orientation.** iOS delivers every frame in sensor orientation and only tags it with how the phone is held. The app ignores that tag: the **16:9 / 9:16** button (4:3 / 3:4 for the 4:3 formats) alone decides the picture, at the full format size, and it never flips when the phone moves. Hold or mount the iPhone sideways for 16:9 and upright for 9:16. If it is mounted upside down, tap **Rotate 180°** on the iPhone or in the studio.
- **Wrong-way warning.** When the iPhone is held across the chosen aspect, the picture arrives on its side. When it is held upside down, the picture arrives upside down. In both cases the iPhone and the studio show a warning after a moment, with a one-tap fix: switch to the other aspect, or rotate 180°. The warning relies on iOS knowing how the phone is held, so keep **Rotation Lock** off.
- The iPhone preview is turned to show exactly what the PC receives. Switching the aspect or the turn never reopens the camera, and every choice is remembered. **Restore defaults** at the bottom of the iPhone settings brings back 4K30, 16:9, H.264, 60 Mbps, VBR and quality mode.
- To see which formats your iPhone's Safari actually offers, open `/diag` on the iPhone, at the same address as `/sender`, and tap **Run test**. It measures every lens and saves a report to `diagnostics/` on the PC.
- The torch stays on across lens and resolution changes. Resolution changes first try to resize the live camera track, which avoids reopening the camera. When a reopen is unavoidable, such as a lens change, the torch is turned back on afterwards.
- **OLED off** displays a true all-black full-screen overlay. Press and hold anywhere for **two seconds** to leave it. Wake Lock and a silent-media fallback keep the page alive; locking iOS with the physical power button cannot be overridden by a web app. After unlocking, visibility/track recovery resumes capture.
- **⚙ Settings** opens a sheet with quick profiles, format, codec, bitrate, rate control (VBR/CBR), encoder mode (quality/realtime), focus/exposure/EV and microphone source. Choices are stored on the iPhone and restored on the next visit.
- The sheet's status line shows what the encoder actually accepted (codec string, rate control, mode) and how frames are captured. If Safari rejects a requested option, the sender falls back automatically: HEVC High tier → Main tier, quality → realtime, VBR ↔ CBR, and HEVC → H.264 last.
- Frames are read with `MediaStreamTrackProcessor` inside a Worker on iOS Safari, which only exposes it there. That path reads every camera frame instead of copying from the `<video>` element at the display's pace; the `<video>` path remains as an automatic fallback.
- **Microphone permission:** if Safari is denied the mic, turning it on shows how to allow it, on the iPhone and in the studio: **Settings → Apps → Safari → Microphone**, or in Safari **aA → Website Settings → Microphone → Allow**, then reload. If iOS keeps audio suspended because the mic was turned on from the PC, both screens ask for one tap on the iPhone.
- Microphone capture disables echo cancellation, noise suppression, and automatic gain control. Audio is low-latency mono **16-bit PCM** over `AudioWorklet`, not AAC. Video-only mode omits audio packets completely for approximately 0.77 Mbps less traffic at 48 kHz.

## PC studio and remote control

`/control` receives live frames. The side panel keeps the live controls (lens, torch, mic/mute, orientation, zoom, EV) plus a stream summary; **⚙ Settings** opens the dialog with profiles, resolution/FPS, codec, bitrate, rate control, encoder mode, focus/exposure modes and microphone source. **Force keyframe** stays on the main view. Telemetry distinguishes USB/Wi-Fi, server-measured video throughput, application-level WebSocket ping RTT, FPS, queues, decoded frames, and dropped frames.

The FRAME RATE tile also shows **PC** latency: the time from a frame arriving in the tab to being drawn. With a GPU decoder it should stay at a few milliseconds. To measure it from the command line while the iPhone streams, run `npm run measure:pc`.

**Low-delay H.264 output.** In "quality" mode Safari's encoder writes an H.264 SPS without VUI `bitstream_restriction`. A standards-compliant decoder must then assume frames can be reordered, so it holds a full decoded picture buffer before showing anything: 13 frames (~430 ms at 30 fps) for 1080p. The iPhone never reorders frames, so the receiver rewrites the SPS to declare `max_num_reorder_frames = 0` (`src/h264-sps.ts`). Measured on an RTX 2060 SUPER, this took the PC-side delay from ~430 ms to 1–2 ms. If a stream ever does reorder frames, the receiver detects it and falls back to the original SPS. HEVC streams already declare zero reordering and are not affected.

In "realtime" mode Safari caps the encoder at about 15 Mbps whatever bitrate is requested, so "quality" is the mode that actually uses high bitrates. Its lookahead costs only ~11 ms on the iPhone.

Studio sound is off until you click **Preview audio**. The status next to that button shows whether the iPhone mic is off, blocked or waiting for a tap, whether audio is arriving, the current buffer, and any dropouts. Audio shares the connection with large video frames, so it arrives in bursts. The player's jitter buffer adapts: it starts at 60 ms, grows by 20 ms after each dropout (up to 250 ms), and shrinks again after 5 s without one. With the server running, `npm run test:audio` plays a bursty simulated microphone in a real Chrome and checks it stays dropout-free. H.264 High is the safest compatibility choice; native HEVC WebCodecs decoding depends on OS/browser and GPU support.

## OBS Studio

1. Add **Sources → Browser**.
2. Set **URL** to the PC address shown in the studio, for example:

   ```text
   https://192.168.1.20:8443/obs
   ```

   Click **OBS source** in the studio to copy the exact URL, which includes the pairing key. Shift-click it to preview locally.
3. Set width/height to your OBS canvas (for example 1920×1080), then enable **Refresh browser when scene becomes active** if desired.
4. Enable **Control audio via OBS** if you want the iPhone microphone on the Browser source's audio meter.

The view is a borderless black canvas with automatic aspect-ratio containment, so it handles both landscape and portrait without UI changes.

OBS has its own embedded Chromium trust store behavior. If it refuses the self-signed HTTPS source, install `certs/local-cert.pem` into your **own PC user's Trusted Root Certification Authorities** store and restart OBS. On Windows PowerShell:

```powershell
Import-Certificate -FilePath .\certs\local-cert.pem -CertStoreLocation Cert:\CurrentUser\Root
```

Only do this for your locally generated certificate. Do not use global `--ignore-certificate-errors` flags for a normal OBS installation.

## Binary protocol

Every WebSocket message is binary. Multi-byte timestamps use big-endian `Float64` microseconds.

| Type | Payload after the 1-byte tag |
| --- | --- |
| `0x01` | UTF-8 JSON video metadata / `decoderConfig`; codec extradata is base64-encoded |
| `0x02` | 8-byte video keyframe timestamp + `EncodedVideoChunk` bytes |
| `0x03` | 8-byte delta-frame timestamp + `EncodedVideoChunk` bytes |
| `0x04` | UTF-8 JSON PCM audio decoder metadata |
| `0x05` | 8-byte timestamp + little-endian signed 16-bit PCM samples |
| `0x10` | UTF-8 JSON commands, state, ping/pong, and telemetry. `{ type: 'command', command: 'set-encoding', settings: {...} }` applies any combination of preset, orientation, codec, bitrate, bitrateMode and latencyMode in one step |

The relay retains the latest `0x01` and `0x04` messages. Each receiver has its own backpressure: if its socket queues more than ~200 ms of video (at least 1.5 MiB), video deltas are skipped for that receiver only and relaying resumes at the next keyframe, so a slow or throttled tab never accumulates latency. A new `/control` or `/obs` WebSocket receives them immediately, asks for a keyframe, and decodes without waiting for an unrelated configuration event. Video packet buffers are forwarded unchanged.

Internal WebSocket routes are `/ws/sender`, `/ws/control`, and `/ws/obs`; all share the HTTPS origin/port. Browser connections are only accepted from pages served by this server (the `Origin` header must match), so another website open on the PC cannot connect to the stream.

## Verification

```sh
npm run typecheck
npm run build
npm test            # decoder, H.264 SPS, link-health and pairing unit tests
```

With the production server running in another terminal:

```sh
npm run test:relay
```

Browser-driven checks use a local Chrome or Chromium. They find it in the usual install locations, or you can set `CHROME_PATH`. With the server running:

```sh
npm run test:ui       # layout checks at desktop, phone and landscape sizes (scratch screenshots in artifacts/ui/)
npm run screenshots   # regenerate the README images in docs/screenshots/
npm run test:audio    # bursty simulated microphone must play without dropouts
```

The decoder regression test verifies fatal-error reconfiguration, dropped-delta reference purging, and keyframe recovery. The relay smoke test checks HTTPS pages/worklets, cached configurations, byte-identical keyframe relay, two-way commands, and live throughput. Camera encoding still needs to be tested on the target iPhone because desktop hardware cannot emulate iOS lens behavior or WebCodecs support.

## Design

The interface follows the AMSTech brand (manual v1.5, «stickers only»): cream paper (`#FFF6E9`), white boxes with a 2.5 px ink border (`#1E1B2E`), hard shadows and 6 px corners, one blue primary button per screen (`#2B36D9`) and yellow (`#FFE27A`) for what is selected and for warnings. Titles use **Bricolage Grotesque**, text **Figtree** and figures **DM Mono**. The head of Thor is the logo and the blue camera is this project's sticker; Thor's ears only appear on the USB steps bar of the connection dialog. Switches and segmented buttons show state (the hidden ON / OFF text is kept for screen readers), sliders fill in blue up to their value, the stream summary is a small data grid (cajetín), and the camera buttons on the iPhone are boxed keys with line icons. The interface is always light.

Colours, fonts and shapes come from the shared AMSTech package in `src/amstech-ui/` (tokens, components and fonts; replace the folder to update it). What is specific to this app lives in `src/shared.css`, `src/control.css` and `src/sender.css`; `src/amstech-ui.ts` paints the sliders and draws the steps bar. The icons are CSS masks, so buttons whose text the code rewrites keep their icon.

The fonts are bundled by Vite from `src/amstech-ui/fuentes/` (SIL Open Font License, licences alongside) rather than loaded from a CDN, so the app still works offline under the same-origin Content Security Policy.

## Project layout

```text
server/                 Fastify HTTPS, certificates, pairing, network scanner, binary relay
src/sender/             iPhone capture/encoder and hardware controls
src/control/            PC dashboard and QR connection flow
src/obs/                Minimal OBS source
src/receiver.ts         Shared VideoDecoder and PCM playback pipeline
src/protocol.ts         Binary framing and codec extradata serialization
public/                 AudioWorklet processors
scripts/                Unit, integration and browser-driven tests
docs/screenshots/       README images (npm run screenshots)
```

## Contributing

Issues and pull requests are welcome. Before opening a pull request, run `npm run typecheck` and `npm test`. If you change the interface, also run `npm run test:ui`. Camera and encoder changes need a test on a real iPhone, because desktop browsers cannot emulate iOS lenses or Safari's WebCodecs encoder. Please say which iPhone model and iOS version you tested on.

## License

[MIT](LICENSE) © AMSTech
