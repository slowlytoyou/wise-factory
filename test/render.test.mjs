import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, UPGRADES } from '../src/model.mjs';
import { renderGame, number } from '../src/render.mjs';
import { displayWidth } from '../src/terminal.mjs';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const ui = overrides => ({ time: 0, effects: [], logs: ['연결 정상', '별빛 공방 가동 중'], ...overrides });

// Expand wide glyphs to terminal columns so assertions match the screen,
// rather than indexing UTF-16 characters or counting Korean letters as one.
function columns(line) {
  const result = [];
  for (const { segment } of graphemes.segment(line)) {
    const width = displayWidth(segment);
    if (width) result.push(segment, ...Array(width - 1).fill(''));
  }
  return result;
}

function rectangle(rows, x, y, width, height) {
  return rows.slice(y, y + height).map(row => columns(row).slice(x, x + width).join('')).join('\n');
}

for (const [width, height] of [[88, 32], [110, 38], [160, 50]]) {
  test(`${width}×${height} keeps every upgrade, footer and panel border on screen`, () => {
    const frame = renderGame(createGame(0), ui(), width, height);
    const rows = frame.plain().split('\n');
    assert.equal(frame.width, width);
    assert.equal(frame.height, height);
    assert.equal(rows.length, height);
    rows.forEach((row, index) => assert.equal(displayWidth(row), width, `row ${index}`));
    assert.ok(!frame.plain().includes('\x1b'), 'plain snapshots contain no terminal controls');
    assert.match(rows[1], /S T A R F A L L/);
    assert.match(rows[1], /별빛 공방/);
    assert.match(rows[1], /LIVE/);

    const top = columns(rows[5]);
    const corners = top.flatMap((cell, index) => cell === '┌' || cell === '┐' ? [index] : []);
    assert.equal(corners.length, 4, 'both panel headers are intact');
    assert.equal(corners[0], 2);
    assert.equal(corners.at(-1), width - 3);
    for (let y = 6; y < height - 8; y++) {
      const row = columns(rows[y]);
      for (const x of corners) assert.equal(row[x], '│', `panel border at ${x},${y}`);
    }
    const bottom = columns(rows[height - 8]);
    for (let pane = 0; pane < 2; pane++) {
      const [left, right] = corners.slice(pane * 2, pane * 2 + 2);
      assert.equal(bottom[left], '└');
      assert.equal(bottom[right], '┘');
      assert.ok(bottom.slice(left + 1, right).every(cell => cell === '─'), 'content does not overwrite bottom border');
    }

    const upgradeRows = UPGRADES.map((upgrade, index) => {
      const row = rows.findIndex(line => line.includes(`[${index + 1}] ${upgrade.name}`));
      assert.ok(row > 5 && row < height - 8, `${upgrade.name} is inside its panel`);
      assert.match(rows[row], /Lv\.00/);
      return row;
    });
    assert.deepEqual([...upgradeRows].sort((a, b) => a - b), upgradeRows);
    assert.match(rows[upgradeRows[0] + 1], /\+0\.8\/s/, 'fractional drone production is not rounded to zero');
    assert.match(rows[upgradeRows[4] + 1], /7,500 ✦.*\+400\/s/);
    const automationRow = rows.findIndex(row => row.includes('[A] 자동'));
    const prestigeRow = rows.findIndex(row => row.includes('[R] 승천'));
    assert.ok(automationRow > upgradeRows[4] + 1, 'automation footer follows the fifth upgrade price');
    assert.equal(prestigeRow, automationRow + 1);
    assert.ok(prestigeRow < height - 8, 'prestige footer remains above panel border');
    assert.equal(rows[height - 7].trim(), '', 'no panel content spills into the log margin');
    assert.match(rows[height - 6], /SIGNAL.*연결 정상/);
    assert.match(rows[height - 2], /\[1–5\].*\[SPACE\].*\[A\].*\[P\].*\[\?\].*\[Q\] 종료/);
  });
}

test('time advances animation in the scene without mutating game data or moving UI labels', () => {
  const game = createGame(0);
  game.levels = [4, 3, 2, 1, 1];
  const saved = structuredClone(game);
  const first = renderGame(game, ui({ time: 0 }), 110, 38);
  const second = renderGame(game, ui({ time: 1 }), 110, 38);
  const a = first.plain().split('\n');
  const b = second.plain().split('\n');
  assert.notEqual(first.plain(), second.plain(), 'animation changes actual characters as well as colors');
  const workshopX = columns(a[5]).findIndex((cell, index) => index > 2 && cell === '┌');
  assert.equal(rectangle(a, workshopX, 5, 110 - workshopX, 26), rectangle(b, workshopX, 5, 110 - workshopX, 26));
  assert.deepEqual(a.slice(0, 5), b.slice(0, 5));
  assert.deepEqual(a.slice(31), b.slice(31));
  assert.deepEqual(game, saved, 'rendering is a pure view of the economy');
  assert.ok(second.render(first).length > 0);
});

test('help modal is opaque over animation and contains controls and return instruction', () => {
  const game = createGame(0);
  game.levels = [5, 5, 5, 5, 5];
  const a = renderGame(game, ui({ help: true, time: 0 }), 88, 32).plain().split('\n');
  const b = renderGame(game, ui({ help: true, time: 1 }), 88, 32).plain().split('\n');
  const modal = rectangle(a, 8, 9, 72, 14);
  assert.equal(modal, rectangle(b, 8, 9, 72, 14), 'animated scene cannot bleed into modal');
  assert.match(modal, /FLIGHT MANUAL \/ 플레이 안내/);
  assert.match(modal, /SPACE 별빛 수집/);
  assert.match(modal, /ESC 또는 \? 키를 누르면 돌아갑니다\./);
  assert.ok(!modal.includes('ORBITAL WORKSHOP'));
});

test('prestige confirmation is painted above help and shows the permanent multiplier change', () => {
  const game = createGame(0);
  game.prestigeCount = 2;
  const normal = renderGame(game, ui({ confirmPrestige: true }), 110, 38).plain().split('\n');
  const stacked = renderGame(game, ui({ help: true, confirmPrestige: true }), 110, 38).plain().split('\n');
  const modal = rectangle(normal, 19, 14, 72, 10);
  assert.equal(modal, rectangle(stacked, 19, 14, 72, 10));
  assert.match(modal, /ASCENSION \/ 별자리 승천/);
  assert.match(modal, /×2\.0 → ×2\.5/);
  assert.match(modal, /\[Y\] 승천하기.*\[N \/ ESC\] 취소/);
});

test('small terminals show resize guidance and current production without breaking row widths', () => {
  const frame = renderGame(createGame(0), ui(), 70, 24);
  const text = frame.plain();
  assert.match(text, /88열 × 32행/);
  assert.match(text, /별가루 25/);
  assert.match(text, /Q 저장 후 종료/);
  assert.ok(!text.includes('ORBITAL WORKSHOP'));
  text.split('\n').forEach(row => assert.equal(displayWidth(row), 70));
});

test('currency formatting keeps large values compact and readable', () => {
  assert.equal(number(7500), '7,500');
  assert.equal(number(25_000), '25.0K');
  assert.equal(number(1_234_000), '1.23M');
  assert.equal(number(1e9), '1.00B');
  assert.equal(number(1e12), '1.00T');
});
