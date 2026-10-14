/* Pure matching and retry policy. No microphone, network, or DOM access. */
(function (root, factory) {
  const api = factory(root.pinyinPro);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EchoSpeech = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (pinyinLibrary) {
  const syllableCache = new Map();
  const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  function normalizeMap(text) {
    let normalized = '';
    const positions = [], ends = [];
    let fallbackIndex = 0;
    const segments = segmenter ? segmenter.segment(text) : Array.from(text).map(segment => { const item = { segment, index: fallbackIndex }; fallbackIndex += segment.length; return item; });
    for (const { segment, index } of segments) {
      const value = segment.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
      normalized += value;
      for (let i = 0; i < value.length; i++) { positions.push(index); ends.push(index + segment.length); }
    }
    return { normalized, positions, ends };
  }
  const normalize = text => normalizeMap(String(text)).normalized;
  function pinyinKeys(char) {
    if (!pinyinLibrary || !/\p{Script=Han}/u.test(char)) return [char];
    if (!syllableCache.has(char)) {
      const keys = pinyinLibrary.pinyin(char, { type: 'array', toneType: 'none', multiple: true });
      if (syllableCache.size > 4000) syllableCache.clear();
      syllableCache.set(char, keys);
    }
    return syllableCache.get(char);
  }
  const englishGroups = [
    ['there', 'their', 'theyre'], ['to', 'too', 'two'], ['write', 'right', 'rite'], ['read', 'red'],
    ['hear', 'here'], ['sea', 'see'], ['no', 'know'], ['one', 'won'], ['for', 'four', 'fore'],
    ['night', 'knight'], ['piece', 'peace'], ['plain', 'plane'], ['whether', 'weather'], ['your', 'youre'],
    ['through', 'threw'], ['whole', 'hole'], ['meet', 'meat'], ['by', 'buy', 'bye']
  ];
  const englishHomophones = new Map(englishGroups.flatMap(group => group.map(word => [word, group[0]])));
  function englishKey(word) {
    const value = word.toLowerCase().replace(/[^a-z]/g, '');
    if (englishHomophones.has(value)) return englishHomophones.get(value);
    // Conservative spelling-to-sound approximation; common homophones use explicit groups.
    return value.replace(/^(kn|gn)/, 'n').replace(/^wr/, 'r').replace(/ph/g, 'f')
      .replace(/tch/g, 'ch').replace(/ck|qu/g, 'k').replace(/c(?=[eiy])/g, 's')
      .replace(/c/g, 'k').replace(/ght/g, 't').replace(/e$/, '').replace(/(.)\1+/g, '$1');
  }
  function kana(char) {
    const code = char.codePointAt(0);
    return code >= 0x30a1 && code <= 0x30f6 ? String.fromCodePoint(code - 0x60) : char;
  }
  function koreanPhones(text) {
    const syllables = Array.from(text, char => {
      const index = char.codePointAt(0) - 0xac00;
      return index >= 0 && index < 11172 ? { onset: Math.floor(index / 588), vowel: Math.floor(index / 28) % 21, coda: index % 28 } : { char };
    });
    const liaison = { 1: 0, 2: 1, 4: 2, 7: 3, 8: 5, 16: 6, 17: 7, 19: 9, 20: 10, 22: 12, 23: 14, 24: 15, 25: 16, 26: 17, 27: 18 };
    for (let i = 0; i + 1 < syllables.length; i++) {
      const current = syllables[i], next = syllables[i + 1];
      if (current.coda in liaison && next.onset === 11) { next.onset = liaison[current.coda]; current.coda = 0; }
    }
    return syllables.map(item => item.char || `${item.onset}:${item.vowel}:${item.coda}`);
  }
  function phoneticTokens(text, language) {
    const tokens = [];
    const matches = language.startsWith('en') ? text.matchAll(/[a-z]+(?:['’][a-z]+)?|\d+/gi) : text.matchAll(/[^\s\p{P}\p{S}]/gu);
    for (const match of matches) {
      const raw = match[0], value = raw.normalize('NFKC').toLowerCase();
      const keys = language.startsWith('zh') ? pinyinKeys(value) : language.startsWith('en') ? [englishKey(value)] : language.startsWith('ja') ? [Array.from(value, kana).join('')] : [value];
      tokens.push({ value, keys, start: match.index, end: match.index + raw.length });
    }
    if (language.startsWith('ko')) {
      const phones = koreanPhones(tokens.map(token => token.value).join(''));
      tokens.forEach((token, index) => { token.keys = [phones[index]]; });
    }
    return tokens;
  }
  function nearbyPhoneticMatch(source, cursor, spoken, language, range = 200) {
    const utterance = phoneticTokens(spoken, language).slice(0, 64);
    const isEnglish = language.startsWith('en');
    if (!utterance.length || (!isEnglish && utterance.length < 2) || (isEnglish && utterance.length === 1 && utterance[0].value.length < 4)) return null;
    const start = Math.max(0, cursor), end = Math.min(source.length, start + range);
    const local = phoneticTokens(source.slice(start, end), language);
    let best = null;
    for (let i = 0; i + utterance.length <= local.length; i++) {
      let exact = 0, phonetic = 0;
      for (let j = 0; j < utterance.length; j++) {
        const a = utterance[j], b = local[i + j];
        if (a.value === b.value) exact++;
        if (a.keys.some(key => b.keys.includes(key))) phonetic++;
      }
      // Require every phonetic unit for short speech; longer phrases allow one mistranscription.
      const needed = utterance.length <= 4 ? utterance.length : Math.ceil(utterance.length * 0.85);
      if (phonetic < needed) continue;
      const score = (exact * 0.2 + phonetic * 0.8) / utterance.length;
      const candidate = { start: start + local[i].start, end: start + local[i + utterance.length - 1].end, score };
      if (!best || candidate.score > best.score) best = candidate;
    }
    return best;
  }
  function parseNumber(value) {
    const text = String(value).trim().toLowerCase().replace(/[,，]/g, '');
    if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
    const words = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
    if (/^[a-z -]+$/.test(text)) {
      let total = 0, part = 0, seen = false;
      for (const word of text.split(/[ -]+/)) {
        if (word === 'and') continue;
        if (word in words) { part += words[word]; seen = true; }
        else if (word === 'hundred') { part = (part || 1) * 100; seen = true; }
        else if (word === 'thousand') { total += (part || 1) * 1000; part = 0; seen = true; }
        else return null;
      }
      return seen ? total + part : null;
    }
    const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    let total = 0, number = 0;
    for (const char of text.replace(/\s/g, '')) {
      if (char in digits) number = digits[char];
      else if ('十百千'.includes(char)) { total += (number || 1) * ({ 十: 10, 百: 100, 千: 1000 }[char]); number = 0; }
      else return null;
    }
    return total + number;
  }
  function parseCommand(transcript) {
    const text = String(transcript).normalize('NFKC').trim().toLowerCase()
      .replace(/^[\s，,。.!！？、嗯呃啊哦]+/u, '').replace(/^(?:(?:please|okay|ok|hey|echo\s*mark)[,\s]+)+/, '')
      .replace(/[，,。!！？、]/gu, ' ').replace(/\s+/g, ' ');
    const patterns = [
      ['fast-forward', /^(?:快进到|快进至|前进到|前进至|向前到|前移到|前移至|快进|前进)\s*(.*)$/],
      ['rewind', /^(?:撤回到|撤回至|退回到|退回至|倒回到|回退到|回退至|回到|返回到|撤回|退回|倒回|回退)\s*(.*)$/],
      ['jump', /^(?:跳转到|跳转至|跳到|跳至|定位到|定位至|移到|移至)\s*(.*)$/],
      ['fast-forward', /^(?:fast\s*forward|forward|move\s+(?:ahead|forward)|advance)(?:\s+(?:to|by))?(?:\s+|$)(.*)$/],
      ['rewind', /^(?:re\s*wind|go\s+back|move\s+back|back)(?:\s+(?:to|by))?(?:\s+|$)(.*)$/],
      ['jump', /^(?:jump|go|skip|navigate)(?:\s+to)(?:\s+|$)(.*)$/]
    ];
    for (const [action, pattern] of patterns) { const match = text.match(pattern); if (match) return { action, target: match[1].replace(/\s+please[.!]?$/, '').replace(/[.!]+$/, '').trim() }; }
    return null;
  }
  function commandLead(text) {
    if (parseCommand(text)) return true;
    return /^(?:(?:please|okay|ok)\s+)?(?:fast|fast\s+forward|jump|go|go\s+back|re\s*wind|move|skip)\s*$/i.test(text.trim());
  }
  function retryDecision(attempts, error, duration, gotResult) {
    const unavailable = ['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported'];
    if (unavailable.includes(error)) return { attempts, delay: 0, blocked: true, fatal: true };
    const failed = error && error !== 'no-speech' || (!gotResult && duration < 1500);
    const next = gotResult ? 0 : failed ? attempts + 1 : attempts;
    return { attempts: next, delay: failed ? Math.min(1500 * 2 ** Math.max(0, next - 1), 30000) : 650, blocked: next >= 5, fatal: false };
  }
  return { normalizeMap, normalize, nearbyPhoneticMatch, englishKey, parseNumber, parseCommand, commandLead, retryDecision };
});
