import test from 'node:test';
import assert from 'node:assert/strict';
import { Canvas, displayWidth, fitText } from '../src/terminal.mjs';

test('display width counts Korean, combining marks and emoji graphemes', () => {
  assert.equal(displayWidth('채굴 광산'), 9);
  assert.equal(displayWidth('e\u0301'), 1);
  assert.equal(displayWidth('👩🏽‍🚀'), 2);
  assert.equal(displayWidth('🇰🇷'), 2);
  assert.equal(displayWidth('1️⃣'), 2);
  assert.equal(displayWidth('⚒'), 1);
  assert.equal(displayWidth('⚒️'), 2);
  assert.equal(displayWidth('\x1b[31m금\x1b[0m'), 2);
});

test('fitText clips graphemes and pads to the requested column width', () => {
  assert.equal(fitText('광산ABC', 3), '광 ');
  assert.equal(fitText('👩🏽‍🚀abc', 3), '👩🏽‍🚀a');
  assert.equal(fitText('금', 0), '');
  assert.equal(fitText('x', 4), 'x   ');
});

test('text clips both edges without painting half a wide grapheme', () => {
  const canvas = new Canvas(5, 2);
  assert.equal(canvas.text(0, 0, 'A금광Z'), 5);
  assert.equal(canvas.text(-1, 1, '금광A'), 3);
  assert.equal(canvas.plain(), 'A금광\n 광A ');
  assert.equal(canvas.set(4, 1, '금'), 0);
  for (const row of canvas.plain().split('\n')) assert.equal(displayWidth(row), 5);
});

test('maxWidth limits text by display columns rather than string length', () => {
  const canvas = new Canvas(8, 1);
  assert.equal(canvas.text(1, 0, '금광ABC', undefined, undefined, 3), 2);
  assert.equal(canvas.plain(), ' 금     ');
});

test('overwriting either half of a wide glyph erases its other half', () => {
  const canvas = new Canvas(6, 1);
  canvas.text(0, 0, '금광A');
  canvas.set(1, 0, 'x');
  assert.equal(canvas.plain(), ' x광A ');
  canvas.set(2, 0, 'y');
  assert.equal(canvas.plain(), ' xy A ');
  canvas.set(1, 0, '별');
  assert.equal(canvas.plain(), ' 별 A ');
  assert.equal(displayWidth(canvas.plain()), 6);
});

test('a new wide glyph can safely overwrite two neighboring wide glyphs', () => {
  const canvas = new Canvas(6, 1);
  canvas.text(0, 0, '금광산');
  canvas.set(1, 0, '👩🏽‍🚀');
  assert.equal(canvas.plain(), ' 👩🏽‍🚀 산');
  assert.equal(displayWidth(canvas.plain()), 6);
});

test('diff output contains only changed rows, with no line feed or trailing wrap', () => {
  const before = new Canvas(5, 3);
  const after = new Canvas(5, 3);
  assert.equal(after.render(before), '');
  after.text(0, 1, '광산!');
  assert.equal(after.render(before, { color: false }), '\x1b[2;1H광산!');
  const full = after.render(null, { color: false });
  assert.equal(full, '\x1b[1;1H     \x1b[2;1H광산!\x1b[3;1H     ');
  assert.ok(!full.includes('\n'));
});

test('color changes trigger a row diff and RGB colors are emitted', () => {
  const before = new Canvas(2, 1);
  const after = new Canvas(2, 1);
  after.set(0, 0, ' ', [255, 120, 0], [10, 20, 30]);
  const result = after.render(before);
  assert.ok(result.startsWith('\x1b[1;1H\x1b[38;2;255;120;0;48;2;10;20;30m'));
  assert.ok(result.endsWith('\x1b[0m'));
});

test('fill, clipped boxes, and titles preserve row widths', () => {
  const canvas = new Canvas(10, 4);
  canvas.fill(0, 0, 10, 4, '.', [100, 100, 100]);
  canvas.box(-1, 0, 11, 4, { title: '광산', bg: [3, 5, 10] });
  const rows = canvas.plain().split('\n');
  for (const row of rows) assert.equal(displayWidth(row), 10);
  assert.ok(rows[0].includes('광산'));
  assert.equal(rows[1], '         │');
});

test('drawing never forwards ANSI or control sequences from text content', () => {
  const canvas = new Canvas(4, 1);
  canvas.text(0, 0, '\x1b[2J금\nX');
  assert.equal(canvas.plain(), '금X ');
});
