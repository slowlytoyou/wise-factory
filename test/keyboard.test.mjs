import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { emitKeypressEvents } from 'node:readline';
import { PassThrough } from 'node:stream';
import { hangulShortcutKeys } from '../src/keyboard.mjs';

test('standalone Korean two-set letters map to their physical ASCII keys', () => {
  assert.equal(hangulShortcutKeys('ㅂㅈㄷㄱㅅㅛㅕㅑㅐㅔㅁㄴㅇㄹㅎㅗㅓㅏㅣㅋㅌㅊㅍㅠㅜㅡ'),
    'qwertyuiopasdfghjklzxcvbnm');
  assert.equal(hangulShortcutKeys('ㅈㅁㄴㅇ'), 'wasd');
  assert.equal(hangulShortcutKeys('ㄸ'), 'e');
  assert.equal(hangulShortcutKeys('ㄲㄸㅃㅆㅉㅒㅖ', { shift: true }), 'reqtwop');
});

test('compound vowels and consonants preserve the order of physical key presses', () => {
  for (const [text, keys] of [
    ['ㅘ', 'hk'], ['ㅙ', 'ho'], ['ㅚ', 'hl'], ['ㅝ', 'nj'],
    ['ㅞ', 'np'], ['ㅟ', 'nl'], ['ㅢ', 'ml'],
    ['ㄳ', 'rt'], ['ㄵ', 'sw'], ['ㄶ', 'sg'], ['ㄺ', 'fr'],
    ['ㄻ', 'fa'], ['ㄼ', 'fq'], ['ㄽ', 'ft'], ['ㄾ', 'fx'],
    ['ㄿ', 'fv'], ['ㅀ', 'fg'], ['ㅄ', 'qt'],
  ]) assert.equal(hangulShortcutKeys(text), keys, text);
});

test('committed syllables expand initials, compound vowels and final consonants', () => {
  for (const [text, keys] of [
    ['와', 'dhk'], ['왜', 'dho'], ['안녕', 'dkssud'], ['값', 'rkqt'],
    ['읽', 'dlfr'], ['닭', 'ekfr'], ['꿇', 'rnfg'], ['뙈', 'eho'],
  ]) assert.equal(hangulShortcutKeys(text), keys, text);
});

test('modern conjoining jamo produce the same shortcuts as composed syllables', () => {
  assert.equal(hangulShortcutKeys('안녕'), 'dkssud');
  assert.equal(hangulShortcutKeys('ᄁᄄᄈᄊ쨰ᅨ'), 'reqtwop');
  assert.equal(hangulShortcutKeys('ᅪᅯᆰᆹ'), 'hknjfrqt');
});

test('ordinary text, mixed input and non-Hangul keys stay with the original key handler', () => {
  for (const text of [undefined, null, 0, '', 'w', 'W', 'wasd', '1', ' ', '\r',
    '\x1b[A', 'ㅈw', 'wㅈ', 'ㅈ ', '🙂', '漢', 'ᄫ', '\u3164']) {
    assert.equal(hangulShortcutKeys(text), null, String(text));
  }
  assert.equal(hangulShortcutKeys(undefined, { name: 'up' }), null);
  assert.equal(hangulShortcutKeys('\x1b[A', { name: 'up' }), null);
});

test('control and meta shortcuts are not reinterpreted as game actions', () => {
  assert.equal(hangulShortcutKeys('ㅈ', { ctrl: true }), null);
  assert.equal(hangulShortcutKeys('ㅂ', { meta: true }), null);
  assert.equal(hangulShortcutKeys('ㅆ', { ctrl: true, shift: true }), null);
  assert.equal(hangulShortcutKeys('ㅈ', { ctrl: false, meta: false }), 'w');
});

async function decodeReadlineChunks(chunks) {
  const stream = new PassThrough();
  const events = [];
  emitKeypressEvents(stream);
  stream.on('keypress', (text, key) => {
    events.push({ text, keys: hangulShortcutKeys(text, key), name: key.name });
  });
  const ended = once(stream, 'end');
  for (const chunk of chunks) stream.write(chunk);
  stream.end();
  await ended;
  return events;
}

test('readline decodes Korean shortcuts even when UTF-8 bytes arrive separately', async () => {
  const input = Buffer.from('ㅈ와닭아ㅆ');
  const whole = await decodeReadlineChunks([input]);
  const split = await decodeReadlineChunks([...input].map(byte => Buffer.of(byte)));
  assert.deepEqual(split, whole);
  assert.deepEqual(split.map(({ text, keys }) => [text, keys]), [
    ['ㅈ', 'w'], ['와', 'dhk'], ['닭', 'ekfr'], ['ᄋ', 'd'], ['ᅡ', 'k'], ['ㅆ', 't'],
  ]);
});

test('real readline arrow and ASCII events remain untouched next to Korean input', async () => {
  const events = await decodeReadlineChunks([Buffer.from('ㅈ\x1b[Aa\x03')]);
  assert.deepEqual(events.map(({ keys, name }) => [keys, name]), [
    ['w', undefined], [null, 'up'], [null, 'a'], [null, 'c'],
  ]);
});
