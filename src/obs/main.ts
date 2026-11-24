import { StreamReceiver } from '../receiver';

const canvas = document.getElementById('obs-canvas') as HTMLCanvasElement;
const receiver = new StreamReceiver(canvas, '/ws/obs');
receiver.addEventListener('pairing-required', () => {
  const message = document.createElement('p');
  message.textContent = 'Not paired: copy the OBS source URL again from the PC studio (it includes the pairing key).';
  message.className = 'obs-message';
  canvas.replaceWith(message);
});
canvas.addEventListener('pointerdown', () => receiver.resumeAudio());
window.addEventListener('resize', () => receiver.fitCanvas());

