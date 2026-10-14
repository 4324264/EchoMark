/* Serializes recognition sessions. A successful connection is not proof of a working service. */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./speech-core.js') : root.EchoSpeech);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EchoRecognitionController = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core) {
  return class RecognitionController {
    constructor(options) {
      this.options = options;
      // Browser timer methods must be called with their native binding, not as object methods.
      this.clock = options.clock || { setTimeout: (task, delay) => setTimeout(task, delay), clearTimeout: timer => clearTimeout(timer), now: () => Date.now() };
      this.instance = null;
      this.generation = 0;
      this.attempts = 0;
      this.want = false;
      this.blocked = false;
      this.timer = 0;
      this.watchdog = 0;
    }
    start() {
      if (this.want && !this.blocked) return;
      this.want = true;
      this.blocked = false;
      this.attempts = 0;
      this.connect();
    }
    stop() {
      this.want = false;
      this.blocked = false;
      this.generation++;
      this.clock.clearTimeout(this.timer);
      this.clock.clearTimeout(this.watchdog);
      this.timer = this.watchdog = 0;
      const old = this.instance;
      this.instance = null;
      try { old?.abort(); } catch (_) { /* Already ended. */ }
    }
    reconnect() {
      if (!this.want) return;
      this.generation++;
      const old = this.instance;
      this.instance = null;
      this.clock.clearTimeout(this.watchdog);
      try { old?.abort(); } catch (_) { /* Already ended. */ }
      this.retry('audio-ended', 0, false);
    }
    connect() {
      if (!this.want || this.blocked || this.instance) return;
      const token = ++this.generation;
      const current = () => this.want && this.generation === token && this.instance === recognition;
      let recognition;
      let began = this.clock.now(), gotResult = false, error = '';
      try {
        recognition = new this.options.Recognition();
        this.instance = recognition;
        recognition.lang = this.options.language;
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.maxAlternatives = 3;
        this.options.onState?.('connecting');
        recognition.onstart = () => {
          if (!current()) return;
          this.clock.clearTimeout(this.watchdog);
          this.watchdog = 0;
          began = this.clock.now();
          this.options.onState?.('listening');
        };
        recognition.onresult = event => {
          if (!current()) return;
          if ([...event.results].some(result => result[0]?.transcript.trim())) {
            gotResult = true;
            this.attempts = 0;
          }
          this.options.onResult?.(event);
        };
        recognition.onerror = event => {
          if (!current()) return;
          error = event.error || 'unknown';
          const policy = core.retryDecision(this.attempts, error, this.clock.now() - began, gotResult);
          if (policy.fatal) {
            this.blocked = true;
            this.generation++;
            this.instance = null;
            this.clock.clearTimeout(this.watchdog);
            try { recognition.abort(); } catch (_) { /* Service already closed. */ }
            this.options.onState?.('blocked', { error, fatal: true });
          } else {
            // Some embedded engines report an error without following it with onend.
            this.clock.clearTimeout(this.watchdog);
            this.watchdog = this.clock.setTimeout(() => {
              if (!current()) return;
              this.generation++;
              this.instance = null;
              try { recognition.abort(); } catch (_) { /* Service already closed. */ }
              this.retry(error, this.clock.now() - began, gotResult);
            }, 1800);
          }
        };
        recognition.onend = () => {
          if (!current()) return;
          this.instance = null;
          this.clock.clearTimeout(this.watchdog);
          this.watchdog = 0;
          this.retry(error, this.clock.now() - began, gotResult);
        };
        this.watchdog = this.clock.setTimeout(() => {
          if (!current()) return;
          this.generation++;
          this.instance = null;
          try { recognition.abort(); } catch (_) { /* No functioning service. */ }
          this.retry('start-timeout', this.clock.now() - began, false);
        }, 10000);
        recognition.start();
      } catch (caught) {
        if (this.generation !== token || !this.want) return;
        this.instance = null;
        this.clock.clearTimeout(this.watchdog);
        const name = caught.name || 'start-failed';
        const fatal = ['NotAllowedError', 'SecurityError', 'NotFoundError'].includes(name);
        if (fatal) { this.blocked = true; this.options.onState?.('blocked', { error: name, fatal: true }); }
        else this.retry(name, 0, false);
      }
    }
    retry(error, duration, gotResult) {
      if (!this.want) return;
      const policy = core.retryDecision(this.attempts, error, duration, gotResult);
      this.attempts = policy.attempts;
      if (policy.blocked) {
        this.blocked = true;
        this.options.onState?.('blocked', { error, fatal: policy.fatal });
        return;
      }
      this.options.onState?.('recovering', { delay: policy.delay, error });
      this.clock.clearTimeout(this.timer);
      this.timer = this.clock.setTimeout(() => {
        this.timer = 0;
        if (this.want && !this.blocked) this.connect();
      }, policy.delay);
    }
  };
});
