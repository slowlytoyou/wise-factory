import test from 'node:test';
import assert from 'node:assert/strict';
import { createFactory, advanceFactory, applyAction, ITEMS, BUILDINGS, RECIPES, WORLD_WIDTH, WORLD_HEIGHT, upgradeCost, shopOffers } from '../src/factory.mjs';
import { renderFactory, factoryViewport, formatNumber, catalogPageSize, formatGoldRate, formatPlayTime } from '../src/factory-render.mjs';
import { displayWidth } from '../src/terminal.mjs';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const ui = overrides => ({ time: 0, selected: 'belt', direction: 1, recipe: 'iron_plate', logs: ['공장이 가동 중입니다.'], cloud: { status: 'local' }, ...overrides });

function columns(line) {
  return [...segmenter.segment(line)].flatMap(({ segment }) => [segment, ...Array(Math.max(0, displayWidth(segment) - 1)).fill('')]);
}

function rectangle(canvas, x, y, width, height) {
  const rows = typeof canvas === 'string' ? canvas.split('\n') : canvas.plain().split('\n');
  return rows.slice(y, y + height).map(row => columns(row).slice(x, x + width).join('')).join('\n');
}

function tile(canvas, view, x, y) {
  return rectangle(canvas, view.x + (x - view.left) * 2, view.y + y - view.top, 2, 1);
}

