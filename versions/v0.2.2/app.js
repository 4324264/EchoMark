(() => {
  const $ = (id) => document.getElementById(id);
  const state = { source: '', sourceMap: { normalized: '', positions: [], ends: [] }, name: '', documentKey: '', cursor: 0, recognition: null, recognitionSession: 0, startingRecognition: false, listening: false, fontSize: 16, permissionReady: false, progressTimer: 0, interimByResult: new Map(), interimTimers: new Map() };
  const content = $('document-content');
  let renderedNodes = null;
  let selectionTarget = null;
  const positionMenu = $('position-menu');
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
    stopListening();
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
    if (positionMenu && !positionMenu.classList.contains('hidden')) closePositionMenu();
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
    renderedNodes.tail.data = source.slice(state.cursor);
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
        } else if (move === 2) j--;
        else if (move === 3) i--;
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
        const sourceGap = previous[i] - 3;
        const spokenGap = current[i - 1] - 1;
        const at = ((column - 1) % chunkColumns) * rows + i;
        if (diagonal >= spokenGap && diagonal >= sourceGap) { current[i] = diagonal; traceChunk[at] = 1; }
        else if (sourceGap >= spokenGap) { current[i] = sourceGap; traceChunk[at] = 2; }
        else { current[i] = spokenGap; traceChunk[at] = 3; }
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

  function parseSpeechNumber(value) {
    const text = String(value).replace(/[,，\s]/g, '');
    if (/^\d+$/.test(text)) return Number(text);
    const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    let total = 0, section = 0, number = 0;
    for (const char of text) {
      if (char in digits) number = digits[char];
      else if (char === '十' || char === '百' || char === '千') {
        const unit = char === '十' ? 10 : char === '百' ? 100 : 1000;
        section += (number || 1) * unit;
        number = 0;
      } else return null;
    }
    return total + section + number;
  }

  function parseVoiceCommand(transcript) {
    const text = transcript.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
    const commands = [
      { action: 'fast-forward', pattern: /^(?:快进到|快进至|前进到|前进至|快进|前进)\s*(.*)$/ },
      { action: 'rewind', pattern: /^(?:撤回到|撤回至|退回到|退回至|倒回到|回退到|回退至|撤回|退回|倒回|回退)\s*(.*)$/ },
      { action: 'jump', pattern: /^(?:跳转到|跳转至|跳到|定位到|jump to|go to|skip to)\s*(.*)$/ },
      { action: 'rewind', pattern: /^(?:rewind to|go back to|back to)\s*(.*)$/ },
      { action: 'fast-forward', pattern: /^(?:fast forward to|move ahead to|advance to)\s*(.*)$/ }
    ];
    for (const command of commands) {
      const match = text.match(command.pattern);
      if (match) return { action: command.action, target: match[1].trim() };
    }
    return null;
  }

  function isVoiceCommandLead(transcript) {
    return /^(?:快进到|快进至|前进到|前进至|快进|前进|撤回到|撤回至|退回到|退回至|倒回到|回退到|回退至|撤回|退回|倒回|回退|跳转到|跳转至|跳到|定位到|jump to|go to|skip to|rewind to|go back to|back to|fast forward to|move ahead to|advance to)/i.test(transcript.trim());
  }

  function directCommandPosition(action, target) {
    const text = target.trim().toLocaleLowerCase();
    if (/^(?:开头|起点|最开始|从头|开始|start|the start|beginning)$/.test(text)) return 0;
    if (/^(?:结尾|末尾|终点|最后|结束|end|the end|finish)$/.test(text)) return state.source.length;

    const percentMatch = text.match(/(?:百分之\s*([\d零〇一二两三四五六七八九十百千]+)|([\d.]+)\s*(?:%|percent(?:age)?))/i);
    if (percentMatch) {
      const percent = parseSpeechNumber(percentMatch[1] || percentMatch[2]);
      if (percent !== null) return Math.round(state.source.length * Math.max(0, Math.min(100, percent)) / 100);
    }

    const ordinal = text.match(/第\s*([\d零〇一二两三四五六七八九十百千]+)\s*(?:个字|字|个字符|字符)/);
    const englishOrdinal = text.match(/(?:character|letter)\s*(\d+)/i);
    if (ordinal || englishOrdinal) {
      const number = parseSpeechNumber((ordinal || englishOrdinal)[1]);
      if (number !== null) return Math.max(0, Math.min(state.source.length, number - 1));
    }

    const relative = text.match(/^([\d零〇一二两三四五六七八九十百千]+)\s*(?:个字|字|个字符|字符|characters?|letters?)$/i);
    if (relative) {
      const number = parseSpeechNumber(relative[1]);
      if (number !== null) {
        const direction = action === 'rewind' ? -1 : action === 'fast-forward' ? 1 : 0;
        if (direction) return Math.max(0, Math.min(state.source.length, state.cursor + direction * number));
      }
    }
    return null;
  }

  function findCommandTarget(action, target) {
    const map = state.sourceMap;
    const phrase = cleanSpeech(target).slice(0, 160);
    if (phrase.length < 2 || !map.normalized) return null;
    let low = 0, high = map.positions.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (map.positions[mid] < state.cursor) low = mid + 1;
      else high = mid;
    }
    const cursorIndex = low;
    const maxWindow = Math.min(map.normalized.length, Math.max(1, Math.floor(map.normalized.length * 0.9)));
    const backAt = map.normalized.lastIndexOf(phrase, Math.max(0, cursorIndex - 1));
    const forwardAt = map.normalized.indexOf(phrase, cursorIndex);
    for (let limit = Math.min(100, maxWindow); limit <= maxWindow; limit = Math.min(limit + 100, maxWindow)) {
      const candidates = [];
      if (backAt >= 0) {
        const start = map.positions[backAt];
        const end = map.ends[backAt + phrase.length - 1];
        const distance = state.cursor - end;
        if (distance >= 0 && distance <= limit && action !== 'fast-forward') candidates.push({ at: backAt, start, end, distance });
      }
      if (forwardAt >= 0) {
        const start = map.positions[forwardAt];
        const end = map.ends[forwardAt + phrase.length - 1];
        const distance = start - state.cursor;
        if (distance >= 0 && distance <= limit && action !== 'rewind') candidates.push({ at: forwardAt, start, end, distance });
      }
      if (candidates.length) {
        candidates.sort((a, b) => a.distance - b.distance);
        const best = candidates[0];
        return action === 'fast-forward' ? best.end : best.start;
      }
      if (limit === maxWindow) break;
    }
    return null;
  }

  function applyVoiceCommand(transcript) {
    const command = parseVoiceCommand(transcript);
    if (!command) return false;
    if (!command.target) {
      $('recognized-text').textContent = '语音指令没有听清目标位置，请说“跳转到”后再读出文字或百分比。';
      return true;
    }
    let target = directCommandPosition(command.action, command.target);
    if (target === null) target = findCommandTarget(command.action, command.target);
    if (target === null) {
      $('recognized-text').textContent = `附近没有找到“${command.target}”，请多说几个目标字或指定百分比。`;
      return true;
    }
    if (command.action === 'rewind' && target >= state.cursor) {
      $('recognized-text').textContent = '目标位置在当前标记之后，无法撤回到那里。';
      return true;
    }
    if (command.action === 'fast-forward' && target <= state.cursor) {
      $('recognized-text').textContent = '目标位置没有超过当前标记。';
      return true;
    }
    state.cursor = target;
    $('recognized-text').textContent = `${command.action === 'rewind' ? '已撤回' : command.action === 'fast-forward' ? '已快进' : '已跳转'}到目标位置：${command.target}`;
    render();
    updateProgress();
    return true;
  }

  function selectionOffsets() {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount || !selection.toString().trim()) return null;
    const range = selection.getRangeAt(0);
    if (!content.contains(range.commonAncestorContainer)) return null;
    const prefix = range.cloneRange();
    prefix.selectNodeContents(content);
    prefix.setEnd(range.startContainer, range.startOffset);
    const start = prefix.toString().length;
    return { start, end: Math.min(state.source.length, start + range.toString().length), text: selection.toString().trim() };
  }

  function closePositionMenu() {
    positionMenu.classList.add('hidden');
    selectionTarget = null;
  }

  function showPositionMenu() {
    if (!state.source || !renderedNodes) return;
    const target = selectionOffsets();
    if (!target || target.end <= target.start) { closePositionMenu(); return; }
    const selection = window.getSelection();
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    selectionTarget = target;
    $('selection-preview').textContent = target.text.length > 42 ? `${target.text.slice(0, 42)}…` : target.text;
    positionMenu.classList.remove('hidden');
    const bounds = positionMenu.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - bounds.width - 8));
    const top = rect.bottom + bounds.height + 8 <= window.innerHeight ? rect.bottom + 8 : Math.max(8, rect.top - bounds.height - 8);
    positionMenu.style.left = `${left}px`;
    positionMenu.style.top = `${top}px`;
    positionMenu.querySelector('[data-position-action="rewind"]').disabled = target.start >= state.cursor;
    positionMenu.querySelector('[data-position-action="fast-forward"]').disabled = target.end <= state.cursor;
  }

  content.addEventListener('pointerup', () => { window.setTimeout(showPositionMenu, 0); });
  content.addEventListener('keyup', (event) => {
    if (event.shiftKey || event.key.startsWith('Arrow')) window.setTimeout(showPositionMenu, 0);
  });
  positionMenu.addEventListener('pointerdown', (event) => { if (event.target.closest('button')) event.preventDefault(); });
  positionMenu.addEventListener('click', (event) => {
    const button = event.target.closest('[data-position-action]');
    if (!button || !selectionTarget) return;
    const action = button.dataset.positionAction;
    const target = selectionTarget;
    if (action === 'cancel') { closePositionMenu(); return; }
    if (action === 'rewind' && target.start >= state.cursor) return;
    if (action === 'fast-forward' && target.end <= state.cursor) return;
    state.cursor = action === 'fast-forward' ? target.end : target.start;
    $('recognized-text').textContent = action === 'rewind' ? '已手动撤回到选区开头' : action === 'fast-forward' ? '已手动快进到选区末尾' : '已跳转到所选位置';
    closePositionMenu();
    render();
    updateProgress();
  });
  document.addEventListener('pointerdown', (event) => {
    if (!positionMenu.contains(event.target) && !content.contains(event.target)) closePositionMenu();
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closePositionMenu(); });
  $('document-wrap').addEventListener('scroll', closePositionMenu, { passive: true });
  window.addEventListener('resize', closePositionMenu);

  function clearRecognitionBuffers() {
    for (const timer of state.interimTimers.values()) clearTimeout(timer);
    state.interimTimers.clear();
    state.interimByResult.clear();
  }

  function stopListening() {
    state.recognitionSession++;
    state.startingRecognition = false;
    state.listening = false;
    const recognition = state.recognition;
    state.recognition = null;
    clearRecognitionBuffers();
    try { recognition?.stop(); } catch (_) { /* The session is already invalidated. */ }
    $('start-button').classList.remove('hidden');
    $('start-button').disabled = false;
    $('stop-button').classList.add('hidden');
    $('listening-badge').textContent = '监听已停止';
    $('listening-badge').classList.remove('active');
    $('recognition-led').classList.remove('active');
  }

  async function startListening() {
    if (!state.source) { $('status-text').textContent = '请先导入内容'; return; }
    if (!SpeechRecognition) {
      $('status-text').textContent = '当前浏览器不支持语音识别';
      $('recognized-text').textContent = '请使用支持 Web Speech API 的浏览器。抄写时自然读出即可，不需要跟读软件。';
      return;
    }
    if (state.startingRecognition || state.recognition || state.listening) return;

    const session = ++state.recognitionSession;
    state.startingRecognition = true;
    $('start-button').disabled = true;
    $('listening-badge').textContent = '正在连接麦克风';
    try {
      if (!state.permissionReady && navigator.mediaDevices?.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((track) => track.stop());
        state.permissionReady = true;
      }
      if (session !== state.recognitionSession) return;

      const recognition = new SpeechRecognition();
      const isCurrentSession = () => state.recognition === recognition && state.recognitionSession === session;
      clearRecognitionBuffers();
      state.recognition = recognition;
      state.startingRecognition = false;
      state.listening = true;
      recognition.lang = $('language-select').value;
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.onstart = () => {
        if (!isCurrentSession()) return;
        state.listening = true;
        $('start-button').classList.add('hidden');
        $('stop-button').classList.remove('hidden');
        $('listening-badge').textContent = '正在听取';
        $('listening-badge').classList.add('active');
        $('recognition-led').classList.add('active');
        updateProgress();
      };
      recognition.onresult = (event) => {
        if (!isCurrentSession()) return;
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          const transcript = result[0].transcript.trim();
          $('recognized-text').textContent = transcript;
          const prior = state.interimByResult.get(i) || '';
          const normalized = cleanSpeech(transcript);
          if (result.isFinal) {
            clearTimeout(state.interimTimers.get(i));
            if (applyVoiceCommand(transcript)) {
              state.interimByResult.delete(i);
              state.interimTimers.delete(i);
              continue;
            }
            const delta = normalized.startsWith(prior) ? normalized.slice(prior.length) : normalized;
            if (delta) acceptSpeech(delta);
            state.interimByResult.delete(i);
            state.interimTimers.delete(i);
          } else if (isVoiceCommandLead(transcript)) {
            clearTimeout(state.interimTimers.get(i));
            state.interimTimers.delete(i);
            state.interimByResult.set(i, normalized);
          } else if (normalized.length >= 2 && normalized !== prior && !prior.startsWith(normalized)) {
            clearTimeout(state.interimTimers.get(i));
            state.interimTimers.set(i, window.setTimeout(() => {
              if (!isCurrentSession()) return;
              const previous = state.interimByResult.get(i) || '';
              if (normalized.startsWith(previous)) {
                const delta = normalized.slice(previous.length);
                if (delta) acceptSpeech(delta);
                state.interimByResult.set(i, normalized);
              }
              state.interimTimers.delete(i);
            }, 220));
          }
        }
      };
      recognition.onerror = (event) => {
        if (!isCurrentSession()) return;
        $('recognized-text').textContent = event.error === 'not-allowed' ? '麦克风权限未开启，请在浏览器地址栏允许麦克风。' : `语音识别提示：${event.error}`;
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') state.listening = false;
      };
      recognition.onend = () => {
        if (!isCurrentSession()) return;
        state.listening = false;
        state.recognition = null;
        clearRecognitionBuffers();
        $('start-button').classList.remove('hidden');
        $('stop-button').classList.add('hidden');
        $('listening-badge').textContent = '识别已结束，可继续监听';
        $('listening-badge').classList.remove('active');
        $('recognition-led').classList.remove('active');
        updateProgress();
      };
      recognition.start();
    } catch (error) {
      if (session === state.recognitionSession) {
        state.listening = false;
        state.recognition = null;
        clearRecognitionBuffers();
        $('recognized-text').textContent = error.name === 'NotAllowedError' || error.name === 'SecurityError'
          ? '麦克风权限未开启。请在浏览器网站设置中允许麦克风，再点击一次“开始监听”。'
          : `无法开始语音识别：${error.message}`;
        $('listening-badge').textContent = '监听未启动';
        $('listening-badge').classList.remove('active');
        $('recognition-led').classList.remove('active');
        $('stop-button').classList.add('hidden');
        updateProgress();
      }
    } finally {
      if (session === state.recognitionSession) state.startingRecognition = false;
      if (session === state.recognitionSession) $('start-button').disabled = false;
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
    stopListening();
    updateProgress();
  });
  $('reset-button').addEventListener('click', () => {
    stopListening();
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
