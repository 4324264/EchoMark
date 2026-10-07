(() => {
  const $ = (id) => document.getElementById(id);
  const state = { source: '', sourceMap: { normalized: '', positions: [], ends: [] }, progressPositions: [], name: '', documentKey: '', cursor: 0, layout: null, layoutLeaves: [], layoutMarker: null, layoutBuilt: false, renderedCursor: 0, recognition: null, recognitionSession: 0, startingRecognition: false, wantListening: false, restartTimer: 0, restartAttempts: 0, lastRecognitionError: '', pendingVoiceCommand: null, pendingCommandTimer: 0, listening: false, fontSize: 16, microphoneStream: null, progressTimer: 0, speedTracker: { activeMs: 0, startedAt: 0, copiedChars: 0, estimate: 350 }, interimByResult: new Map(), interimTimers: new Map() };
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

  function progressPositions(text) {
    const positions = [];
    for (let i = 0; i < text.length;) {
      const point = String.fromCodePoint(text.codePointAt(i));
      if (!/\s/u.test(point)) positions.push(i);
      i += point.length;
    }
    return positions;
  }

  function progressCountAt(cursor) {
    const positions = state.progressPositions;
    let low = 0, high = positions.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (positions[mid] < cursor) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  function cleanSpeech(text) {
    return text.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
  }

  function progressKey(name, text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return `echomark-progress:${encodeURIComponent(name)}:${(hash >>> 0).toString(16)}`;
  }

  function setSource(text, name, layout = null) {
    stopListening();
    state.source = text.replace(/\r\n?/g, '\n');
    state.name = name || '未命名文档';
    state.layout = layout;
    state.layoutLeaves = [];
    state.layoutMarker = null;
    state.layoutBuilt = false;
    state.renderedCursor = 0;
    renderedNodes = null;
    content.replaceChildren();
    state.sourceMap = normalizedMap(state.source);
    state.progressPositions = progressPositions(state.source);
    state.documentKey = progressKey(state.name, state.source);
    state.speedTracker = loadSpeedTracker(state.documentKey);
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

  function speedStorageKey(key) { return `echomark-speed:${key}`; }

  function loadSpeedTracker(key) {
    const fallback = { activeMs: 0, startedAt: 0, copiedChars: 0, estimate: 350 };
    try {
      const saved = JSON.parse(localStorage.getItem(speedStorageKey(key)) || 'null');
      if (!saved || !Number.isFinite(saved.estimate)) return fallback;
      return {
        activeMs: Math.max(0, Number(saved.elapsedMs) || 0),
        startedAt: 0,
        copiedChars: Math.max(0, Number(saved.copiedChars) || 0),
        estimate: Math.max(30, Math.min(1800, Math.round(saved.estimate)))
      };
    } catch (_) { return fallback; }
  }

  function persistSpeedTracker() {
    if (!state.documentKey) return;
    const tracker = state.speedTracker;
    const elapsedMs = tracker.activeMs + (tracker.startedAt ? Math.max(0, Date.now() - tracker.startedAt) : 0);
    try {
      localStorage.setItem(speedStorageKey(state.documentKey), JSON.stringify({ elapsedMs, copiedChars: tracker.copiedChars, estimate: tracker.estimate }));
    } catch (_) { /* The current page still keeps the calculated rate in memory. */ }
  }

  function refreshTimeEstimate() {
    const tracker = state.speedTracker;
    const elapsedMs = tracker.activeMs + (tracker.startedAt ? Math.max(0, Date.now() - tracker.startedAt) : 0);
    if (tracker.copiedChars < 20 || elapsedMs < 15_000) {
      $('recognized-text').textContent = '继续监听并推进一些文字后，再刷新剩余时间会更准确。';
      return;
    }
    tracker.estimate = Math.max(30, Math.min(1800, Math.round(tracker.copiedChars / (elapsedMs / 60_000))));
    persistSpeedTracker();
    $('recognized-text').textContent = `已按约 ${tracker.estimate} 字/分钟更新剩余时间`;
    updateProgress();
  }

  function render() {
    if (positionMenu && !positionMenu.classList.contains('hidden')) closePositionMenu();
    const source = state.source;
    if (state.layout) {
      renderLayout();
      return;
    }
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
    scrollMarkerIntoView(renderedNodes.cursor);
  }

  function scrollMarkerIntoView(marker) {
    if (!marker) return;
    requestAnimationFrame(() => {
      const wrap = $('document-wrap');
      const top = marker.getBoundingClientRect().top - wrap.getBoundingClientRect().top + wrap.scrollTop;
      if (top > wrap.scrollTop + wrap.clientHeight * 0.72 || top < wrap.scrollTop) {
        wrap.scrollTo({ top: Math.max(0, top - wrap.clientHeight * 0.36), behavior: 'smooth' });
      }
    });
  }

  function createLayoutDom(node, parent) {
    if (node.type === 'text') {
      const element = document.createElement('span');
      element.className = node.separator ? 'layout-separator' : 'layout-run';
      element.textContent = node.value;
      parent.appendChild(element);
      const leaf = { ...node, element };
      state.layoutLeaves.push(leaf);
      return;
    }
    const element = document.createElement(node.tag);
    if (node.className) element.className = node.className;
    for (const [name, value] of Object.entries(node.attrs || {})) element.setAttribute(name, value);
    for (const [property, value] of Object.entries(node.style || {})) element.style.setProperty(property, value);
    parent.appendChild(element);
    for (const child of node.children || []) createLayoutDom(child, element);
  }

  function renderLayoutLeaf(leaf, cursor, anchor) {
    if (leaf.separator) return;
    const readLength = Math.max(0, Math.min(leaf.value.length, cursor - leaf.start));
    const mark = document.createElement('mark');
    const marker = document.createElement('span');
    marker.className = 'cursor-marker';
    marker.setAttribute('aria-label', '当前位置');
    marker.setAttribute('aria-hidden', 'true');
    const parts = [];
    if (readLength) {
      mark.textContent = leaf.value.slice(0, readLength);
      parts.push(mark);
    }
    if (leaf === anchor.leaf) {
      const position = Math.max(0, Math.min(leaf.value.length, anchor.position));
      if (position < readLength) {
        mark.textContent = leaf.value.slice(0, position);
        const remainder = document.createElement('mark');
        remainder.textContent = leaf.value.slice(position, readLength);
        parts.push(marker, remainder);
      } else {
        parts.push(marker);
      }
      state.layoutMarker = marker;
    }
    const tail = leaf.value.slice(readLength);
    if (tail) parts.push(document.createTextNode(tail));
    leaf.element.replaceChildren(...parts);
  }

  function findLayoutAnchor(cursor) {
    let previous = null;
    for (const leaf of state.layoutLeaves) {
      if (leaf.separator) continue;
      if (cursor >= leaf.start && cursor <= leaf.end) return { leaf, position: cursor - leaf.start };
      if (leaf.start > cursor) return { leaf, position: 0 };
      previous = leaf;
    }
    return previous ? { leaf: previous, position: previous.end - previous.start } : null;
  }

  function renderLayout() {
    if (!state.layoutBuilt) {
      content.replaceChildren();
      state.layoutLeaves = [];
      state.layoutMarker = null;
      createLayoutDom(state.layout, content);
      const anchor = findLayoutAnchor(state.cursor);
      for (const leaf of state.layoutLeaves) renderLayoutLeaf(leaf, state.cursor, anchor);
      state.layoutBuilt = true;
      state.renderedCursor = state.cursor;
      scrollMarkerIntoView(state.layoutMarker);
      return;
    }
    if (state.cursor === state.renderedCursor) return;
    const oldAnchor = findLayoutAnchor(state.renderedCursor);
    const newAnchor = findLayoutAnchor(state.cursor);
    const low = Math.min(state.cursor, state.renderedCursor);
    const high = Math.max(state.cursor, state.renderedCursor);
    let first = state.layoutLeaves.findIndex((leaf) => leaf.end >= low);
    if (first < 0) first = state.layoutLeaves.length - 1;
    let last = first;
    while (last + 1 < state.layoutLeaves.length && state.layoutLeaves[last + 1].start <= high) last++;
    for (const anchor of [oldAnchor, newAnchor]) {
      if (!anchor) continue;
      const index = state.layoutLeaves.indexOf(anchor.leaf);
      first = Math.min(first, index);
      last = Math.max(last, index);
    }
    state.layoutMarker = null;
    for (let i = first; i <= last; i++) renderLayoutLeaf(state.layoutLeaves[i], state.cursor, newAnchor);
    state.renderedCursor = state.cursor;
    scrollMarkerIntoView(state.layoutMarker);
  }

  function layoutContext() { return { text: '' }; }
  function layoutElement(tag, children = [], attrs = {}, style = {}, className = '') {
    return { type: 'element', tag, children, attrs, style, className };
  }
  function layoutText(ctx, value, separator = false) {
    const text = String(value || '').replace(/\r\n?/g, '\n');
    if (!text) return null;
    const start = ctx.text.length;
    ctx.text += text;
    return { type: 'text', value: text, start, end: ctx.text.length, separator };
  }
  function layoutBoundary(ctx, children, value = '\n') {
    if (!ctx.text || ctx.text.endsWith(value)) return;
    const node = layoutText(ctx, value, true);
    if (node) children.push(node);
  }
  function finalizeLayout(ctx, model) {
    const end = ctx.text.length - ctx.text.trimEnd().length;
    const finalLength = ctx.text.length - end;
    function trim(node) {
      if (node.type === 'text') {
        if (node.start >= finalLength) return null;
        if (node.end > finalLength) {
          node.value = node.value.slice(0, finalLength - node.start);
          node.end = finalLength;
        }
        return node.value ? node : null;
      }
      node.children = (node.children || []).map(trim).filter(Boolean);
      return node;
    }
    ctx.text = ctx.text.slice(0, finalLength);
    return { text: ctx.text, model: trim(model) || model };
  }
  function safeStyle(style) {
    const allowed = new Set(['color', 'background-color', 'font-size', 'font-weight', 'font-style', 'text-decoration', 'text-align', 'vertical-align', 'line-height', 'margin', 'margin-top', 'margin-bottom', 'padding', 'padding-left', 'padding-right', 'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'width', 'min-width', 'max-width', 'white-space']);
    const clean = {};
    for (const [key, value] of Object.entries(style || {})) {
      const property = key.toLowerCase();
      const text = String(value).trim();
      if (!allowed.has(property) || /url\s*\(|var\s*\(|expression|javascript:/i.test(text)) continue;
      if (property === 'font-size') {
        const match = text.match(/^(\d+(?:\.\d+)?)(px|pt|em|rem|%)$/i);
        if (!match) continue;
        const number = Number(match[1]);
        clean[property] = `${Math.max(8, Math.min(48, number * (match[2].toLowerCase() === 'pt' ? 1.333 : 1)))}px`;
      } else if (property === 'color' || property === 'background-color') {
        if (CSS.supports(property, text)) clean[property] = text;
      } else if (/^[\w\s#.,%()/-]{1,80}$/.test(text)) clean[property] = text;
    }
    return clean;
  }
  const layoutBlocks = new Set(['p','div','section','article','h1','h2','h3','h4','h5','h6','ul','ol','li','table','blockquote','pre','hr']);

  function htmlToLayout(doc) {
    const ctx = layoutContext();
    const allowed = new Set(['p','div','section','article','span','strong','b','em','i','u','s','del','ul','ol','li','table','thead','tbody','tfoot','tr','th','td','blockquote','pre','code','a','br','hr','h1','h2','h3','h4','h5','h6']);
    const styleSheets = [...doc.querySelectorAll('style')].slice(0, 20);
    for (const sheet of styleSheets) {
      const rules = [...(sheet.textContent || '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].slice(0, 300);
      for (const [, selectorText, declarations] of rules) {
        if (selectorText.trim().startsWith('@')) continue;
        const parsed = {};
        for (const declaration of declarations.split(';')) {
          const colon = declaration.indexOf(':');
          if (colon > 0) parsed[declaration.slice(0, colon).trim().toLowerCase()] = declaration.slice(colon + 1).trim();
        }
        const style = safeStyle(parsed);
        if (!Object.keys(style).length) continue;
        for (const selector of selectorText.split(',').map((value) => value.trim()).filter((value) => value.length < 160 && !/[<>]/.test(value))) {
          try { doc.querySelectorAll(selector).forEach((element) => Object.entries(style).forEach(([key, value]) => element.style.setProperty(key, value))); } catch (_) { /* Ignore unsupported selectors from imported documents. */ }
        }
      }
    }
    function convert(source, parentChildren) {
      if (source.nodeType === Node.TEXT_NODE) {
        const leaf = layoutText(ctx, source.nodeValue);
        if (leaf) parentChildren.push(leaf);
        return;
      }
      if (source.nodeType !== Node.ELEMENT_NODE) return;
      const tag = source.localName.toLowerCase();
      if (!allowed.has(tag)) return;
      if (source.parentElement?.localName === 'tr' && ['td','th'].includes(tag) && parentChildren.length) layoutBoundary(ctx, parentChildren, '\t');
      else if (tag === 'tr' && parentChildren.length) layoutBoundary(ctx, parentChildren);
      else if (layoutBlocks.has(tag) && parentChildren.length) layoutBoundary(ctx, parentChildren);
      if (tag === 'br' || tag === 'hr') {
        const leaf = layoutText(ctx, '\n', true);
        if (leaf) parentChildren.push(leaf);
        return;
      }
      const attrs = {};
      for (const name of ['colspan','rowspan','start']) {
        const value = source.getAttribute(name);
        if (value && /^\d{1,3}$/.test(value)) attrs[name] = String(Math.min(100, Number(value)));
      }
      const childList = [];
      const node = layoutElement(tag, childList, attrs, safeStyle(Object.fromEntries([...source.style].map((key) => [key, source.style.getPropertyValue(key)]))));
      parentChildren.push(node);
      for (const child of source.childNodes) convert(child, childList);
      if (layoutBlocks.has(tag) && ctx.text && !ctx.text.endsWith('\n')) {
        const leaf = layoutText(ctx, '\n', true);
        if (leaf) childList.push(leaf);
      }
    }
    const rootChildren = [];
    for (const child of doc.body.childNodes) convert(child, rootChildren);
    return finalizeLayout(ctx, layoutElement('div', rootChildren, {}, {}, 'imported-document'));
  }

  function markdownToLayout(markdown) {
    const ctx = layoutContext();
    const children = [];
    const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
    const inline = (value, into) => {
      const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
      let last = 0;
      for (const match of value.matchAll(pattern)) {
        const start = match.index;
        if (start > last) { const leaf = layoutText(ctx, value.slice(last, start)); if (leaf) into.push(leaf); }
        const token = match[0];
        const tag = token.startsWith('**') ? 'strong' : token.startsWith('*') ? 'em' : token.startsWith('`') ? 'code' : 'span';
        const text = tag === 'span' ? token.slice(1, token.indexOf('](')) : token.slice(tag === 'strong' ? 2 : 1, tag === 'strong' ? -2 : -1);
        const leaf = layoutText(ctx, text);
        into.push(layoutElement(tag, leaf ? [leaf] : []));
        last = start + token.length;
      }
      if (last < value.length) { const leaf = layoutText(ctx, value.slice(last)); if (leaf) into.push(leaf); }
    };
    for (let i = 0; i < lines.length;) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      if (/^```/.test(line)) {
        const code = []; i++;
        while (i < lines.length && !/^```/.test(lines[i])) { const leaf = layoutText(ctx, `${lines[i]}${i < lines.length - 1 ? '\n' : ''}`); if (leaf) code.push(leaf); i++; }
        i++;
        layoutBoundary(ctx, children);
        children.push(layoutElement('pre', [layoutElement('code', code)]));
        layoutBoundary(ctx, children);
        continue;
      }
      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      const list = line.match(/^\s*([-*+]\s+|\d+[.)]\s+)(.+)$/);
      if (heading) {
        layoutBoundary(ctx, children);
        const inner = []; inline(heading[2], inner);
        children.push(layoutElement(`h${heading[1].length}`, inner));
        layoutBoundary(ctx, children);
        i++; continue;
      }
      if (list) {
        const ordered = /^\s*\d/.test(line);
        const tag = ordered ? 'ol' : 'ul';
        const items = [];
        while (i < lines.length) {
          const current = lines[i].match(/^\s*([-*+]\s+|\d+[.)]\s+)(.+)$/);
          if (!current || /^\s*\d/.test(lines[i]) !== ordered) break;
          const inner = []; inline(current[2], inner); items.push(layoutElement('li', inner)); i++;
          if (i < lines.length && lines[i].trim()) { const br = layoutText(ctx, '\n', true); if (br) items.push(br); }
        }
        layoutBoundary(ctx, children); children.push(layoutElement(tag, items)); layoutBoundary(ctx, children); continue;
      }
      if (/^>\s?/.test(line)) {
        layoutBoundary(ctx, children);
        const quote = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) { const inner = []; inline(lines[i].replace(/^>\s?/, ''), inner); quote.push(layoutElement('p', inner)); i++; }
        children.push(layoutElement('blockquote', quote)); layoutBoundary(ctx, children); continue;
      }
      layoutBoundary(ctx, children);
      const para = []; let first = true;
      while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>\s?|\s*([-*+]\s+|\d+[.)]\s+))/.test(lines[i])) {
        if (!first) { const space = layoutText(ctx, ' '); if (space) para.push(space); }
        inline(lines[i], para); first = false; i++;
      }
      children.push(layoutElement('p', para)); layoutBoundary(ctx, children);
    }
    return finalizeLayout(ctx, layoutElement('div', children, {}, {}, 'imported-document'));
  }

  function updateProgress() {
    const total = state.progressPositions.length;
    const current = progressCountAt(state.cursor);
    const percent = total ? Math.min(100, Math.round((current / total) * 100)) : 0;
    $('progress-fill').style.width = `${percent}%`;
    $('progress-caret').style.left = `calc(${percent}% - 4px)`;
    $('progress-percent').textContent = `${percent}%`;
    $('progress-count').textContent = `${current.toLocaleString()} / ${total.toLocaleString()} 字`;
    $('read-time').textContent = `约 ${Math.max(1, Math.ceil((total - current) / state.speedTracker.estimate))} 分钟`;
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
    if (state.wantListening && match > state.cursor) {
      state.speedTracker.copiedChars += progressCountAt(match) - progressCountAt(state.cursor);
      persistSpeedTracker();
    }
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
    const text = String(transcript).trim().toLocaleLowerCase()
      .replace(/^[\s，,。.!！？、嗯呃啊哦]+/u, '')
      .replace(/[，,。.!！？、]+/gu, ' ')
      .replace(/\s+/g, ' ');
    const commands = [
      { action: 'fast-forward', pattern: /^(?:快进到|快进至|前进到|前进至|向前到|前移到|前移至|快进|前进)\s*(.*)$/ },
      { action: 'rewind', pattern: /^(?:撤回到|撤回至|退回到|退回至|倒回到|回退到|回退至|回到|返回到|撤回|退回|倒回|回退)\s*(.*)$/ },
      { action: 'jump', pattern: /^(?:跳转到|跳转至|跳到|跳至|定位到|定位至|移到|移至|jump to|go to|skip to)\s*(.*)$/ },
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
    return Boolean(parseVoiceCommand(transcript));
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

  function clearPendingVoiceCommand() {
    clearTimeout(state.pendingCommandTimer);
    state.pendingCommandTimer = 0;
    state.pendingVoiceCommand = null;
  }

  function keepPendingVoiceCommand(action, target) {
    clearTimeout(state.pendingCommandTimer);
    state.pendingVoiceCommand = { action, target };
    $('recognized-text').textContent = target
      ? `正在寻找目标“${target.slice(-36)}”…继续读出目标文字或位置。`
      : '已识别位置指令，请继续说目标文字、字数或百分比。';
    state.pendingCommandTimer = window.setTimeout(() => {
      const pending = state.pendingVoiceCommand;
      if (!pending) return;
      state.pendingVoiceCommand = null;
      state.pendingCommandTimer = 0;
      $('recognized-text').textContent = pending.target
        ? `附近没有找到“${pending.target.slice(-36)}”，请读出更多目标文字或指定百分比。`
        : '没有听到位置指令的目标。请重新说“跳转到”并接上目标文字或位置。';
    }, 8000);
  }

  function applyCommandTarget(action, targetText) {
    const target = targetText.trim();
    if (!target) return 'pending';
    let position = directCommandPosition(action, target);
    if (position === null) position = findCommandTarget(action, target);
    if (position === null) return 'pending';
    if (action === 'rewind' && position >= state.cursor) {
      $('recognized-text').textContent = '目标位置在当前标记之后，无法撤回到那里。';
      return 'done';
    }
    if (action === 'fast-forward' && position <= state.cursor) {
      $('recognized-text').textContent = '目标位置没有超过当前标记。';
      return 'done';
    }
    state.cursor = position;
    $('recognized-text').textContent = `${action === 'rewind' ? '已撤回' : action === 'fast-forward' ? '已快进' : '已跳转'}到目标位置：${target}`;
    render();
    updateProgress();
    return 'done';
  }

  function applyVoiceCommand(transcript) {
    const command = parseVoiceCommand(transcript);
    if (command) {
      clearPendingVoiceCommand();
      const result = applyCommandTarget(command.action, command.target);
      if (result === 'pending') keepPendingVoiceCommand(command.action, command.target);
      return true;
    }
    if (!state.pendingVoiceCommand) return false;
    const pending = state.pendingVoiceCommand;
    const target = [pending.target, transcript.trim()].filter(Boolean).join(' ');
    const result = applyCommandTarget(pending.action, target);
    if (result === 'done') clearPendingVoiceCommand();
    else keepPendingVoiceCommand(pending.action, target);
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
    if (!state.source || (!renderedNodes && !state.layoutBuilt)) return;
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

  // Keep a live microphone stream for the whole listening session. The Web
  // Speech API may end its recognition object after silence; this separate
  // stream keeps microphone capture active while recognition is restarted.
  async function ensureMicrophoneStream() {
    if (state.microphoneStream?.active) return;
    if (!navigator.mediaDevices?.getUserMedia) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.microphoneStream = stream;
    const track = stream.getAudioTracks()[0];
    if (track) {
      track.onended = () => {
        if (state.microphoneStream !== stream) return;
        state.microphoneStream = null;
        if (!state.wantListening) return;
        try { state.recognition?.stop(); } catch (_) { /* Recognition may already have ended. */ }
        if (!state.recognition && !state.startingRecognition) scheduleRecognitionRestart(state.recognitionSession, true);
      };
    }
  }

  function releaseMicrophoneStream() {
    const stream = state.microphoneStream;
    state.microphoneStream = null;
    if (!stream) return;
    for (const track of stream.getTracks()) {
      track.onended = null;
      track.stop();
    }
  }

  function finishSpeedSession() {
    if (state.speedTracker.startedAt) {
      state.speedTracker.activeMs += Math.max(0, Date.now() - state.speedTracker.startedAt);
      state.speedTracker.startedAt = 0;
      persistSpeedTracker();
    }
  }

  function stopListening() {
    finishSpeedSession();
    state.wantListening = false;
    state.recognitionSession++;
    state.startingRecognition = false;
    clearTimeout(state.restartTimer);
    state.restartTimer = 0;
    state.restartAttempts = 0;
    state.lastRecognitionError = '';
    clearPendingVoiceCommand();
    state.listening = false;
    const recognition = state.recognition;
    state.recognition = null;
    clearRecognitionBuffers();
    try { recognition?.stop(); } catch (_) { /* The session is already invalidated. */ }
    releaseMicrophoneStream();
    $('start-button').classList.remove('hidden');
    $('start-button').disabled = false;
    $('stop-button').classList.add('hidden');
    $('listening-badge').textContent = '监听已停止';
    $('listening-badge').classList.remove('active');
    $('recognition-led').classList.remove('active');
  }

  function scheduleRecognitionRestart(session, failedStart = false) {
    if (!state.wantListening || session !== state.recognitionSession || state.restartTimer) return;
    // A normal silence timeout should resume quickly. Exponential backoff is
    // reserved for start failures, where retrying too quickly can be rejected.
    const delay = failedStart ? Math.min(500 * (2 ** Math.min(state.restartAttempts, 4)), 8000) : 500;
    if (failedStart) state.restartAttempts++;
    state.listening = true;
    $('start-button').classList.add('hidden');
    $('stop-button').classList.remove('hidden');
    $('listening-badge').textContent = '监听短暂中断，正在恢复';
    $('listening-badge').classList.add('active');
    $('recognition-led').classList.remove('active');
    updateProgress();
    state.restartTimer = window.setTimeout(() => {
      state.restartTimer = 0;
      if (state.wantListening && session === state.recognitionSession) startListening(true);
    }, delay);
  }

  async function startListening(automaticRestart = false) {
    if (!automaticRestart) {
      if (!state.source) { $('status-text').textContent = '请先导入内容'; return; }
      if (!SpeechRecognition) {
        $('status-text').textContent = '当前浏览器不支持语音识别';
        $('recognized-text').textContent = '请使用支持 Web Speech API 的浏览器。抄写时自然读出即可，不需要跟读软件。';
        return;
      }
      if (state.startingRecognition || state.recognition || state.listening) return;
      state.wantListening = true;
      state.restartAttempts = 0;
      state.lastRecognitionError = '';
    } else if (!state.wantListening || !state.source || !SpeechRecognition) return;
    if (state.startingRecognition || state.recognition) return;

    const session = ++state.recognitionSession;
    state.startingRecognition = true;
    $('start-button').disabled = true;
    if (!automaticRestart) $('listening-badge').textContent = '正在连接麦克风';
    try {
      await ensureMicrophoneStream();
      if (session !== state.recognitionSession || !state.wantListening) {
        if (!state.wantListening) releaseMicrophoneStream();
        return;
      }

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
        if (!state.speedTracker.startedAt) state.speedTracker.startedAt = Date.now();
        state.listening = true;
        state.restartAttempts = 0;
        state.lastRecognitionError = '';
        $('start-button').classList.add('hidden');
        $('stop-button').classList.remove('hidden');
        $('listening-badge').textContent = '正在听取';
        $('listening-badge').classList.add('active');
        $('recognition-led').classList.add('active');
        updateProgress();
      };
      recognition.onresult = (event) => {
        if (!isCurrentSession()) return;
        state.restartAttempts = 0;
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
          } else if (isVoiceCommandLead(transcript) || state.pendingVoiceCommand) {
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
        state.lastRecognitionError = event.error;
        if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(event.error)) {
          state.wantListening = false;
          state.listening = false;
          finishSpeedSession();
          releaseMicrophoneStream();
          $('recognized-text').textContent = event.error === 'audio-capture'
            ? '没有检测到可用麦克风，请检查设备后重新开始。'
            : '麦克风权限未开启，请在浏览器地址栏允许麦克风后重新开始。';
        } else if (event.error === 'network') {
          $('recognized-text').textContent = '语音服务连接中断，正在尝试恢复监听。';
        }
      };
      recognition.onend = () => {
        if (!isCurrentSession()) return;
        state.recognition = null;
        clearRecognitionBuffers();
        if (state.wantListening) {
          $('recognized-text').textContent = state.lastRecognitionError === 'network'
            ? '语音服务暂时不可用，正在重新连接。'
            : '监听短暂中断，正在自动恢复。';
          scheduleRecognitionRestart(session);
          return;
        }
        state.listening = false;
        $('start-button').classList.remove('hidden');
        $('stop-button').classList.add('hidden');
        $('listening-badge').textContent = state.lastRecognitionError ? '请检查麦克风后重试' : '识别已结束，可继续监听';
        $('listening-badge').classList.remove('active');
        $('recognition-led').classList.remove('active');
        updateProgress();
      };
      recognition.start();
    } catch (error) {
      if (session === state.recognitionSession) {
        state.recognition = null;
        clearRecognitionBuffers();
        const fatal = ['NotAllowedError', 'SecurityError', 'NotFoundError'].includes(error.name);
        state.lastRecognitionError = error.name || 'start-failed';
        if (fatal) {
          state.wantListening = false;
          state.listening = false;
          releaseMicrophoneStream();
          $('recognized-text').textContent = error.name === 'NotFoundError'
            ? '没有检测到可用麦克风，请检查设备后重新开始。'
            : '麦克风权限未开启。请在浏览器网站设置中允许麦克风，再点击一次“开始监听”。';
          $('listening-badge').textContent = '监听未启动';
          $('listening-badge').classList.remove('active');
          $('recognition-led').classList.remove('active');
          $('stop-button').classList.add('hidden');
          $('start-button').classList.remove('hidden');
        } else if (state.wantListening) {
          $('recognized-text').textContent = '语音监听暂时中断，正在尝试恢复。';
          scheduleRecognitionRestart(session, true);
        } else {
          state.listening = false;
          $('recognized-text').textContent = `无法开始语音识别：${error.message}`;
          $('listening-badge').textContent = '监听未启动';
          $('stop-button').classList.add('hidden');
          $('start-button').classList.remove('hidden');
        }
        updateProgress();
      }
    } finally {
      if (session === state.recognitionSession) {
        state.startingRecognition = false;
        $('start-button').disabled = false;
      }
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
    const ctx = layoutContext();
    const body = xml.getElementsByTagNameNS('*', 'body')[0];
    const rootChildren = [];
    const childrenOf = (node, localName) => [...node.children].filter((child) => child.localName === localName);
    const paragraph = (p) => {
      const properties = childrenOf(p, 'pPr')[0];
      const pStyle = childrenOf(properties || document.createElement('div'), 'pStyle')[0]?.getAttribute('w:val') || '';
      const headingMatch = pStyle.match(/heading\s*([1-6])/i);
      const tag = headingMatch ? `h${headingMatch[1]}` : /title/i.test(pStyle) ? 'h1' : 'p';
      const jc = childrenOf(properties || document.createElement('div'), 'jc')[0]?.getAttribute('w:val');
      const style = jc && ['center','right','left','both','justify'].includes(jc) ? { 'text-align': jc === 'both' ? 'justify' : jc } : {};
      const runs = [];
      const visit = (element, bold = false, italic = false, underline = false, runStyle = {}) => {
        for (const node of element.childNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.localName === 'rPr') {
            const color = childrenOf(node, 'color')[0]?.getAttribute('w:val');
            const size = Number(childrenOf(node, 'sz')[0]?.getAttribute('w:val')) / 2;
            const nextStyle = { ...runStyle };
            if (color && /^[0-9a-f]{6}$/i.test(color)) nextStyle.color = `#${color}`;
            if (Number.isFinite(size) && size >= 6) nextStyle['font-size'] = `${Math.max(8, Math.min(48, size * 1.333))}px`;
            continue;
          }
          if (node.localName === 'r') {
            const props = childrenOf(node, 'rPr')[0];
            const isBold = bold || Boolean(childrenOf(props || document.createElement('div'), 'b').length);
            const isItalic = italic || Boolean(childrenOf(props || document.createElement('div'), 'i').length);
            const isUnderline = underline || Boolean(childrenOf(props || document.createElement('div'), 'u').length);
            const runStyle = {};
            const color = childrenOf(props || document.createElement('div'), 'color')[0]?.getAttribute('w:val');
            const halfPoints = Number(childrenOf(props || document.createElement('div'), 'sz')[0]?.getAttribute('w:val'));
            if (color && /^[0-9a-f]{6}$/i.test(color)) runStyle.color = `#${color}`;
            if (halfPoints >= 12 && halfPoints <= 72) runStyle['font-size'] = `${Math.max(8, Math.min(48, halfPoints / 2 * 1.333))}px`;
            const runChildren = [];
            for (const part of node.childNodes) {
              if (part.nodeType !== Node.ELEMENT_NODE) continue;
              if (part.localName === 't') { const leaf = layoutText(ctx, part.textContent || ''); if (leaf) runChildren.push(leaf); }
              else if (part.localName === 'tab') { const leaf = layoutText(ctx, '\t'); if (leaf) runChildren.push(leaf); }
              else if (part.localName === 'br' || part.localName === 'cr') { const leaf = layoutText(ctx, '\n', true); if (leaf) runChildren.push(leaf); }
            }
            let wrapped = layoutElement('span', runChildren, {}, safeStyle(runStyle));
            if (isUnderline) wrapped = layoutElement('u', [wrapped]);
            if (isItalic) wrapped = layoutElement('em', [wrapped]);
            if (isBold) wrapped = layoutElement('strong', [wrapped]);
            runs.push(wrapped);
          } else if (node.localName === 'hyperlink') visit(node, bold, italic, underline, runStyle);
        }
      };
      visit(p);
      return layoutElement(tag, runs, {}, style, /list/i.test(pStyle) ? 'docx-list-item' : '');
    };
    const cell = (tc) => {
      const blocks = [];
      for (const child of tc.children) {
        if (child.localName === 'p') { if (blocks.length) layoutBoundary(ctx, blocks); blocks.push(paragraph(child)); }
        else if (child.localName === 'tbl') blocks.push(table(child));
      }
      const tcPr = childrenOf(tc, 'tcPr')[0];
      const span = Number(childrenOf(tcPr || document.createElement('div'), 'gridSpan')[0]?.getAttribute('w:val'));
      return layoutElement('td', blocks, span > 1 ? { colspan: String(Math.min(20, span)) } : {});
    };
    const table = (tbl) => {
      const rows = [];
      for (const tr of childrenOf(tbl, 'tr')) {
        if (rows.length) layoutBoundary(ctx, rows, '\n');
        const cells = [];
        for (const tc of childrenOf(tr, 'tc')) {
          if (cells.length) layoutBoundary(ctx, cells, '\t');
          cells.push(cell(tc));
        }
        rows.push(layoutElement('tr', cells));
      }
      return layoutElement('table', [layoutElement('tbody', rows)]);
    };
    for (const child of body?.children || []) {
      if (rootChildren.length) layoutBoundary(ctx, rootChildren);
      if (child.localName === 'p') rootChildren.push(paragraph(child));
      else if (child.localName === 'tbl') rootChildren.push(table(child));
    }
    if (!ctx.text) throw new Error('DOCX 中没有可提取的文字。');
    return finalizeLayout(ctx, layoutElement('div', rootChildren, {}, {}, 'imported-document docx-document'));
  }

  let spreadsheetLibrary = null;
  function loadSpreadsheetLibrary() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (!spreadsheetLibrary) spreadsheetLibrary = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
      script.async = true;
      script.crossOrigin = 'anonymous';
      script.referrerPolicy = 'no-referrer';
      script.onload = () => window.XLSX ? resolve(window.XLSX) : reject(new Error('Excel 阅读组件载入失败。'));
      script.onerror = () => reject(new Error('无法载入 Excel 阅读组件，请检查网络后重试。'));
      document.head.appendChild(script);
    });
    return spreadsheetLibrary;
  }

  function excelColor(value) {
    const rgb = value?.rgb;
    if (typeof rgb !== 'string') return null;
    const hex = rgb.replace(/^#/, '').slice(-6);
    return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex}` : null;
  }

  function spreadsheetCellStyle(cell) {
    const format = cell?.s;
    if (!format || typeof format !== 'object') return {};
    const style = {};
    const font = format.font || {};
    const fill = format.fill || {};
    const alignment = format.alignment || {};
    const bg = excelColor(fill.fgColor || fill.bgColor);
    const fg = excelColor(font.color);
    if (bg) style['background-color'] = bg;
    if (fg) style.color = fg;
    if (font.bold) style['font-weight'] = '700';
    if (font.italic) style['font-style'] = 'italic';
    if (font.underline) style['text-decoration'] = 'underline';
    if (Number(font.sz) >= 6 && Number(font.sz) <= 36) style['font-size'] = `${Math.round(Number(font.sz) * 1.333)}px`;
    if (['left','center','right','justify'].includes(alignment.horizontal)) style['text-align'] = alignment.horizontal;
    if (['top','middle','bottom'].includes(alignment.vertical)) style['vertical-align'] = alignment.vertical === 'middle' ? 'middle' : alignment.vertical;
    if (alignment.wrapText) style['white-space'] = 'pre-wrap';
    const borderStyle = { hair: '1px solid', thin: '1px solid', dotted: '1px dotted', dashed: '1px dashed', medium: '2px solid', thick: '3px solid', double: '3px double' };
    for (const side of ['top','right','bottom','left']) {
      const border = format.border?.[side];
      const line = borderStyle[border?.style];
      if (!line) continue;
      const color = excelColor(border.color) || '#c9cec6';
      style[`border-${side}`] = `${line} ${color}`;
    }
    return style;
  }

  async function readSpreadsheet(file) {
    const XLSX = await loadSpreadsheetLibrary();
    const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', cellStyles: true, cellHTML: true, cellNF: true });
    if (!workbook.SheetNames?.length) throw new Error('Excel 文件中没有工作表。');
    const ctx = layoutContext();
    const sheets = [];
    let cellBudget = 0;
    for (const sheetName of workbook.SheetNames) {
      const worksheet = workbook.Sheets[sheetName];
      if (!worksheet?.['!ref']) continue;
      const range = XLSX.utils.decode_range(worksheet['!ref']);
      const rowsCount = range.e.r - range.s.r + 1;
      const colsCount = range.e.c - range.s.c + 1;
      cellBudget += rowsCount * colsCount;
      if (cellBudget > 50_000) throw new Error('工作簿单元格数量过大（超过 5 万格）。请先拆分工作表后再导入。');
      if (sheets.length) layoutBoundary(ctx, sheets, '\n');

      const merges = new Map();
      const covered = new Set();
      for (const merge of worksheet['!merges'] || []) {
        merges.set(`${merge.s.r}:${merge.s.c}`, merge);
        for (let row = merge.s.r; row <= merge.e.r; row++) {
          for (let col = merge.s.c; col <= merge.e.c; col++) {
            if (row !== merge.s.r || col !== merge.s.c) covered.add(`${row}:${col}`);
          }
        }
      }
      const bodyRows = [];
      for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex++) {
        if (bodyRows.length) layoutBoundary(ctx, bodyRows, '\n');
        const rowChildren = [];
        const rowStyle = {};
        const rowFormat = worksheet['!rows']?.[rowIndex];
        const rowHeight = Number(rowFormat?.hpx || (rowFormat?.hpt ? rowFormat.hpt * 4 / 3 : 0));
        if (rowHeight >= 8 && rowHeight <= 240) rowStyle.height = `${rowHeight}px`;
        for (let colIndex = range.s.c; colIndex <= range.e.c; colIndex++) {
          if (covered.has(`${rowIndex}:${colIndex}`)) continue;
          if (rowChildren.length) layoutBoundary(ctx, rowChildren, '\t');
          const cell = worksheet[XLSX.utils.encode_cell({ r: rowIndex, c: colIndex })];
          const children = [];
          const commentText = (cell?.c || []).map((part) => [part.a, part.t].filter(Boolean).join(': ')).filter(Boolean).join('\n');
          if (commentText) children.push(layoutElement('span', [], { title: commentText.slice(0, 2000), 'aria-label': `单元格批注：${commentText.slice(0, 300)}` }, {}, 'spreadsheet-comment'));
          const value = cell?.w ?? (cell?.v == null ? '' : String(cell.v));
          const text = String(value).replace(/\r\n?/g, '\n');
          const leaf = layoutText(ctx, text);
          if (leaf) children.push(leaf);
          const merge = merges.get(`${rowIndex}:${colIndex}`);
          const attrs = {};
          if (merge) {
            if (merge.e.r > merge.s.r) attrs.rowspan = String(merge.e.r - merge.s.r + 1);
            if (merge.e.c > merge.s.c) attrs.colspan = String(merge.e.c - merge.s.c + 1);
          }
          const cellStyle = spreadsheetCellStyle(cell);
          const colInfo = worksheet['!cols']?.[colIndex];
          const width = Number(colInfo?.wpx || (colInfo?.wch ? colInfo.wch * 7 : 0));
          if (width >= 28 && width <= 600) cellStyle.width = `${width}px`;
          rowChildren.push(layoutElement('td', children, attrs, cellStyle));
        }
        bodyRows.push(layoutElement('tr', rowChildren, {}, rowStyle));
      }
      const table = layoutElement('table', [layoutElement('tbody', bodyRows)]);
      sheets.push(layoutElement('section', [layoutElement('h2', [], { 'data-sheet-name': sheetName }, {}, 'spreadsheet-sheet-title'), table], {}, {}, 'spreadsheet-sheet'));
    }
    if (!ctx.text.trim()) throw new Error('工作簿中没有可读取的单元格内容。');
    return finalizeLayout(ctx, layoutElement('div', sheets, {}, {}, 'spreadsheet-book'));
  }

  async function readPdf(file) {
    const version = '6.3.289';
    const baseUrl = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${version}/build/`;
    let pdfjs;
    try { pdfjs = await import(`${baseUrl}pdf.mjs`); }
    catch (_) { throw new Error('无法载入 PDF 阅读组件。请检查网络连接后重试，或将 PDF 另存为 DOCX/TXT。'); }
    pdfjs.GlobalWorkerOptions.workerSrc = `${baseUrl}pdf.worker.mjs`;
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false, enableXfa: false }).promise;
    const ctx = layoutContext();
    const pageNodes = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      const textContent = await page.getTextContent();
      let pageArtwork = null;
      try {
        const renderScale = Math.min(1.5, 1400 / Math.max(viewport.width, viewport.height));
        const artworkViewport = page.getViewport({ scale: renderScale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(artworkViewport.width);
        canvas.height = Math.ceil(artworkViewport.height);
        const context = canvas.getContext('2d', { alpha: false });
        await page.render({ canvasContext: context, viewport: artworkViewport, annotationMode: pdfjs.AnnotationMode?.ENABLE }).promise;
        pageArtwork = layoutElement('img', [], { src: canvas.toDataURL('image/png'), alt: `第 ${number} 页原始页面` }, {}, 'pdf-page-artwork');
        canvas.width = 0;
        canvas.height = 0;
      } catch (_) { /* Keep the text overlay usable if a PDF page cannot be rasterized. */ }
      const items = textContent.items.filter((item) => 'str' in item && item.str).map((item) => {
        const transform = item.transform || [1, 0, 0, 1, 0, 0];
        const [x, y] = viewport.convertToViewportPoint(transform[4], transform[5]);
        const height = Math.max(6, Math.hypot(transform[2], transform[3]) || item.height || 10);
        return { item, x, y, top: Math.max(0, y - height), height, width: Math.max(0, item.width || item.str.length * height * .5) };
      }).sort((a, b) => Math.abs(a.y - b.y) > Math.max(a.height, b.height) * .55 ? a.y - b.y : a.x - b.x);
      const rows = [];
      for (const entry of items) {
        let row = rows.find((candidate) => Math.abs(candidate.y - entry.y) <= Math.max(candidate.height, entry.height) * .55);
        if (!row) { row = { y: entry.y, height: entry.height, items: [] }; rows.push(row); }
        row.items.push(entry); row.height = Math.max(row.height, entry.height);
      }
      rows.sort((a, b) => a.y - b.y);
      const pageChildren = [];
      if (pageArtwork) pageChildren.push(pageArtwork);
      for (const row of rows) {
        row.items.sort((a, b) => a.x - b.x);
        for (const entry of row.items) {
          const previous = pageChildren.at(-1);
          if (previous && !ctx.text.endsWith('\n')) {
            const prev = previous._pdfEntry;
            const gap = prev ? entry.x - (prev.x + prev.width) : 0;
            const separator = layoutText(ctx, gap > entry.height * .25 ? ' ' : '', true);
            if (separator) pageChildren.push(separator);
          }
          const leaf = layoutText(ctx, entry.item.str);
          if (!leaf) continue;
          const style = { left: `${entry.x / viewport.width * 100}%`, top: `${entry.top / viewport.height * 100}%`, '--pdf-size': `${entry.height / viewport.height * 100}cqh` };
          const span = layoutElement('span', [leaf], {}, style, 'pdf-run');
          span._pdfEntry = entry;
          pageChildren.push(span);
        }
        if (ctx.text && !ctx.text.endsWith('\n')) { const br = layoutText(ctx, '\n', true); if (br) pageChildren.push(br); }
      }
      if (number < pdf.numPages) { const pageBreak = layoutText(ctx, '\n', true); if (pageBreak) pageChildren.push(pageBreak); }
      pageNodes.push(layoutElement('div', pageChildren, {}, { 'aspect-ratio': `${viewport.width} / ${viewport.height}` }, 'pdf-page'));
    }
    const result = finalizeLayout(ctx, layoutElement('div', pageNodes, {}, {}, 'pdf-document'));
    result.pageCount = pdf.numPages;
    return result;
  }

  $('file-input').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (/\.docx$/i.test(file.name)) { const result = await readDocx(file); setSource(result.text, file.name, result.model); }
      else if (/\.pdf$/i.test(file.name)) {
        const result = await readPdf(file);
        setSource(result.text, file.name, result.model);
        if (!result.text.trim()) {
          $('document-meta').textContent = `${result.pageCount} 页 · 已显示原页，未检测到可索引文字`;
          $('recognized-text').textContent = '这份 PDF 没有可提取的文字层。页面可查看；进行语音标记前请先对扫描件 OCR。';
        }
      }
      else if (/\.(xlsx|xls|xlsm|xlsb|ods|csv)$/i.test(file.name)) { const result = await readSpreadsheet(file); setSource(result.text, file.name, result.model); }
      else if (/\.html?$/i.test(file.name)) {
        const doc = new DOMParser().parseFromString(await file.text(), 'text/html');
        doc.querySelectorAll('script,noscript,template,iframe,object,embed').forEach((node) => node.remove());
        const result = htmlToLayout(doc); setSource(result.text, file.name, result.model);
      } else if (/\.(md|markdown)$/i.test(file.name)) { const result = markdownToLayout(await file.text()); setSource(result.text, file.name, result.model); }
      else setSource(await file.text(), file.name);
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
  $('start-button').addEventListener('click', () => startListening(false));
  $('refresh-time').addEventListener('click', refreshTimeEstimate);
  const commandGuide = $('command-guide');
  commandGuide.addEventListener('click', (event) => {
    const button = event.target.closest('.command-item');
    if (!button) return;
    const shouldOpen = !button.classList.contains('is-open');
    commandGuide.querySelectorAll('.command-item').forEach((item) => {
      item.classList.remove('is-open');
      item.setAttribute('aria-expanded', 'false');
    });
    if (shouldOpen) {
      button.classList.add('is-open');
      button.setAttribute('aria-expanded', 'true');
    }
  });
  document.addEventListener('pointerdown', (event) => {
    if (commandGuide.contains(event.target)) return;
    commandGuide.querySelectorAll('.command-item.is-open').forEach((item) => {
      item.classList.remove('is-open');
      item.setAttribute('aria-expanded', 'false');
    });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    commandGuide.querySelectorAll('.command-item.is-open').forEach((item) => {
      item.classList.remove('is-open');
      item.setAttribute('aria-expanded', 'false');
    });
  });
  $('stop-button').addEventListener('click', () => {
    stopListening();
    updateProgress();
  });
  $('reset-button').addEventListener('click', () => {
    stopListening();
    state.cursor = 0;
    state.speedTracker = { activeMs: 0, startedAt: 0, copiedChars: 0, estimate: 350 };
    try { localStorage.removeItem(speedStorageKey(state.documentKey)); } catch (_) { /* Speed data is optional when storage is unavailable. */ }
    $('recognized-text').textContent = '阅读位置已重置';
    render();
    updateProgress();
  });
  $('font-button').addEventListener('click', () => {
    state.fontSize = state.fontSize >= 20 ? 14 : state.fontSize + 2;
    content.style.fontSize = `${state.fontSize}px`;
    content.style.setProperty('--doc-scale', String(state.fontSize / 16));
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !state.wantListening || state.recognition || state.startingRecognition || state.restartTimer) return;
    scheduleRecognitionRestart(state.recognitionSession);
  });

  window.addEventListener('pagehide', () => {
    clearTimeout(state.progressTimer);
    persistSpeedTracker();
    if (state.documentKey) {
      try { localStorage.setItem(state.documentKey, String(state.cursor)); } catch (_) { /* Progress remains available for this session. */ }
    }
  });

})();
