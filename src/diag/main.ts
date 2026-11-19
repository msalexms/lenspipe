/**
 * Camera format diagnostics: which capture sizes and frame rates Safari really delivers on each lens.
 * Results go to the PC (POST /api/diagnostics) and are saved under diagnostics/.
 */
import { pairingToken } from '../pairing';

const SIZES: Array<[number, number, string]> = [
  [4032, 3024, '4:3'], [3264, 2448, '4:3'], [2592, 1944, '4:3'], [2016, 1512, '4:3'], [1920, 1440, '4:3'], [1440, 1080, '4:3'],
  [3840, 2160, '16:9'], [1920, 1080, '16:9'],
];

interface Attempt {
  lens: string;
  asked: string;
  ratio: string;
  requestedFps: number;
  ok: boolean;
  error?: string;
  width?: number;
  height?: number;
  settingsFps?: number;
  measuredFps?: number;
  videoWidth?: number;
  videoHeight?: number;
  capabilities?: Record<string, unknown>;
}

const $ = (id: string) => document.getElementById(id)!;
const video = $('probe') as HTMLVideoElement;
const status = (text: string) => { $('status').textContent = text; };
const pause = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

/** Frames the <video> actually presents per second (what the camera delivers at this size). */
async function measureFps(ms = 1500): Promise<number> {
  if (!('requestVideoFrameCallback' in video)) return 0;
  let frames = 0;
  let first = 0;
  let last = 0;
  await new Promise<void>((resolve) => {
    const start = performance.now();
    const onFrame = (now: number) => {
      if (!first) first = now;
      last = now;
      frames++;
      if (now - start < ms) video.requestVideoFrameCallback(onFrame);
      else resolve();
    };
    video.requestVideoFrameCallback(onFrame);
    window.setTimeout(resolve, ms + 1500);
  });
  return frames > 1 && last > first ? Math.round(((frames - 1) * 1000) / (last - first)) : 0;
}

async function tryFormat(deviceId: string, lens: string, width: number, height: number, ratio: string, fps: number): Promise<Attempt> {
  const attempt: Attempt = { lens, asked: `${width}×${height}@${fps}`, ratio, requestedFps: fps, ok: false };
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { deviceId: { exact: deviceId }, width: { exact: width }, height: { exact: height }, frameRate: { ideal: fps } },
    });
  } catch (error) {
    attempt.error = error instanceof Error ? error.name : String(error);
    return attempt;
  }
  try {
    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings();
    const caps = track.getCapabilities?.() as Record<string, { max?: number } | undefined> | undefined;
    video.srcObject = stream;
    await video.play().catch(() => undefined);
    await pause(400);
    Object.assign(attempt, {
      ok: true,
      width: settings.width,
      height: settings.height,
      settingsFps: settings.frameRate,
      measuredFps: await measureFps(),
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      capabilities: { width: caps?.width?.max, height: caps?.height?.max, frameRate: caps?.frameRate?.max },
    });
  } finally {
    stream.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
  }
  return attempt;
}

function addRow(attempt: Attempt): void {
  const table = $('results') as HTMLTableElement;
  table.hidden = false;
  const row = table.tBodies[0].insertRow();
  const caps = attempt.capabilities;
  const cells = [
    attempt.lens,
    attempt.asked,
    attempt.ok ? `${attempt.width}×${attempt.height}` : attempt.error || 'no',
    attempt.ok ? String(attempt.measuredFps ?? '') : '',
    attempt.ok ? `${caps?.width ?? '?'}×${caps?.height ?? '?'} · ${caps?.frameRate ?? '?'} fps` : '',
  ];
  cells.forEach((text, index) => {
    const cell = row.insertCell();
    cell.textContent = text;
    if (index === 2) cell.className = attempt.ok ? 'ok' : 'no';
  });
}

async function run(): Promise<void> {
  const button = $('run') as HTMLButtonElement;
  button.disabled = true;
  ($('results') as HTMLTableElement).tBodies[0].replaceChildren();
  const report = {
    userAgent: navigator.userAgent,
    screen: { width: screen.width, height: screen.height, angle: screen.orientation?.angle, dpr: devicePixelRatio },
    supports: {
      videoEncoder: 'VideoEncoder' in window,
      trackProcessorInWindow: 'MediaStreamTrackProcessor' in window,
      requestVideoFrameCallback: 'requestVideoFrameCallback' in HTMLVideoElement.prototype,
    },
    devices: [] as Array<{ label: string }>,
    attempts: [] as Attempt[],
    startedAt: new Date().toISOString(),
  };
  try {
    status('Asking for camera access…');
    const warmup = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    warmup.getTracks().forEach((track) => track.stop());
    const cameras = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'videoinput');
    report.devices = cameras.map((device) => ({ label: device.label }));
    let step = 0;
    const total = cameras.length * SIZES.length;
    for (const camera of cameras) {
      const lens = camera.label || 'Camera';
      for (const [width, height, ratio] of SIZES) {
        status(`Testing ${++step}/${total}: ${lens} · ${width}×${height}`);
        const attempt = await tryFormat(camera.deviceId, lens, width, height, ratio, 60);
        report.attempts.push(attempt);
        addRow(attempt);
      }
    }
    status('Sending results to the PC…');
    const token = pairingToken();
    const response = await fetch('/api/diagnostics', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { 'x-pairing-key': token } : {}) },
      body: JSON.stringify(report),
    });
    status(response.ok
      ? 'Done. Results saved on the PC.'
      : `Done, but the PC refused the results (${response.status}). Scan the QR code again, then rerun.`);
  } catch (error) {
    status(`Stopped: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    button.disabled = false;
  }
}

// Picks up the pairing key from the URL (#k=…) or from the sender page on this iPhone.
pairingToken();
$('run').addEventListener('click', () => void run());
