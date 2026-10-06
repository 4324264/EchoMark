(() => {
  const $ = (id) => document.getElementById(id);
  const state = { source: '', sourceMap: { normalized: '', positions: [], ends: [] }, name: '', documentKey: '', cursor: 0, recognition: null, listening: false, fontSize: 16, permissionReady: false, progressTimer: 0, interimByResult: new Map(), interimTimers: new Map() };
  const content = $('document-content');
  let renderedNodes = null;
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  function applyAppearance() {
    const fields = {
      background: $('background-color'),
      highlight: $('highlight-color'),
      text: $('text-color')
    };
    try {
      const saved = JSON.parse(localStorage.getItem('echomark-appearance') || '{}');
      for (const [key, input] of Object.entries(fields)) {
        if (saved[key] && /^#[0-9a-f]{6}$/i.test(saved[key])) input.value = saved[key];
      }
    } catch (_) { /* Storage can be unavailable in restricted browser contexts. */ }
    const apply = () => {
      document.documentElement.style.setProperty('--user-background', fields.background.value);
      document.documentElement.style.setProperty('--user-highlight', fields.highlight.value);
      document.documentElement.style.setProperty('--user-text', fields.text.value);
      try {
        localStorage.setItem('echomark-appearance', JSON.stringify({
          background: fields.background.value,
          highlight: fields.highlight.value,
          text: fields.text.value
        }));
      } catch (_) { /* Current-session colors still work when storage is disabled. */ }
    };
    Object.values(fields).forEach((input) => input.addEventListener('input', apply));
    apply();
  }
  applyAppearance();

  function normalizedMap(text) {
    let normalized = '';
    const positions = [];
    const ends = [];
    for (let i = 0; i < text.length;) {
      const original = String.fromCodePoint(text.codePointAt(i));
      const originalEnd = i + original.length;
      const ch = original.toLocaleLowerCase();
      if (!/[\s\p{P}\p{S}]/u.test(ch)) {
        normalized += ch;
        for (let unit = 0; unit < ch.length; unit++) {
          positions.push(i);
          ends.push(originalEnd);
        }
      }
      i = originalEnd;
    }
    return { normalized, positions, ends };
  }

  function cleanSpeech(text) {
    return text.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
  }

  function progressKey(name, text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return `echomark-progress:${encodeURIComponent(name)}:${(hash >>> 0).toString(16)}`;
  }

  function setSource(text, name) {
    if (state.recognition) {
      state.listening = false;
      try { state.recognition.stop(); } catch (_) {}
      state.recognition = null;
    }
    for (const timer of state.interimTimers.values()) clearTimeout(timer);
    state.interimTimers.clear();
    state.interimByResult.clear();
    state.source = text.replace(/\r\n?/g, '\n');
    state.name = name || '未命名文档';
    state.sourceMap = normalizedMap(state.source);
    state.documentKey = progressKey(state.name, state.source);
    try {
      const savedCursor = Number(localStorage.getItem(state.documentKey));
      state.cursor = Number.isInteger(savedCursor) ? Math.max(0, Math.min(state.source.length, savedCursor)) : 0;
    } catch (_) { state.cursor = 0; }
    content.classList.remove('hidden');
    $('empty-state').classList.add('hidden');
    $('document-name').textContent = state.name;
    $('document-meta').textContent = `${state.source.length.toLocaleString()} 个字符 · 本地内容`;
    render();
    updateProgress();
  }

  function saveProgress() {
    if (!state.documentKey) return;
    clearTimeout(state.progressTimer);
    state.progressTimer = window.setTimeout(() => {
      try { localStorage.setItem(state.documentKey, String(state.cursor)); } catch (_) { /* Progress remains available for this session. */ }
    }, 180);
  }

  function render() {
    const source = state.source;
    if (!renderedNodes) {
      const mark = document.createElement('mark');
      const cursor = document.createElement('span');
      cursor.className = 'cursor-marker';
      cursor.setAttribute('aria-label', '当前位置');
      const tail = document.createTextNode('');
      content.replaceChildren(mark, cursor, tail);
      renderedNodes = { mark, cursor, tail };
    }
    renderedNodes.mark.textContent = source.slice(0, state.cursor);
    renderedNodes.tail.data = source.slice(state.cursor + 1);
    requestAnimationFrame(() => {
      const wrap = $('document-wrap');
      const top = renderedNodes.cursor.offsetTop;
      if (top > wrap.scrollTop + wrap.clientHeight * 0.72 || top < wrap.scrollTop) {
        wrap.scrollTo({ top: Math.max(0, top - wrap.clientHeight * 0.36), behavior: 'smooth' });
      }
    });
  }

  function updateProgress() {
    const total = state.source.length;
    const percent = total ? Math.min(100, Math.round((state.cursor / total) * 100)) : 0;
    $('progress-fill').style.width = `${percent}%`;
    $('progress-caret').style.left = `calc(${percent}% - 4px)`;
    $('progress-percent').textContent = `${percent}%`;
    $('progress-count').textContent = `${state.cursor.toLocaleString()} / ${total.toLocaleString()} 字`;
    $('read-time').textContent = `约 ${Math.max(1, Math.ceil((total - state.cursor) / 350))} 分钟`;
    $('status-text').textContent = state.listening ? '正在听取自然朗读' : (percent === 100 ? '本次内容已标记完成' : state.cursor ? '标记已暂停' : '等待开始');
    saveProgress();
  }

  function alignSpeech(spoken) {
    const map = state.sourceMap;
    const phrase = cleanSpeech(spoken).slice(0, 160);
    if (!phrase) return null;
    // Locate the next unread normalized character in logarithmic time.
    let low = 0, high = map.positions.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (map.positions[mid] < state.cursor) low = mid + 1;
      else high = mid;
    }
    const cursorIndex = low;
    const remaining = map.normalized.length - cursorIndex;
    const maxWindow = Math.min(remaining, Math.max(1, Math.floor(map.normalized.length * 0.9)));
    if (!maxWindow) return null;

    // Exact spoken runs are common. Resolve them in one native string search
    // instead of allocating and filling the fuzzy-alignment traceback table.
    if (phrase.length >= 4) {
      const exactAt = map.normalized.indexOf(phrase, cursorIndex);
      for (let searchLimit = Math.min(100, maxWindow); searchLimit <= maxWindow; searchLimit = Math.min(searchLimit + 100, maxWindow)) {
        if (exactAt >= 0 && exactAt + phrase.length <= cursorIndex + searchLimit) {
          const endOffset = map.ends[exactAt + phrase.length - 1];
          return endOffset;
        }
        if (searchLimit === maxWindow) break;
      }
    }

    // A one-character utterance is only trusted inside a very small window from the last
    // confirmed position. For longer speech, semi-global alignment permits nearby omissions
    // in the source while preserving the recognized character order.
    if (phrase.length === 1) {
      const sourceStart = map.normalized.slice(cursorIndex, cursorIndex + Math.min(8, maxWindow));
      const at = sourceStart.indexOf(phrase);
      if (at < 0) return null;
      return map.ends[cursorIndex + at];
    }

    const n = phrase.length;
    const minMatches = n <= 3 ? n : Math.max(2, Math.ceil(n * 0.42));
    const rows = n + 1;
    let previous = new Int16Array(rows);
    let current = new Int16Array(rows);
    const traces = [];
    for (let i = 1; i <= n; i++) previous[i] = -3 * i;
    let bestScore = -32768, bestEnd = 0;
    const chunkColumns = 100;
    const backtrack = () => {
      let i = n, j = bestEnd, matchedCount = 0;
      while (i > 0 && j >= 0) {
        const move = j === 0 ? 2 : traces[Math.floor((j - 1) / chunkColumns)][((j - 1) % chunkColumns) * rows + i];
        if (move === 1) {
          const spokenChar = phrase[i - 1];
          const sourceChar = map.normalized[cursorIndex + j - 1];
          if (spokenChar === sourceChar) matchedCount++;
          i--; j--;
        } else if (move === 2) i--;
        else if (move === 3) j--;
        else break;
      }
      if (matchedCount < minMatches || bestEnd <= 0) return null;
      const toIndex = cursorIndex + bestEnd - 1;
      const to = map.ends[toIndex] ?? state.cursor;
      return to > state.cursor ? to : null;
    };

    // Extend the semi-global alignment one source character at a time. Check
    // after each 100-character block, so long omissions do not trigger a full
    // dynamic-programming recalculation for every wider window.
    let traceChunk = null;
    for (let column = 1; column <= maxWindow; column++) {
      if ((column - 1) % chunkColumns === 0) {
        traceChunk = new Uint8Array(chunkColumns * rows);
        traces.push(traceChunk);
      }
      current[0] = 0; // The phrase may begin anywhere in the forward window.
      const sourceChar = map.normalized[cursorIndex + column - 1];
      for (let i = 1; i <= n; i++) {
        const diagonal = previous[i - 1] + (phrase[i - 1] === sourceChar ? 3 : -2);
        const spokenGap = previous[i] - 3;
        const sourceGap = current[i - 1] - 1;
        const at = ((column - 1) % chunkColumns) * rows + i;
        if (diagonal >= spokenGap && diagonal >= sourceGap) { current[i] = diagonal; traceChunk[at] = 1; }
        else if (spokenGap >= sourceGap) { current[i] = spokenGap; traceChunk[at] = 2; }
        else { current[i] = sourceGap; traceChunk[at] = 3; }
      }
      if (current[n] > bestScore) { bestScore = current[n]; bestEnd = column; }
      const priorColumn = previous;
      previous = current;
      current = priorColumn;
      if (column % chunkColumns === 0 || column === maxWindow) {
        const match = backtrack();
        if (match) return match;
      }
    }
    return null;
  }

  function acceptSpeech(text) {
    const match = alignSpeech(text);
    $('recognized-text').textContent = text;
    if (!match) return;
    state.cursor = match;
    render();
    updateProgress();
  }

  async function startListening() {
    if (!state.source) { $('status-text').textContent = '请先导入内容'; return; }
    if (!SpeechRecognition) {
      $('status-text').textContent = '当前浏览器不支持语音识别';
      $('recognized-text').textContent = '请使用支持 Web Speech API 的浏览器。抄写时自然读出即可，不需要跟读软件。';
      return;
    }
    if (!state.permissionReady && navigator.mediaDevices?.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((track) => track.stop());
        state.permissionReady = true;
      } catch (_) {
        $('recognized-text').textContent = '麦克风权限未开启。请在浏览器网站设置中允许麦克风，再点击一次“开始监听”。';
        $('listening-badge').textContent = '需要麦克风权限';
        return;
      }
    }
    if (state.recognition) state.recognition.stop();
    const recognition = new SpeechRecognition();
    for (const timer of state.interimTimers.values()) clearTimeout(timer);
    state.interimTimers.clear();
    state.interimByResult.clear();
    state.listening = true;
    recognition.lang = $('language-select').value;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onstart = () => {
      state.listening = true;
      $('start-button').classList.add('hidden');
      $('stop-button').classList.remove('hidden');
      $('listening-badge').textContent = '正在听取';
      $('listening-badge').classList.add('active');
      $('recognition-led').classList.add('active');
      updateProgress();
    };
    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0].transcript.trim();
        $('recognized-text').textContent = transcript;
        const prior = state.interimByResult.get(i) || '';
        const normalized = cleanSpeech(transcript);
        if (result.isFinal) {
          clearTimeout(state.interimTimers.get(i));
          const delta = normalized.startsWith(prior) ? normalized.slice(prior.length) : normalized;
          if (delta.trim()) acceptSpeech(delta);
          state.interimByResult.delete(i);
          state.interimTimers.delete(i);
        } else if (normalized.length >= 2 && normalized !== prior && !prior.startsWith(normalized)) {
          clearTimeout(state.interimTimers.get(i));
          state.interimTimers.set(i, window.setTimeout(() => {
            const previous = state.interimByResult.get(i) || '';
            if (normalized.startsWith(previous)) {
              const delta = normalized.slice(previous.length);
              if (delta.trim()) acceptSpeech(delta);
              state.interimByResult.set(i, normalized);
            }
          }, 220));
        }
      }
    };
    recognition.onerror = (event) => {
      if (state.recognition !== recognition) return;
      $('recognized-text').textContent = event.error === 'not-allowed' ? '麦克风权限未开启，请在浏览器地址栏允许麦克风。' : `语音识别提示：${event.error}`;
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') state.listening = false;
    };
    recognition.onend = () => {
      if (state.recognition !== recognition) return;
      state.listening = false;
      $('start-button').classList.remove('hidden');
      $('stop-button').classList.add('hidden');
      $('listening-badge').textContent = '识别已结束，可继续监听';
      $('listening-badge').classList.remove('active');
      $('recognition-led').classList.remove('active');
      for (const timer of state.interimTimers.values()) clearTimeout(timer);
      state.interimTimers.clear();
      state.interimByResult.clear();
      state.recognition = null;
      updateProgress();
    };
    state.recognition = recognition;
    try {
      recognition.start();
    } catch (error) {
      state.listening = false;
      state.recognition = null;
      $('recognized-text').textContent = `无法开始语音识别：${error.message}`;
      updateProgress();
    }
  }

  async function readDocx(file) {
    if (!('DecompressionStream' in window)) throw new Error('当前浏览器无法解压 DOCX，请使用较新的浏览器或另存为 TXT。');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('无法识别此 DOCX 文件。');
    const count = view.getUint16(eocd + 10, true);
    let entry = view.getUint32(eocd + 16, true);
    let xmlBytes = null;
    for (let i = 0; i < count; i++) {
      if (view.getUint32(entry, true) !== 0x02014b50) break;
      const method = view.getUint16(entry + 10, true);
      const size = view.getUint32(entry + 20, true);
      const nameLength = view.getUint16(entry + 28, true);
      const extraLength = view.getUint16(entry + 30, true);
      const commentLength = view.getUint16(entry + 32, true);
      const localOffset = view.getUint32(entry + 42, true);
      const name = new TextDecoder().decode(bytes.slice(entry + 46, entry + 46 + nameLength));
      if (name === 'word/document.xml') {
        const localNameLength = view.getUint16(localOffset + 26, true);
        const localExtraLength = view.getUint16(localOffset + 28, true);
        const start = localOffset + 30 + localNameLength + localExtraLength;
        const compressed = bytes.slice(start, start + size);
        if (method === 0) xmlBytes = compressed;
        else if (method === 8) {
          const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
          xmlBytes = new Uint8Array(await new Response(stream).arrayBuffer());
        } else throw new Error('此 DOCX 使用了不支持的压缩方式。');
        break;
      }
      entry += 46 + nameLength + extraLength + commentLength;
    }
    if (!xmlBytes) throw new Error('DOCX 中没有找到正文。');
    const xml = new DOMParser().parseFromString(new TextDecoder().decode(xmlBytes), 'application/xml');
    if (xml.querySelector('parsererror')) throw new Error('DOCX 正文解析失败。');
    return [...xml.getElementsByTagNameNS('*', 'p')].map((p) => {
      let text = '';
      for (const node of p.getElementsByTagName('*')) {
        if (node.localName === 't') text += node.textContent || '';
        else if (node.localName === 'tab') text += '\t';
        else if (node.localName === 'br' || node.localName === 'cr') text += '\n';
      }
      return text;
    }).join('\n');
  }

  async function readPdf(file) {
    const version = '6.3.289';
    const baseUrl = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${version}/build/`;
    let pdfjs;
    try { pdfjs = await import(`${baseUrl}pdf.mjs`); }
    catch (_) { throw new Error('无法载入 PDF 阅读组件。请检查网络连接后重试，或将 PDF 另存为 DOCX/TXT。'); }
    pdfjs.GlobalWorkerOptions.workerSrc = `${baseUrl}pdf.worker.mjs`;
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false, enableXfa: false }).promise;
    const pages = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const textContent = await page.getTextContent();
      let line = '';
      for (const item of textContent.items) {
        if (!('str' in item)) continue;
        line += item.str;
        if (item.hasEOL) { pages.push(line); line = ''; }
        else if (item.str && !/\s$/.test(item.str)) line += ' ';
      }
      if (line.trim()) pages.push(line.trimEnd());
      if (number < pdf.numPages) pages.push('');
    }
    const text = pages.join('\n').trim();
    if (!text) throw new Error('PDF 中没有可提取的文字。扫描件需要先进行 OCR，再导入文本。');
    return text;
  }

  $('file-input').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (/\.docx$/i.test(file.name)) setSource(await readDocx(file), file.name);
      else if (/\.pdf$/i.test(file.name)) setSource(await readPdf(file), file.name);
      else if (/\.html?$/i.test(file.name)) {
        const doc = new DOMParser().parseFromString(await file.text(), 'text/html');
        doc.querySelectorAll('script,style,noscript,template').forEach((node) => node.remove());
        setSource(doc.body.innerText || doc.body.textContent || '', file.name);
      } else setSource(await file.text(), file.name);
    } catch (error) {
      $('status-text').textContent = '导入失败';
      $('recognized-text').textContent = error.message;
    } finally {
      event.target.value = '';
    }
  });
  $('paste-toggle').addEventListener('click', () => $('paste-area').classList.toggle('hidden'));
  $('load-text').addEventListener('click', () => {
    const text = $('paste-input').value.trim();
    if (text) setSource(text, '粘贴的文本');
  });
  $('start-button').addEventListener('click', startListening);
  $('stop-button').addEventListener('click', () => {
    state.listening = false;
    state.recognition?.stop();
  });
  $('reset-button').addEventListener('click', () => {
    state.listening = false;
    if (state.recognition) state.recognition.stop();
    state.cursor = 0;
    $('recognized-text').textContent = '阅读位置已重置';
    render();
    updateProgress();
  });
  $('font-button').addEventListener('click', () => {
    state.fontSize = state.fontSize >= 20 ? 14 : state.fontSize + 2;
    content.style.fontSize = `${state.fontSize}px`;
  });

  window.addEventListener('pagehide', () => {
    clearTimeout(state.progressTimer);
    if (state.documentKey) {
      try { localStorage.setItem(state.documentKey, String(state.cursor)); } catch (_) { /* Progress remains available for this session. */ }
    }
  });

})();