function styledTile(canvas, view, x, y) {
  const column = view.x + (x - view.left) * 2;
  const row = view.y + y - view.top;
  const rendered = canvas.render().split(`\x1b[${row + 1};1H`)[1].split(/\x1b\[\d+;1H/)[0];
  const cells = [];
  let fg, bg;
  for (const match of rendered.matchAll(/\x1b\[([\d;]+)m|([^\x1b]+)/g)) {
    if (match[1]) {
      const codes = match[1].split(';').map(Number);
      for (let i = 0; i < codes.length; i += 5) {
        const color = codes.slice(i + 2, i + 5).join(';');
        if (codes[i] === 38) fg = color;
        if (codes[i] === 48) bg = color;
      }
    } else for (const glyph of columns(match[2])) cells.push({ glyph, fg, bg });
  }
  return cells.slice(column, column + 2);
}

function frozen(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}

for (const [width, height] of [[88, 30], [100, 36], [120, 40], [160, 50]]) {
  test(`factory ${width}×${height} preserves Korean column widths, inspector, and every control`, () => {
    const game = createFactory(0, { demo: true });
    const canvas = renderFactory(game, ui(), width, height);
    const rows = canvas.plain().split('\n');
    assert.equal(canvas.width, width);
    assert.equal(canvas.height, height);
    assert.equal(rows.length, height);
    rows.forEach((row, y) => assert.equal(displayWidth(row), width, `row ${y}`));
    assert.match(rows[1], /WISE FACTORY/);
    assert.match(rows[3], /자금.*누적 판매/);
    const view = factoryViewport(game, width, height);
    const sidebar = rectangle(canvas, view.sidebarX, 4, view.sidebarWidth, height - 9);
    for (const type of ['miner', 'belt', 'smelter', 'assembler', 'transmitter']) assert.ok(sidebar.includes(BUILDINGS[type].name));
    assert.match(sidebar, /철광석 ×2/);
    assert.match(sidebar, /철판 ×1.*₵8/);
    assert.match(sidebar, /LOCAL/);
    assert.match(canvas.plain(), /M 중앙 상인/);
    assert.match(rectangle(canvas, view.x, view.y, view.columns * 2, view.rows), /M\$/);
    const footer = rows.slice(height - 3).join('\n');
    for (const key of ['[WASD]', '[1–5]', '[E/SPACE]', '[R]', '[U]', '[X]', '[F]', '[C]', '[L]', '[B]', '[T]', '[N]', '[P]', '[?]', '[Q]']) assert.ok(footer.includes(key), `${key} remains visible`);
    assert.match(rows[2], /회차.*환생.*코어.*판매 ×1\.00/);
    assert.match(rows[height - 4], /공장이 가동 중입니다\./);
  });
}

test('camera follows cursor and clamps all four map edges without losing the cursor', () => {
  const game = createFactory(0);
  for (const position of [{ x: 0, y: 0 }, { x: WORLD_WIDTH - 1, y: 0 }, { x: 0, y: WORLD_HEIGHT - 1 }, { x: WORLD_WIDTH - 1, y: WORLD_HEIGHT - 1 }, { x: 20, y: 14 }]) {
    game.player = position;
    const view = factoryViewport(game, 88, 30);
    assert.ok(view.left >= 0 && view.top >= 0);
    assert.ok(view.left + view.columns <= WORLD_WIDTH && view.top + view.rows <= WORLD_HEIGHT);
    assert.ok(position.x >= view.left && position.x < view.left + view.columns);
    assert.ok(position.y >= view.top && position.y < view.top + view.rows);
    assert.match(tile(renderFactory(game, ui(), 88, 30), view, position.x, position.y), /@→/);
  }
  const full = factoryViewport(game, 120, 40);
  assert.equal(full.left, 0);
  assert.equal(full.top, 0);
  assert.equal(full.columns, WORLD_WIDTH);
  assert.equal(full.rows, WORLD_HEIGHT);
});

test('cursor remains visibly @ at every animation phase and demo never claims it saves', () => {
  const game = createFactory(0, { demo: true });
  const view = factoryViewport(game);
  for (const time of [0, .6, 1.1]) {
    const canvas = renderFactory(game, ui({ time, demo: true }));
    assert.equal(tile(canvas, view, game.player.x, game.player.y), '@→');
    assert.ok(!canvas.plain().includes('기기에 자동 저장'));
    assert.match(canvas.plain(), /DEMO · 진행 상황 저장 안 함/);
  }
});

test('occupied belt glyphs and colors stay fixed across time and pause states in all four directions', () => {
  const game = createFactory(0);
  const belt = game.buildings.find(building => building.type === 'belt');
  const view = factoryViewport(game, 120, 40);
  belt.item = 'circuit';
  const glyph = ITEMS.circuit.glyph;
  for (const [dir, expected] of [[0, `↑${glyph}`], [1, `→${glyph}`], [2, `↓${glyph}`], [3, `${glyph}←`]]) {
    belt.dir = dir;
    const reference = styledTile(renderFactory(game, ui()), view, belt.x, belt.y);
    for (const level of [1, 5]) for (const paused of [false, true]) for (const time of [0, .05, .17, .34, .5, .99, 1, 1.01, 4, 15, 60, 300]) {
      belt.level = level;
      const canvas = renderFactory(game, ui({ time, paused }));
      assert.equal(tile(canvas, view, belt.x, belt.y), expected);
      assert.deepEqual(styledTile(canvas, view, belt.x, belt.y), reference, `direction ${dir}, level ${level}, paused ${paused}, time ${time}`);
    }
    assert.equal(reference.find(cell => cell.glyph === glyph).fg, ITEMS.circuit.color.join(';'));
  }
  belt.item = null;
  for (const dir of [0, 1, 2, 3]) {
    belt.dir = dir;
    const reference = tile(renderFactory(game, ui()), view, belt.x, belt.y);
    for (const time of [0, .17, .34, .5, 15, 60]) {
      const glyphs = tile(renderFactory(game, ui({ time })), view, belt.x, belt.y);
      assert.equal(glyphs, reference, 'empty tread may change color, but never slides like cargo');
      assert.ok(!glyphs.includes(glyph), 'empty belts never invent an item');
    }
  }
});

test('a blocked full conveyor shows one stationary cargo on every tile as the simulation advances', () => {
  const game = createFactory(0);
  game.buildings = [];
  for (let x = 7; x <= 16; x++) {
    assert.ok(applyAction(game, { type: 'build', building: 'belt', x, y: 7, dir: 1 }).ok);
    game.buildings.at(-1).item = 'iron_ore';
  }
  const view = factoryViewport(game);
  const first = renderFactory(game, ui());
  const references = game.buildings.map(belt => styledTile(first, view, belt.x, belt.y));
  for (const seconds of [1, 5, 30]) {
    advanceFactory(game, seconds);
    for (const paused of [false, true]) for (const time of [0, .17, .5, 1, 9, 60]) {
      const canvas = renderFactory(game, ui({ time, paused }));
      game.buildings.forEach((belt, i) => {
        assert.equal(belt.item, 'iron_ore');
        assert.equal(tile(canvas, view, belt.x, belt.y), `→${ITEMS.iron_ore.glyph}`);
        assert.deepEqual(styledTile(canvas, view, belt.x, belt.y), references[i]);
      });
    }
  }
});

test('cargo changes tile only on an engine transfer, then stays still at the blocked output', () => {
  for (const [dir, dx, dy] of [[0, 0, -1], [1, 1, 0], [2, 0, 1], [3, -1, 0]]) {
    const game = createFactory(0);
    game.buildings = [];
    for (let i = 0; i < 3; i++) assert.ok(applyAction(game, { type: 'build', building: 'belt', x: 10 + dx * i, y: 7 + dy * i, dir }).ok);
    game.buildings[0].item = 'circuit';
    const view = factoryViewport(game);
    const visibleCargo = time => {
      const canvas = renderFactory(game, ui({ time }));
      return game.buildings.map(belt => tile(canvas, view, belt.x, belt.y).includes(ITEMS.circuit.glyph));
    };
    for (const time of [0, .5, 1, 60]) assert.deepEqual(visibleCargo(time), [true, false, false]);
    advanceFactory(game, .5);
    assert.deepEqual(visibleCargo(90), [true, false, false]);
    advanceFactory(game, .5);
    for (const time of [0, .5, 1, 60]) assert.deepEqual(visibleCargo(time), [false, true, false]);
    advanceFactory(game, 1);
    for (const time of [0, .5, 1, 60]) assert.deepEqual(visibleCargo(time), [false, false, true]);
    advanceFactory(game, 10);
    assert.deepEqual(visibleCargo(90), [false, false, true]);
  }
});

test('belt inspector reports its authoritative single cargo slot as full or empty', () => {
  const game = createFactory(0);
  assert.match(renderFactory(game, ui(), 88, 30).plain(), /뒤·옆에서 입력 · 화살표로 배출/);
  const belt = game.buildings.find(building => building.type === 'belt');
  game.player = { x: belt.x, y: belt.y };
  const view = factoryViewport(game, 88, 30);
  belt.item = 'circuit';
  const occupied = rectangle(renderFactory(game, ui(), 88, 30), view.sidebarX, 4, view.sidebarWidth, 21);
  assert.ok(occupied.includes(`적재 ${ITEMS.circuit.glyph} 회로 1/1`));
  assert.ok(!occupied.includes('보관 비어 있음'));
  belt.item = null;
  const empty = rectangle(renderFactory(game, ui(), 88, 30), view.sidebarX, 4, view.sidebarWidth, 21);
  assert.match(empty, /적재 0\/1 · 비어 있음/);
});

test('inspector shows hovered machine level, authoritative cost, all buffers, and its recipe', () => {
  const game = createFactory(0, { demo: true });
  const machine = game.buildings.find(building => building.type === 'assembler');
  machine.recipe = 'engine';
  machine.level = 2;
  machine.buffer = { steel: 2, gear: 3, circuit: 1 };
  machine.item = 'engine';
  game.player = { x: machine.x, y: machine.y };
  const view = factoryViewport(game);
  const sidebar = rectangle(renderFactory(game, ui({ recipe: 'iron_plate' })), view.sidebarX, 4, view.sidebarWidth, 30);
  assert.match(sidebar, /조립기.*Lv\.2/);
  assert.ok(sidebar.includes(`강화 ₵${formatNumber(upgradeCost(machine))}`));
  for (const [id, count] of Object.entries(machine.buffer)) assert.ok(sidebar.includes(`${ITEMS[id].glyph}×${count}`));
  assert.ok(sidebar.includes(`출구 ${ITEMS.engine.glyph}`));
  assert.match(sidebar, /엔진 조립/);
  assert.match(sidebar, /강철 ×2 \+ 기어 ×2 \+ 회로 ×1/);
  assert.match(sidebar, /엔진 ×1.*₵190/);
});

test('animation changes the world without mutating state, UI, or stationary information', () => {
  const game = createFactory(0, { demo: true });
  advanceFactory(game, 12);
  frozen(game);
  const firstUi = frozen(ui({ time: .1 }));
  const secondUi = frozen(ui({ time: 1.4 }));
  const a = renderFactory(game, firstUi);
  const b = renderFactory(game, secondUi);
  const view = factoryViewport(game);
  assert.notEqual(rectangle(a, view.x, view.y, view.columns * 2, view.rows), rectangle(b, view.x, view.y, view.columns * 2, view.rows));
  assert.equal(rectangle(a, 0, 0, 120, 5), rectangle(b, 0, 0, 120, 5));
  assert.equal(rectangle(a, view.sidebarX, 4, view.sidebarWidth, 30), rectangle(b, view.sidebarX, 4, view.sidebarWidth, 30));
  assert.equal(rectangle(a, 0, 35, 120, 5), rectangle(b, 0, 35, 120, 5));
  assert.ok(b.render(a).length > 0);
});

test('temporary rate limits keep the cloud mode visible with automatic retry guidance', () => {
  const game = createFactory(0);
  const screen = renderFactory(game, ui({ cloud: { status: 'rate_limited', message: '잠시 후 자동 재시도합니다.' } }), 120, 40).plain();
  assert.match(screen, /CLOUD PLAY/);
  assert.match(screen, /자동 재시도/);
  assert.ok(!screen.includes('LOCAL PLAY'));
  assert.ok(!screen.includes('기기에 자동 저장'));
});

test('help is an opaque modal with construction, factory, cloud-pause, and exit instructions', () => {
  const game = createFactory(0, { demo: true });
  const a = renderFactory(game, ui({ time: 0, help: true, cloud: { status: 'online' } }), 88, 30);
  const b = renderFactory(game, ui({ time: 1.4, help: true, cloud: { status: 'online' } }), 88, 30);
  const modal = rectangle(a, 4, 3, 80, 24);
  assert.equal(modal, rectangle(b, 4, 3, 80, 24));
  for (const fragment of ['FIELD MANUAL', 'WASD', 'E / SPACE', 'R ', 'U / X', 'F ', 'C / L', 'B ', 'T ', '3 / 4 / 5', 'P / Q', '실행·연결 중에만 생산', 'P는 화면만 정지', '[ESC / ?]']) assert.ok(modal.includes(fragment), fragment);
  assert.match(modal, /벨트는 뒤·옆 입력 · 가공 설비는 모든 방향 입력/);
});

test('recipe atlas pages through every recipe with complete ingredients and prices at all supported heights', () => {
  const game = createFactory(0);
  const recipes = Object.entries(RECIPES);
  for (const [width, height] of [[88, 30], [120, 40], [160, 50]]) {
    const size = catalogPageSize(height);
    const pages = [];
    for (let index = 0; index < recipes.length; index += size) {
      const text = renderFactory(game, ui({ recipes: true, recipeIndex: index }), width, height).plain();
      pages.push(text);
      assert.match(text, /\[W\/S ↑↓\].*\[A\/D ←→\].*\[ENTER\]/);
      assert.match(text, /\[ESC \/ C\]/);
      for (const [, recipe] of recipes.slice(index, index + size)) {
        assert.ok(text.includes(recipe.name), recipe.name);
        for (const [id, count] of Object.entries(recipe.inputs)) assert.ok(text.includes(`${ITEMS[id].name} ×${count}`), `${recipe.name}: ${id}`);
        assert.ok(text.includes(`${ITEMS[recipe.output].name} ×${recipe.amount ?? 1}`));
        assert.ok(text.includes(`₵${formatNumber(ITEMS[recipe.output].price)}`));
      }
      text.split('\n').forEach(row => assert.equal(displayWidth(row), width));
    }
    assert.equal(new Set(pages).size, Math.ceil(recipes.length / size));
    const last = renderFactory(game, ui({ recipes: true, recipeIndex: recipes.length - 1 }), width, height).plain();
    assert.match(last, new RegExp(`› ${recipes.at(-1)[1].name}`));
  }
});

test('leaderboard shows server entries and own rank, clips nicknames, and strips terminal controls', () => {
  const game = createFactory(0);
  const canvas = renderFactory(game, ui({ leaderboard: true, cloud: { status: 'online' }, leaders: [{ rank: 1, nickname: '\x1b[2J한국의아주긴공장이름'.repeat(8), score: 12000, goldPerSecond: 12.34 }, { rank: 2, nickname: '톱니 공방', score: 950, goldPerSecond: 0.5 }], myRank: { rank: 2, nickname: '톱니 공방', score: 950, goldPerSecond: 0.5 }, leaderboardMonth: '2026-10' }), 88, 30);
  const text = canvas.plain();
  assert.match(text, /MERCHANT GUILD/);
  assert.match(text, /2026-10.*이번 달/);
  assert.match(text, /실시간 골드\/초 = 최근 60초 판매액 ÷ 60/);
  assert.match(text, /3초 자동 갱신/);
  assert.doesNotMatch(text, /월간 판매액 ÷ 생산 반영 시간/);
  assert.match(text, /매월 1일 00:00 \(한국 시간\) 점수 초기화/);
  assert.match(text, /공장과 OH 코어는 유지/);
  assert.match(text, /12\.34/);
  assert.match(text, /0\.5 골드\/초/);
  assert.match(text, /₵12\.0K/);
  assert.match(text, /내 공장.*#2.*톱니 공방.*₵950/);
  assert.match(text, /\[ESC \/ L\]/);
  assert.ok(!text.includes('\x1b'));
  text.split('\n').forEach(row => assert.equal(displayWidth(row), 88));
  const waiting = renderFactory(game, ui({ leaderboard: true, cloud: { status: 'offline' } })).plain();
  assert.match(waiting, /서버에 연결되면 공식 순위/);
  assert.match(waiting, /\[G\] 서버 연결 다시 시도/);
  assert.ok(!waiting.includes('Supabase 설정'));
  assert.match(waiting, /갱신 지연/);
  const stale = renderFactory(game, ui({ leaderboard: true, cloud: { status: 'online' }, leaders: [{ nickname: '공장주', score: 12, goldPerSecond: 1 }], leaderboardStale: true, leaderboardStatus: '갱신 지연 · 최신 저장을 확인하지 못했습니다.' }), 88, 30).plain();
  assert.match(stale, /갱신 지연 · 최신 저장을 확인하지 못했습니다/);
  assert.doesNotMatch(stale, /최신 서버 기록/);
});

test('monthly leaderboard safely displays zero and missing rates without NaN or stale lifetime labels', () => {
  const game = createFactory(0);
  for (const rate of [undefined, null, 0, NaN, Infinity, -2]) {
    const text = renderFactory(game, ui({ leaderboard: true, cloud: { status: 'online' }, leaders: [{ nickname: '첫 공장', score: 0, goldPerSecond: rate }], myRank: { rank: 1, nickname: '첫 공장', score: 0, goldPerSecond: rate } }), 88, 30).plain();
    assert.match(text, /₵0.*0 골드\/초/);
    assert.ok(!text.includes('NaN') && !text.includes('Infinity'));
    assert.ok(!text.includes('검증한 누적 판매액'));
    assert.equal(formatGoldRate(rate), '0');
  }
});

test('playtime formatting retains total hours, floors partial seconds and safely handles invalid values', () => {
  for (const value of [undefined, null, NaN, Infinity, -Infinity, -1, '3600', {}, []]) assert.equal(formatPlayTime(value), '0:00:00');
  for (const [seconds, expected] of [[0, '0:00:00'], [59.99, '0:00:59'], [60, '0:01:00'], [3600, '1:00:00'], [90061, '25:01:01'], [444444443, '123456:47:23'], [Number.MAX_SAFE_INTEGER, '2501999792983:36:31']]) {
    assert.equal(formatPlayTime(seconds), expected);
  }
  assert.equal(formatPlayTime(Number.MAX_VALUE), formatPlayTime(Number.MAX_SAFE_INTEGER));
});

test('local play and demo stay visibly distinct from every cloud connection status', () => {
  const game = createFactory(0);
  const local = renderFactory(game, ui(), 88, 30).plain();
  assert.match(local.split('\n')[1], /LOCAL PLAY · 개인 플레이/);
  assert.match(local, /개인 플레이 · 계정 없이 이용/);
  assert.match(local, /\[L\] 내 기록/);
  assert.ok(!local.includes('FACTORY ONLINE'));
  for (const [status, label] of [['online', '서버 저장 연결됨'], ['connecting', '연결 중'], ['offline', '연결 대기'], ['error', '연결 확인 필요']]) {
    const cloud = renderFactory(game, ui({ cloud: { status } }), 88, 30).plain();
    assert.match(cloud.split('\n')[1], new RegExp(`CLOUD PLAY · ${label}`));
    assert.match(cloud, /\[L\] 순위/);
    assert.ok(!cloud.includes('LOCAL PLAY'));
    cloud.split('\n').forEach(row => assert.equal(displayWidth(row), 88));
  }
  const demo = renderFactory(game, ui({ demo: true, cloud: { status: 'online' } }), 88, 30).plain();
  assert.match(demo.split('\n')[1], /DEMO · 저장 안 함/);
  assert.ok(!demo.includes('CLOUD'));
  assert.match(renderFactory(game, ui({ paused: true })).plain().split('\n')[1], /LOCAL PLAY · 일시 정지/);
});

test('personal records show only this factory, including prestige and save status, without account prompts', () => {
  const game = createFactory(0);
  game.lifetimeRevenue = 12345;
  game.progression.runRevenue = 2345;
  game.soldCount = 456;
  game.progression.prestigeCount = 2;
  game.progression.cores = 3;
  frozen(game);
  const state = frozen(ui({ leaderboard: true, leaders: [{ rank: 1, nickname: 'REMOTE_FACTORY', score: 999999 }], myRank: { rank: 1, nickname: 'REMOTE_FACTORY', score: 999999 }, cloud: { status: 'local', message: 'Supabase 설정 후 계정 연결' } }));
  for (const [width, height] of [[88, 30], [120, 40]]) {
    const text = renderFactory(game, state, width, height).plain();
    for (const fragment of ['LOCAL RECORD / 내 공장 기록', '누적 판매액  ₵12.3K', '이번 회차 판매액  ₵2,345', '판매한 물품  456개', `현재 설비  ${game.buildings.length}개`, '환생  2회', 'OH 코어  3개', '판매 배율 ×1.75', '이 기기에 자동 저장', '[ESC / L]']) assert.ok(text.includes(fragment), fragment);
    for (const fragment of ['REMOTE_FACTORY', '리더보드', 'Supabase', '--cloud', '계정을 연결', '로그인']) assert.ok(!text.includes(fragment), fragment);
    text.split('\n').forEach(row => assert.equal(displayWidth(row), width));
  }
  const first = renderFactory(game, { ...state, time: 0 }, 88, 30);
  const later = renderFactory(game, { ...state, time: 1.4 }, 88, 30);
  assert.equal(rectangle(first, 4, 3, 80, 24), rectangle(later, 4, 3, 80, 24));
  const failedSave = renderFactory(game, { ...state, saveError: '파일 쓰기 실패' }, 88, 30).plain();
  assert.match(failedSave, /저장 오류 · 파일 쓰기 실패/);
  assert.ok(!failedSave.includes('기기에 자동 저장'));
  const demo = renderFactory(game, { ...state, demo: true }, 88, 30).plain();
  assert.match(demo, /DEMO RECORD \/ 데모 공장 기록/);
  assert.match(demo, /데모 · 진행 상황 저장 안 함/);
  assert.ok(!demo.includes('기기에 자동 저장'));
});

test('local help labels personal records without suggesting cloud login', () => {
  const help = renderFactory(createFactory(0), ui({ help: true }), 88, 30).plain();
  assert.match(help, /C \/ L.*생산 도감 \/ 내 기록/);
  assert.match(help, /개인 플레이 · 자동 저장/);
  assert.match(help, /N .*닉네임 설정 · Enter 저장 · Esc 취소/);
  assert.ok(!help.includes('클라우드'));
});

test('nickname controls and the correct mode-specific name remain visible without overlapping the map header', () => {
  const game = createFactory(0);
  game.nickname = '우리 공장';
  for (const [width, height] of [[88, 30], [120, 40]]) {
    const local = renderFactory(game, ui({ cloud: { status: 'local', nickname: '외부 이름' } }), width, height).plain();
    assert.match(local.split('\n')[4], /\[N\] 우리 공장.*M 중앙 상인/);
    assert.ok(!local.includes('외부 이름'));
    assert.match(local.split('\n')[height - 2], /\[N\] 이름.*\[Q\] 종료/);
    const cloud = renderFactory(game, ui({ cloud: { status: 'online', nickname: '온라인 공장' } }), width, height).plain();
    assert.match(cloud.split('\n')[4], /\[N\] 온라인 공장.*M 중앙 상인/);
    const longName = renderFactory(game, ui({ cloud: { status: 'online', nickname: '가'.repeat(20) } }), width, height).plain();
    assert.match(longName.split('\n')[4], /M 중앙 상인.*BUILD \/ 생산 설비/);
    for (const text of [local, cloud, longName]) text.split('\n').forEach(row => assert.equal(displayWidth(row), width));
    const records = renderFactory(game, ui({ leaderboard: true }), width, height).plain();
    assert.match(records, /\[N\] 닉네임 설정.*\[ESC \/ L\]/);
  }
});

test('nickname editor explains privacy, displays Korean input and cursor, and keeps all controls inside the minimum-size modal', () => {
  const game = createFactory(0);
  game.nickname = '별빛 공장';
  frozen(game);
  for (const cloud of [{ status: 'local' }, { status: 'online', nickname: '클라우드 공장' }]) {
    const state = frozen(ui({ nicknameEditor: true, nicknameDraft: '새로운 공장_12-가', cloud }));
    for (const [width, height] of [[88, 30], [120, 40]]) {
      const text = renderFactory(game, state, width, height).plain();
      for (const fragment of ['NICKNAME / 닉네임 설정', `현재 이름  ${cloud.nickname || game.nickname}`, '> 새로운 공장_12-가▏', '2–20자 · 한글/영문/숫자/공백/_/- 사용 가능', '[BACKSPACE] 한 글자 지우기', '[CTRL+U] 모두 지우기', '[ENTER] 닉네임 저장', '[ESC] 취소']) assert.ok(text.includes(fragment), fragment);
      assert.ok(text.includes(cloud.status === 'online' ? '리더보드에 공개됩니다.' : '이 기기에 저장되며 공개되지 않습니다.'));
      assert.ok(!text.includes('[Y] 환생 확정'));
      text.split('\n').forEach(row => assert.equal(displayWidth(row), width));
    }
    const first = renderFactory(game, { ...state, time: 0 }, 88, 30);
    const later = renderFactory(game, { ...state, time: 1.4 }, 88, 30);
    assert.equal(rectangle(first, 4, 5, 80, 19), rectangle(later, 4, 5, 80, 19));
  }
});

test('nickname editor renders validation, pending save, and control-safe long input without claiming a completed save', () => {
  const game = createFactory(0);
  game.nickname = '\x1b[2J기존 공장';
  const error = renderFactory(game, ui({ nicknameEditor: true, nicknameDraft: '\x1b[2J별'.repeat(40), nicknameError: '\x1b[31m닉네임은 2–20자여야 합니다.' }), 88, 30).plain();
  assert.match(error, /닉네임은 2–20자여야 합니다\./);
  assert.match(error, /현재 이름  기존 공장/);
  assert.match(error, /▏/);
  assert.ok(!error.includes('\x1b'));
  assert.ok(!error.includes('[2J'));
  error.split('\n').forEach(row => assert.equal(displayWidth(row), 88));
  const pending = renderFactory(game, ui({ nicknameEditor: true, nicknameDraft: '공장 이름', nicknameSaving: true, cloud: { status: 'online', nickname: '기존 공장' } }), 88, 30).plain();
  assert.match(pending, /닉네임을 서버에 저장하고 있습니다…/);
  assert.match(pending, /\[ENTER\] 변경 예약.*\[ESC\] 닫기/);
  assert.ok(!pending.includes('[ENTER] 닉네임 저장'));
  assert.ok(!pending.includes('닉네임 저장 완료'));
  const retrying = renderFactory(game, ui({ nicknameEditor: true, nicknameDraft: '다음 이름', nicknameSaving: true, nicknameError: '연결되면 변경을 다시 시도합니다.', cloud: { status: 'offline', nickname: '기존 공장' } }), 88, 30).plain();
  assert.match(retrying, /현재 이름  기존 공장/);
  assert.match(retrying, /연결되면 변경을 다시 시도합니다\./);
  assert.match(retrying, /\[ENTER\] 변경 예약/);
});

test('nickname input stays visible after a terminal resize and takes precedence over destructive dialogs', () => {
  const game = createFactory(0);
  for (const [width, height] of [[120, 40], [88, 30], [70, 24], [60, 20], [40, 12], [1, 1], [0, 0]]) {
    const canvas = renderFactory(game, ui({ nicknameEditor: true, nicknameDraft: '작은 공장', prestige: true, prestigeConfirm: true }), width, height);
    if (height) canvas.plain().split('\n').forEach(row => assert.equal(displayWidth(row), width));
    if (width >= 40) {
      assert.match(canvas.plain(), /닉네임 설정/);
      assert.match(canvas.plain(), /> 작은 공장▏/);
      assert.match(canvas.plain(), /\[ENTER\].*\[ESC\]/);
      assert.ok(!canvas.plain().includes('[Y] 환생 확정'));
    }
  }
});

test('locked production machines explain blueprints and the fifth tool shows transmitter inventory', () => {
  const game = createFactory(0);
  const view = factoryViewport(game, 88, 30);
  const sidebar = rectangle(renderFactory(game, ui({ selected: 'smelter' }), 88, 30), view.sidebarX, 4, view.sidebarWidth, 21);
  assert.match(sidebar, /3 용광로.*잠김/);
  assert.match(sidebar, /4 조립기.*잠김/);
  assert.match(sidebar, /5 전송기.*재고 0/);
  assert.match(sidebar, /상인에게 설계도 구매/);
  assert.ok(applyAction(game, { type: 'purchase', item: 'transmitter' }).ok);
  const inventory = rectangle(renderFactory(game, ui({ selected: 'transmitter' }), 88, 30), view.sidebarX, 4, view.sidebarWidth, 21);
  assert.match(inventory, /5 전송기.*재고 1/);
  assert.match(inventory, /상인 구매 · 보유 1개/);
  assert.match(inventory, /이 칸에서 판매/);
});

test('merchant pages through all offers with affordability, prerequisites, owned state, and controls', () => {
  const game = createFactory(0);
  const locked = renderFactory(game, ui({ shop: true, shopIndex: 1 }), 88, 30).plain();
  for (const [index, offer] of shopOffers(game).entries()) {
    const page = renderFactory(game, ui({ shop: true, shopIndex: index }), 88, 30).plain();
    assert.ok(page.includes(offer.name), offer.name);
    assert.match(page, /페이지/);
    page.split('\n').forEach(row => assert.equal(displayWidth(row), 88));
  }
  assert.match(locked, /용광로 설계도.*₵200.*구매 가능/);
  assert.match(locked, /조립기 설계도.*₵700.*잠김/);
  assert.match(locked, /구리 탐지 레이더.*₵350.*자금 부족/);
  assert.match(locked, /용광로 설계도가 필요합니다/);
  assert.match(locked, /구리 탐지 레이더가 필요합니다/);
  assert.match(locked, /판매 전송기.*₵250.*구매 가능/);
  for (const key of ['[W/S ↑↓]', '[A/D ←→]', '[1–9]', '[E/ENTER]', '[ESC/B]', '[5]']) assert.ok(locked.includes(key), key);
  assert.ok(applyAction(game, { type: 'purchase', item: 'smelter_blueprint' }).ok);
  const owned = renderFactory(game, ui({ shop: true }), 88, 30).plain();
  assert.match(owned, /용광로 설계도.*구매 완료/);
  assert.match(owned, /조립기 설계도.*자금 부족/);
  owned.split('\n').forEach(row => assert.equal(displayWidth(row), 88));
});

test('unseen copper and coal have no ore glyph until their radar tier is bought', () => {
  const game = createFactory(0);
  const view = factoryViewport(game);
  game.coins = 2000;
  const hidden = renderFactory(game, ui());
  assert.ok(!tile(hidden, view, 28, 10).includes('▪'));
  assert.ok(!tile(hidden, view, 19, 4).includes('▪'));
  assert.ok(applyAction(game, { type: 'purchase', item: 'radar_copper' }).ok);
  const copper = renderFactory(game, ui());
  assert.ok(tile(copper, view, 28, 10).includes('▪'));
  assert.ok(!tile(copper, view, 19, 4).includes('▪'));
  assert.ok(applyAction(game, { type: 'purchase', item: 'radar_coal' }).ok);
  assert.ok(tile(renderFactory(game, ui()), view, 19, 4).includes('▪'));
});

test('a purchased sale transmitter has a distinct animated glyph and explains recovery', () => {
  const game = createFactory(0);
  assert.ok(applyAction(game, { type: 'purchase', item: 'transmitter' }).ok);
  assert.ok(applyAction(game, { type: 'build', building: 'transmitter', x: 15, y: 16, dir: 1 }).ok);
  const view = factoryViewport(game);
  const frames = [0, .17, .34, .5].map(time => tile(renderFactory(game, ui({ time })), view, 15, 16));
  frames.forEach(frame => assert.match(frame, /[◌◉◎]\$/));
  assert.ok(new Set(frames).size > 1);
  game.player = { x: 15, y: 16 };
  const inspector = rectangle(renderFactory(game, ui()), view.sidebarX, 4, view.sidebarWidth, 30);
  assert.match(inspector, /모든 방향 자동 매입 · \[X\] 회수/);
});

test('prestige preview explains threshold, permanent bonus, reset scope, and deliberate confirmation', () => {
  const game = createFactory(0);
  const unavailable = renderFactory(game, ui({ prestige: true }), 88, 30).plain();
  assert.match(unavailable, /필요 ₵5,000/);
  assert.match(unavailable, /환생까지 ₵5,000 더 판매/);
  for (const fragment of ['코어 1개당 모든 판매가 +25%', '보유만 하면 자동 적용 · 소모되지 않음', '상인·전송기 모두 적용', '코어 4개 = 판매가 2배']) assert.ok(unavailable.includes(fragment), fragment);
  assert.ok(!unavailable.includes('[E/ENTER] 환생 확인'));
  game.progression.runRevenue = 5000;
  game.progression.cores = 2;
  const preview = renderFactory(game, ui({ prestige: true }), 88, 30).plain();
  assert.match(preview, /OH 코어  2 → 3  \(\+1\)/);
  assert.match(preview, /판매 배율  ×1\.50 → ×1\.75/);
  assert.match(preview, /초기화.*현재 공장.*자금.*회차 판매액/);
  assert.match(preview, /설계도.*레이더.*보유\/설치한 전송기/);
  assert.match(preview, /유지.*OH 코어.*환생 횟수.*누적 판매액/);
  assert.ok(!preview.includes('리더보드'));
  assert.match(renderFactory(game, ui({ prestige: true, cloud: { status: 'online' } }), 88, 30).plain(), /누적 판매액/);
  assert.match(preview, /\[E\/ENTER\] 환생 확인/);
  assert.ok(!preview.includes('[Y] 환생 확정'));
  const confirm = renderFactory(game, ui({ prestige: true, prestigeConfirm: true }), 88, 30).plain();
  for (const text of [preview, confirm]) for (const fragment of ['코어 1개당 모든 판매가 +25%', '보유만 하면 자동 적용 · 소모되지 않음', '상인·전송기 모두 적용', '코어 4개 = 판매가 2배']) assert.ok(text.includes(fragment), fragment);
  assert.match(confirm, /되돌릴 수 없습니다/);
  assert.match(confirm, /\[Y\] 환생 확정.*\[ESC\] 취소/);
  assert.ok(!confirm.includes('[E/ENTER] 환생 확인'));
  confirm.split('\n').forEach(row => assert.equal(displayWidth(row), 88));
});

test('shop and prestige render immutable state in opaque modals at the minimum terminal size', () => {
  const game = frozen(createFactory(0, { demo: true }));
  for (const extra of [{ shop: true, shopIndex: 4 }, { prestige: true }, { prestige: true, prestigeConfirm: true }]) {
    const first = renderFactory(game, frozen(ui({ ...extra, time: 0 })), 88, 30);
    const later = renderFactory(game, frozen(ui({ ...extra, time: 1.4 })), 88, 30);
    assert.equal(rectangle(first, 4, 3, 80, 24), rectangle(later, 4, 3, 80, 24));
    first.plain().split('\n').forEach(row => assert.equal(displayWidth(row), 88));
  }
});

test('prestige sale prices retain fractional coins in the market and recipe atlas', () => {
  const game = createFactory(0, { demo: true });
  game.progression.cores = 1;
  const market = renderFactory(game, ui()).plain();
  assert.match(market, /판매 ×1\.25/);
  assert.match(market, /철 2\.5/);
  assert.match(market, /철판 ×1.*₵10/);
  const atlas = renderFactory(game, ui({ recipes: true }), 88, 30).plain();
  assert.match(atlas, /구리판 ×1.*₵12\.5/);
});

test('small and extreme terminal dimensions return bounded, valid frames with resize guidance', () => {
  const game = createFactory(0);
  for (const [width, height] of [[70, 24], [1, 1], [0, 0], [-1, -1], [NaN, NaN]]) {
    const canvas = renderFactory(game, ui(), width, height);
    assert.ok(canvas.width >= 0 && canvas.height >= 0);
    if (canvas.height) canvas.plain().split('\n').forEach(row => assert.equal(displayWidth(row), canvas.width));
  }
  const small = renderFactory(game, ui(), 70, 24).plain();
  assert.match(small, /88열 × 30행/);
  assert.match(small, /Q.*저장 후 종료/);
  assert.ok(!small.includes('MERCHANT BASIN'));
});

test('newly detected wood, quartz and gold render as resources and the atlas identifies the final paper', () => {
  const game = createFactory(0);
  const view = factoryViewport(game);
  for (const [x, y] of [[3, 5], [33, 4], [33, 22]]) {
    assert.ok(!tile(renderFactory(game, ui()), view, x, y).includes('▪'));
  }
  game.progression.radarLevel = 5;
  for (const [x, y] of [[3, 5], [33, 4], [33, 22]]) {
    assert.ok(tile(renderFactory(game, ui()), view, x, y).includes('▪'));
  }
  const text = renderFactory(game, ui({ recipes: true, recipeIndex: Object.keys(RECIPES).indexOf('research_paper') }), 88, 30).plain();
  assert.match(text, /최상위 생산물: 논문/);
  assert.match(text, /› 논문 집필/);
  assert.match(text, /실험데이터 ×2 \+ 종이 ×3 \+ 반도체 ×1/);
  assert.match(text, /→ 논문 ×1.*₵6,000/);
});
