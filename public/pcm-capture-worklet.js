class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 960;
    this.buffer = new Float32Array(this.size);
    this.offset = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input?.length) return true;
    const frames = input[0].length;
    let peak = 0;
    for (let i = 0; i < frames; i++) {
      let sample = 0;
      for (let channel = 0; channel < input.length; channel++) sample += input[channel][i] || 0;
      sample /= input.length;
      peak = Math.max(peak, Math.abs(sample));
      this.buffer[this.offset++] = sample;
      if (this.offset === this.size) {
        const output = this.buffer;
        this.port.postMessage({ samples: output.buffer, peak, timestamp: currentTime * 1_000_000 }, [output.buffer]);
        this.buffer = new Float32Array(this.size);
        this.offset = 0;
        peak = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
