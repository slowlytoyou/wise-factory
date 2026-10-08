import test from 'node:test';
import assert from 'node:assert/strict';
import { createFactory, RECIPES } from '../src/factory.mjs';
import { renderFactory, factoryViewport, formatPlayTime } from '../src/factory-render.mjs';
import { SKINS, skinText } from '../src/skins.mjs';
import { displayWidth } from '../src/terminal.mjs';

const graphemes = new Intl.Segmenter('ko', { granularity: 'grapheme' });
const cells = line => [...graphemes.segment(line)].flatMap(({ segment }) => [segment, ...Array(Math.max(0, displayWidth(segment) - 1)).fill('')]);
function rectangle(canvas, x, y, width, height) {
  return canvas.plain().split('\n').slice(y, y + height).map(row => cells(row).slice(x, x + width).join('')).join('\n');
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const modes = [
  {}, { help: true }, { shop: true }, { recipes: true }, { prestige: true },
  { leaderboard: true }, { nicknameEditor: true, nicknameDraft: '철광석공장' }, { skinPicker: true, skinIndex: 2 },
  { leaderboard: true, cloud: { status: 'online', nickname: '철광석' }, leaders: [{ rank: 1, nickname: '공장', score: 300, goldPerSecond: 2 }], myRank: { rank: 1, nickname: '공장', score: 300, goldPerSecond: 2 } },
];

for (const skin of SKINS) for (const [width, height] of [[88, 30], [100, 36], [120, 40], [160, 50]]) {
  test(`${skin.name} ${width}×${height} keeps every panel bounded and all main controls visible`, () => {
    const game = freeze(createFactory(0, { demo: true }));
    for (const mode of modes) {
      const ui = freeze({ skin: skin.id, time: 1.6, ...mode });
      const canvas = renderFactory(game, ui, width, height);
      const rows = canvas.plain().split('\n');
      assert.equal(rows.length, height);
      rows.forEach((line, index) => assert.equal(displayWidth(line), width, `${JSON.stringify(mode)} row ${index}`));
    }
    const footer = renderFactory(game, { skin: skin.id }, width, height).plain().split('\n').slice(-3).join('\n');
    for (const key of ['[WASD]', '[1–5]', '[E/SPACE]', '[R]', '[U]', '[X]', '[K]', '[B]', '[T]', '[F]', '[C]', '[L]', '[N]', '[P]', '[?]', '[Q]']) assert.ok(footer.includes(key), `${key} must remain visible`);
  });
}

test('work skins use a distinct static map, row numbers and workspace chrome without decorative animations', () => {
  const game = freeze(createFactory(0, { demo: true }));
  const view = factoryViewport(game);
  const original = renderFactory(game, { skin: 'original', time: 0 });
  for (const skin of ['work', 'work-dev']) {
    const before = renderFactory(game, { skin, time: 0 });
    const after = renderFactory(game, { skin, time: 7.1, effects: [{ x: 11, y: 12, time: 7 }] });
    assert.equal(before.render(), after.render(), 'time and particles must not animate a work screen');
    const map = rectangle(before, view.x, view.y, view.columns * 2, view.rows);
    assert.notEqual(map, rectangle(original, view.x, view.y, view.columns * 2, view.rows));
    assert.doesNotMatch(map, /[✦✧✣✥✢░▪▥▤▦◌◉◎]/u);
    assert.match(map, /@>/);
    assert.match(map, skin === 'work' ? /M\$/ : /R\$/);
    assert.match(before.plain().split('\n')[0], /workspace.*map\.grid.*inspector/);
    assert.equal(rectangle(before, 0, view.y, 2, 3), '00\n01\n02');
  }
  assert.notEqual(original.render(), renderFactory(game, { skin: 'original', time: 7.1 }).render());
});

test('skin selection does not mutate state or leak its palette and vocabulary into later renders', () => {
  const game = freeze(createFactory(0, { demo: true }));
  const ui = freeze({ selected: 'smelter', recipe: 'glass', time: 2.3 });
  const before = renderFactory(game, ui).render();
  renderFactory(game, { ...ui, skin: 'work-dev', recipes: true });
  renderFactory(game, { ...ui, skin: 'work', skinPicker: true });
  assert.equal(renderFactory(game, ui).render(), before);
  assert.equal(renderFactory(game, { ...ui, skin: 'unknown' }).render(), before);
});

test('Work Skin retains game terminology while Work Dev translates recipe, shop, prestige and report copy', () => {
  const game = createFactory(0, { demo: true });
  game.nickname = 'Tester';
  const work = renderFactory(game, { skin: 'work', selected: 'smelter' }).plain();
  assert.match(work, /채굴기/);
  assert.match(work, /컨베이어/);
  assert.match(work, /용광로/);
  assert.match(work, /OH 코어/);
  const dev = renderFactory(game, { skin: 'work-dev', selected: 'smelter' }).plain();
  assert.match(dev, /WISE WORKSPACE/);
  assert.match(dev, /수집기/);
  assert.match(dev, /파이프라인/);
  assert.match(dev, /빌드 워커/);
  assert.match(dev, /설계 포인트/);
  for (const recipeIndex of [0, 7, Object.keys(RECIPES).length - 1]) {
    const recipe = Object.values(RECIPES)[recipeIndex];
    const output = renderFactory(game, { skin: 'work-dev', recipes: true, recipeIndex }).plain();
    assert.ok(output.includes(skinText(recipe.name, 'work-dev')));
  }
  assert.match(renderFactory(game, { skin: 'work-dev', shop: true }).plain(), /빌드 워커 명세/);
  assert.match(renderFactory(game, { skin: 'work-dev', prestige: true }).plain(), /리팩터링/);
  const leaderboard = renderFactory(game, { skin: 'work-dev', leaderboard: true, cloud: { status: 'online' } }).plain();
  assert.match(leaderboard, /월간 배포 리포트/);
  assert.match(leaderboard, /실시간 크레딧\/초 = 최근 60초 배포액 ÷ 60/);
  assert.match(leaderboard, /3초 자동 갱신/);
  assert.match(leaderboard, /매월 1일 00:00/);
});

test('nickname display, draft, rankings and nickname logs retain exact user text in Dev mode', () => {
  const game = createFactory(0);
  game.nickname = '철광석공장';
  assert.match(renderFactory(game, { skin: 'work-dev' }).plain(), /\[N\] 철광석공장/);
  const draft = renderFactory(game, { skin: 'work-dev', nicknameEditor: true, nicknameDraft: '별빛공장 철광석' }).plain();
  assert.match(draft, /현재 이름  철광석공장/);
  assert.match(draft, /> 별빛공장 철광석/);
  const rank = renderFactory(game, { skin: 'work-dev', leaderboard: true, cloud: { status: 'online', nickname: '철광석' }, leaders: [{ rank: 1, nickname: '채굴기', score: 1 }], myRank: { rank: 1, nickname: '공장', score: 1 } }).plain();
  assert.match(rank, /1   채굴기/);
  assert.match(rank, /내 프로젝트 #1  공장/);
  for (const prefix of ['닉네임 저장 완료 · ', '데모 닉네임 · ']) {
    const log = renderFactory(game, { skin: 'work-dev', logs: [`${prefix}철광석`] }).plain();
    assert.match(log, /닉네임.*· 철광석/);
  }
  const cloud = renderFactory(game, { skin: 'work-dev', cloud: { status: 'online', nickname: '철광석공장' } }).plain();
  assert.match(cloud.split('\n')[33], /철광석공장/);
});

test('all leaderboard skins show total playtime and own rank outside the top ten at minimum width', () => {
  const game = freeze(createFactory(0));
  const leaders = Array.from({ length: 10 }, (_, index) => ({ rank: index + 1, nickname: `채굴기${index}공장`.repeat(4), score: 12000 - index, goldPerSecond: 12.34, playSeconds: index === 9 ? Number.MAX_SAFE_INTEGER : 90061 + index }));
  const myRank = { rank: 234, nickname: '채굴기공장개발자'.repeat(3), score: 456, goldPerSecond: 0.5, playSeconds: 444444443 };
  for (const skin of SKINS) {
    const text = renderFactory(game, freeze({ skin: skin.id, leaderboard: true, cloud: { status: 'online' }, leaders, myRank }), 88, 30).plain();
    const rows = text.split('\n');
    assert.match(text, new RegExp(`${skinText('총 플레이 시간', skin.id)} ${formatPlayTime(myRank.playSeconds)}`));
    assert.ok(text.includes(skinText('월간 초기화·환생에도 유지', skin.id)));
    assert.match(text, /#234/);
    assert.ok(text.includes('채굴기공장'), 'own nickname remains untranslated');
    leaders.forEach((entry, index) => {
      const row = rows[10 + index];
      assert.ok(row.includes(`채굴기${index}공장`), `row ${index} nickname remains visible`);
      assert.ok(row.includes(formatPlayTime(entry.playSeconds)), `row ${index} complete playtime remains visible`);
      assert.match(row, /12\.34/);
      assert.match(row, /12\.0K/);
    });
    rows.forEach(row => assert.equal(displayWidth(row), 88));
  }
});

test('error paths remain exact and translated labels fit before clipping', () => {
  const game = createFactory(0, { demo: true });
  const path = '/Users/공장/철광석.json';
  assert.ok(renderFactory(game, { skin: 'work-dev', saveError: `저장 오류 ${path}` }).plain().includes(path));
  assert.ok(renderFactory(game, { skin: 'work-dev', logs: [`저장 오류 ${path}`] }).plain().includes(path));
  const plain = renderFactory(game, { skin: 'work-dev' }, 120, 40).plain();
  assert.match(plain, /연산 자원 2.*테스트 케이스 1/);
  assert.match(plain, /개인 세션/);
  assert.match(plain, /R 패키지 저장소/);
});

test('skin picker remains visible after a terminal resize and reports the active and selected modes', () => {
  const game = createFactory(0);
  for (const [width, height] of [[40, 18], [80, 24], [88, 30], [120, 40]]) {
    const plain = renderFactory(game, { skin: 'work', skinPicker: true, skinIndex: 2 }, width, height).plain();
    assert.match(plain, /APPEARANCE/);
    assert.match(plain, /Original Skin/);
    assert.match(plain, /> 3 .*Work Skin.*Dev/);
    assert.match(plain, /Work Skin.*(?:ACTIVE|\*)/);
    assert.match(plain, /ENTER/);
    assert.match(plain, /ESC\/K/);
  }
});
