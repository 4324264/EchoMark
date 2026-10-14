// Send small mono PCM blocks to the page; outputs remain silent.
class EchoPCM extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = new Float32Array(2048); this.used = 0; }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input) for (const sample of input) {
      this.buffer[this.used++] = sample;
      if (this.used === this.buffer.length) {
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(2048); this.used = 0;
      }
    }
    return true;
  }
}
registerProcessor('echo-pcm', EchoPCM);
