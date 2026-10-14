(function (root) {
  root.EchoLocalASR = class LocalASR {
    constructor(options) {
      this.options = options;
      this.worker = null;
      this.ready = false;
      this.running = false;
      this.session = 0;
      this.queue = [];
      this.busy = false;
    }
    async load() {
      if (this.ready) return;
      if (this.loading) return this.loading;
      this.worker = new Worker('./local-asr-worker.js', { type: 'module' });
      this.loading = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.worker?.terminate(); this.worker = null; this.loading = null;
          reject(new Error('模型加载超时，请检查网络后重试。'));
        }, 180000);
        this.worker.onerror = event => {
          clearTimeout(timeout); this.loading = null;
          if (!this.ready) { this.worker?.terminate(); this.worker = null; reject(new Error(event.message || '无法加载本机识别运行库')); }
          else this.options.onError?.(event.message || '本机识别运行库错误');
        };
        this.worker.onmessage = event => {
          const message = event.data;
          if (message.type === 'progress') this.options.onProgress?.(message);
          if (message.type === 'ready') { clearTimeout(timeout); this.ready = true; resolve(); }
          if (message.type === 'error') {
            if (!this.ready) { clearTimeout(timeout); this.loading = null; this.worker?.terminate(); this.worker = null; reject(new Error(message.message)); }
            else {
              this.busy = false;
              if (message.session === this.session && this.running) this.options.onError?.(message.message);
              this.drain();
            }
          }
          if (message.type === 'result') {
            this.busy = false;
            if (message.session === this.session && this.running && message.text.trim()) this.options.onText?.(message.text.trim());
            this.drain();
          }
        };
        this.worker.postMessage({ type: 'init' });
      });
      return this.loading;
    }
    async start(stream, language) {
      this.stop();
      const session = ++this.session;
      this.running = true;
      this.language = language;
      this.blocks = []; this.samples = 0; this.voiced = 0; this.quiet = 0;
      this.preRoll = [];
      this.context = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      const context = this.context;
      await context.audioWorklet.addModule('./pcm-worklet.js');
      if (!this.running || session !== this.session) return;
      this.source = context.createMediaStreamSource(stream);
      this.pcm = new AudioWorkletNode(context, 'echo-pcm');
      this.gain = context.createGain(); this.gain.gain.value = 0;
      this.source.connect(this.pcm); this.pcm.connect(this.gain); this.gain.connect(context.destination);
      this.pcm.port.onmessage = event => { if (this.running && this.session === session) this.addBlock(event.data, context.sampleRate); };
      await context.resume();
    }
    addBlock(block, sampleRate) {
      let energy = 0; for (const sample of block) energy += sample * sample;
      const speech = Math.sqrt(energy / block.length) > 0.012;
      if (!this.blocks.length && !speech) {
        this.preRoll.push(block); if (this.preRoll.length > 3) this.preRoll.shift(); return;
      }
      if (!this.blocks.length) { this.blocks.push(...this.preRoll); this.samples = this.preRoll.reduce((n, b) => n + b.length, 0); this.preRoll = []; }
      this.blocks.push(block); this.samples += block.length;
      if (speech) { this.voiced += block.length; this.quiet = 0; } else this.quiet += block.length;
      if ((this.quiet > sampleRate * 0.6 && this.samples > sampleRate * 1.2) || this.samples >= sampleRate * 5) {
        if (this.voiced > sampleRate * 0.25) {
          const joined = new Float32Array(this.samples); let offset = 0;
          for (const part of this.blocks) { joined.set(part, offset); offset += part.length; }
          const audio = sampleRate === 16000 ? joined : this.resample(joined, sampleRate);
          if (this.queue.length >= 3) { this.queue.shift(); this.options.onSlow?.(); }
          this.queue.push(audio); this.drain();
        }
        this.blocks = []; this.samples = this.voiced = this.quiet = 0;
      }
    }
    resample(input, sampleRate) {
      const output = new Float32Array(Math.round(input.length * 16000 / sampleRate));
      for (let i = 0; i < output.length; i++) { const position = i * sampleRate / 16000, at = Math.floor(position), fraction = position - at; output[i] = input[at] * (1 - fraction) + (input[Math.min(at + 1, input.length - 1)] || 0) * fraction; }
      return output;
    }
    drain() {
      if (!this.running || !this.ready || this.busy || !this.queue.length) return;
      this.busy = true;
      const audio = this.queue.shift();
      this.worker.postMessage({ type: 'transcribe', audio, language: this.language, session: this.session }, [audio.buffer]);
    }
    stop() {
      this.running = false; this.session++; this.queue = [];
      this.source?.disconnect(); this.pcm?.disconnect(); this.gain?.disconnect();
      if (this.pcm) this.pcm.port.onmessage = null;
      this.source = this.pcm = this.gain = null;
      this.blocks = []; this.preRoll = [];
      if (this.context) this.context.close().catch(() => {});
      this.context = null;
    }
  };
})(globalThis);
