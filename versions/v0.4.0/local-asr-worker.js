// Model files are fetched once and cached by Transformers.js. Audio stays in this worker.
let transcriber;
self.onmessage = async event => {
  const { type, audio, language, session } = event.data;
  try {
    if (type === 'init') {
      const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js');
      env.allowLocalModels = false;
      env.backends.onnx.wasm.numThreads = 1;
      transcriber = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-tiny', {
        device: 'wasm', dtype: 'q8', revision: 'ff4177021cc41f7db950912b73ea4fdf7d01d8e7',
        progress_callback: progress => self.postMessage({ type: 'progress', file: progress.file, progress: progress.progress })
      });
      self.postMessage({ type: 'ready' });
    } else if (type === 'transcribe' && transcriber) {
      const names = { zh: 'chinese', en: 'english', ja: 'japanese', ko: 'korean' };
      const result = await transcriber(audio, { language: names[language.split('-')[0]], task: 'transcribe', max_new_tokens: 96, repetition_penalty: 1.1 });
      self.postMessage({ type: 'result', text: result.text || '', session });
    }
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message, session });
  }
};
