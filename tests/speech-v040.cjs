const assert = require('node:assert/strict');
globalThis.pinyinPro = require('../versions/v0.4.0/vendor/pinyin-pro.js');
const core = require('../versions/v0.4.0/speech-core.js');
const Controller = require('../versions/v0.4.0/recognition-controller.js');
let checked = 0;
const check = (name, task) => { task(); checked++; console.log('PASS ' + name); };

check('Chinese nearby homophones preserve source offsets', () => {
  const source = '前面已经读过。这是新的开始。';
  const match = core.nearbyPhoneticMatch(source, 7, '这是心的开始', 'zh-CN');
  assert.equal(match.end, source.indexOf('开始') + 2);
});
check('Matching cannot move backward or beyond the local range', () => {
  assert.equal(core.nearbyPhoneticMatch('新的开始' + '甲'.repeat(250) + '新的开始', 4, '心的开始', 'zh-CN'), null);
});
check('Single Chinese homophones and unrelated phrases are rejected', () => {
  assert.equal(core.nearbyPhoneticMatch('新的开始', 0, '心', 'zh-CN'), null);
  assert.equal(core.nearbyPhoneticMatch('新的开始', 0, '天气晴朗', 'zh-CN'), null);
});
check('English homophones keep word boundaries', () => {
  const source = 'I write here every night.';
  assert.equal(core.nearbyPhoneticMatch(source, 0, 'I right hear', 'en-US').end, 12);
  assert.equal(core.nearbyPhoneticMatch(source, 0, 'completely different words', 'en-US'), null);
});
check('Japanese kana and Korean liaison', () => {
  assert.equal(core.nearbyPhoneticMatch('カメラを見ます', 0, 'かめら', 'ja-JP').end, 3);
  assert.equal(core.nearbyPhoneticMatch('한국어를 읽어요', 0, '한구거', 'ko-KR').end, 3);
});
check('Unicode normalization retains original character boundaries', () => {
  const mapped = core.normalizeMap('Ａ，🙂Ｂ');
  assert.equal(mapped.normalized, 'ab');
  assert.deepEqual(mapped.positions, [0, 4]);
  assert.deepEqual(mapped.ends, [1, 5]);
});
check('English polite, split, and relative commands', () => {
  assert.deepEqual(core.parseCommand('Please fast forward twenty characters.'), { action: 'fast-forward', target: 'twenty characters' });
  assert.deepEqual(core.parseCommand('go back to the beginning'), { action: 'rewind', target: 'the beginning' });
  assert.deepEqual(core.parseCommand('rewind ten words'), { action: 'rewind', target: 'ten words' });
  assert.deepEqual(core.parseCommand('jump to'), { action: 'jump', target: '' });
  assert.equal(core.commandLead('please fast'), true);
  assert.equal(core.parseNumber('one hundred and twenty'), 120);
  assert.equal(core.parseNumber('fifty'), 50);
  assert.equal(core.parseNumber('12.5'), 12.5);
  assert.equal(core.parseNumber('二十五'), 25);
});

function fixture(autoStart = true) {
  const instances = [], states = [], timers = new Map();
  let now = 0, id = 0;
  const clock = {
    now: () => now,
    setTimeout: (fn, delay) => { timers.set(++id, { fn, delay }); return id; },
    clearTimeout: key => timers.delete(key)
  };
  class Recognition {
    constructor() { instances.push(this); }
    start() { if (autoStart) this.onstart(); }
    abort() { this.onend?.(); }
  }
  const controller = new Controller({ Recognition, language: 'en-US', clock, onState: (phase, detail) => states.push({ phase, detail }) });
  const tick = delay => {
    const timer = [...timers].find(([, entry]) => entry.delay === delay);
    assert.ok(timer, 'Expected scheduled delay ' + delay);
    timers.delete(timer[0]); now += delay; timer[1].fn();
  };
  return { controller, instances, states, timers, tick, advance: amount => { now += amount; } };
}
check('Network failures back off even after onstart and then stop flooding', () => {
  const f = fixture(); f.controller.start();
  for (let count = 0; count < 5; count++) {
    const instance = f.instances.at(-1);
    f.advance(100); instance.onerror({ error: 'network' }); instance.onend();
    if (count < 4) f.tick(1500 * 2 ** count);
  }
  assert.equal(f.controller.blocked, true);
  assert.equal(f.instances.length, 5);
  assert.equal(f.timers.size, 0);
  assert.equal(f.controller.want, true);
});
check('Silence restarts without accumulating service failures', () => {
  const f = fixture(); f.controller.start();
  for (let i = 0; i < 3; i++) { f.advance(10000); f.instances.at(-1).onerror({ error: 'no-speech' }); f.instances.at(-1).onend(); f.tick(650); }
  assert.equal(f.controller.attempts, 0);
  assert.equal(f.controller.blocked, false);
  f.controller.stop(); assert.equal(f.timers.size, 0);
});
check('Manual stop and stale callbacks cannot create new sessions', () => {
  const f = fixture(); f.controller.start(); const old = f.instances[0];
  old.onerror({ error: 'network' }); old.onend(); f.controller.stop();
  old.onstart(); old.onend(); old.onresult({ results: [{ 0: { transcript: 'hello' } }] });
  assert.equal(f.timers.size, 0); assert.equal(f.instances.length, 1);
});
check('Blocked engines expose one retry entry instead of looping', () => {
  const f = fixture(); f.controller.start(); f.instances[0].onerror({ error: 'service-not-allowed' });
  assert.equal(f.controller.blocked, true); assert.equal(f.timers.size, 0);
  f.controller.start(); assert.equal(f.instances.length, 2); assert.equal(f.controller.blocked, false);
});
check('Start watchdog and error-without-onend recover safely', () => {
  const f = fixture(false); f.controller.start(); f.tick(10000); f.tick(1500);
  assert.equal(f.instances.length, 2);
  f.instances.at(-1).onstart(); f.instances.at(-1).onerror({ error: 'network' }); f.tick(1800);
  assert.equal(f.controller.attempts, 2);
  f.controller.stop(); assert.equal(f.timers.size, 0);
});
console.log(checked + ' checks passed');
