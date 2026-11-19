// Plays mono PCM chunks pushed from the main thread through an adaptive jitter buffer.
// Audio shares the TCP connection with large video frames, so it arrives in bursts. Playback starts
// once `target` is buffered; every underrun raises the target (up to MAX_TARGET_MS) and 5 s without one
// lowers it again, so latency settles at the smallest buffer this link allows. Audio beyond
// target + HEADROOM_MS (bursts, clock drift between iPhone and PC) is dropped so latency can't creep up.
const START_TARGET_MS = 60;
const MIN_TARGET_MS = 40;
const MAX_TARGET_MS = 250;
const STEP_UP_MS = 20;
const STEP_DOWN_MS = 5;
const STABLE_SECONDS = 5;
const HEADROOM_MS = 150;

class PcmPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.head = null;
    this.offset = 0;
    this.queued = 0;
    this.playing = false;
    this.underruns = 0;
    this.dropped = 0;
    this.received = 0;
    this.quanta = 0;
    this.targetMs = START_TARGET_MS;
    this.stableSamples = 0;
    this.port.onmessage = (event) => {
      const chunk = new Float32Array(event.data);
      this.queue.push(chunk);
      this.queued += chunk.length;
      this.received++;
      const max = ((this.targetMs + HEADROOM_MS) * sampleRate) / 1000;
      while (this.queued > max && this.queue.length > 1) {
        this.queued -= this.queue.shift().length;
        this.dropped++;
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const frames = output[0].length;
    if (!this.playing && this.queued >= (this.targetMs * sampleRate) / 1000) this.playing = true;
    for (let i = 0; i < frames; i++) {
      let sample = 0;
      if (this.playing) {
        if (!this.head) {
          this.head = this.queue.shift() || null;
          this.offset = 0;
        }
        if (this.head) {
          sample = this.head[this.offset++];
          this.queued--;
          if (this.offset >= this.head.length) this.head = null;
        } else {
          // Ran dry: go silent, buffer more next time, and wait until the target is buffered again.
          this.playing = false;
          this.underruns++;
          this.targetMs = Math.min(MAX_TARGET_MS, this.targetMs + STEP_UP_MS);
          this.stableSamples = 0;
        }
      }
      for (let channel = 0; channel < output.length; channel++) output[channel][i] = sample;
    }
    if (this.playing) {
      this.stableSamples += frames;
      if (this.stableSamples >= sampleRate * STABLE_SECONDS) {
        this.stableSamples = 0;
        this.targetMs = Math.max(MIN_TARGET_MS, this.targetMs - STEP_DOWN_MS);
      }
    }
    // ~4 status reports per second for the studio's audio indicator.
    if (++this.quanta % Math.max(1, Math.round(sampleRate / 128 / 4)) === 0) {
      this.port.postMessage({
        bufferedMs: (this.queued / sampleRate) * 1000,
        targetMs: this.targetMs,
        underruns: this.underruns,
        dropped: this.dropped,
        received: this.received,
        playing: this.playing,
      });
    }
    return true;
  }
}

registerProcessor('pcm-player', PcmPlayerProcessor);
