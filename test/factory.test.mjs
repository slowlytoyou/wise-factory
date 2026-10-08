import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WORLD_WIDTH, WORLD_HEIGHT, MAX_OFFLINE_SECONDS, ITEMS, BUILDINGS, RECIPES, SHOP_ITEMS,
  createFactory, advanceFactory, applyAction, serializeFactory, hydrateFactory,
  tileAt, buildingAt, upgradeCost, factoryStats, buildingUnlocked, shopOffers, prestigeInfo,
} from '../src/factory.mjs';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
function empty() {
  const game = createFactory(0, { demo: true });
  game.buildings = []; game.coins = 100_000;
  return game;
}
function build(game, building, x, y, dir = 1, recipe) {
  const result = applyAction(game, { type: 'build', building, x, y, dir, recipe });
  assert.equal(result.ok, true, result.message);
  return buildingAt(game, x, y);
}
const economicState = game => ({ coins: game.coins, lifetimeRevenue: game.lifetimeRevenue, soldCount: game.soldCount, buildings: game.buildings, stats: game.stats, progression: game.progression });

test('starter has a working ore-to-merchant route and room for expansion', () => {
  const game = createFactory(1000);
  assert.equal(WORLD_WIDTH, 41); assert.equal(WORLD_HEIGHT, 29);
  assert.equal(game.version, 3);
  assert.equal(game.coins, 300);
  assert.equal(tileAt(game, 20, 14), 'merchant');
  assert.equal(tileAt(game, 19, 13), 'merchant');
  assert.equal(tileAt(game, 12, 14), 'iron');
  assert.equal(factoryStats(game).miners, 1);
  const result = advanceFactory(game, 500);
  assert.ok(result.earned > 200);
  assert.equal(result.earned, game.lifetimeRevenue);
  assert.equal(game.coins, 300 + result.earned);
  assert.equal(game.soldCount + factoryStats(game).inventory, 125);
  assert.equal(game.stats.sold.iron_ore * ITEMS.iron_ore.price, result.earned);
});

test('demo produces and sells gears, two-input circuits, and two-input steel', () => {
  const game = createFactory(0, { demo: true });
  advanceFactory(game, 300);
  for (const item of ['gear', 'circuit', 'steel']) {
    assert.ok(game.stats.crafted[item] > 0, `${item} crafted`);
    assert.ok(game.stats.sold[item] > 0, `${item} sold`);
  }
  assert.equal(game.buildings.length, 45);
  assert.equal(new Set(game.buildings.map(b => `${b.x},${b.y}`)).size, game.buildings.length);
});

test('new factories require paid blueprints and rejected shop actions never consume coins', () => {
  const game = createFactory(0);
  assert.deepEqual(SHOP_ITEMS.map(item => [item.id, item.cost]), [
    ['smelter_blueprint', 200], ['assembler_blueprint', 700], ['radar_copper', 350], ['radar_coal', 900], ['transmitter', 250],
    ['radar_wood', 1800], ['radar_quartz', 3600], ['radar_gold', 7200],
  ]);
  assert.equal(buildingUnlocked(game, 'miner'), true);
  assert.equal(buildingUnlocked(game, 'smelter'), false);
  assert.equal(buildingUnlocked(game, 'assembler'), false);
  assert.equal(buildingUnlocked(game, '__proto__'), false);
  for (const action of [
    { type: 'build', building: 'smelter', x: 5, y: 5, dir: 1 },
    { type: 'build', building: 'assembler', x: 5, y: 5, dir: 1 },
    { type: 'purchase', item: 'assembler_blueprint' }, { type: 'purchase', item: 'radar_coal' },
    { type: 'purchase', item: 'radar_copper' }, { type: 'purchase', item: '__proto__' },
  ]) {
    const before = serializeFactory(game, 0);
    assert.equal(applyAction(game, action).ok, false);
    assert.deepEqual(serializeFactory(game, 0), before);
  }
  assert.match(shopOffers(game).find(item => item.id === 'assembler_blueprint').reason, /용광로/);
  assert.match(shopOffers(game).find(item => item.id === 'radar_copper').reason, /코인/);
  assert.equal(applyAction(game, { type: 'purchase', item: 'smelter_blueprint' }).ok, true);
  assert.equal(game.coins, 100);
  assert.equal(buildingUnlocked(game, 'smelter'), true);
  assert.equal(shopOffers(game).find(item => item.id === 'smelter_blueprint').owned, true);
  const bought = serializeFactory(game, 0);
  assert.equal(applyAction(game, { type: 'purchase', item: 'smelter_blueprint' }).ok, false);
  assert.deepEqual(serializeFactory(game, 0), bought);
  build(game, 'smelter', 5, 5);
  assert.equal(game.coins, 10);
  game.coins = 840;
  assert.equal(applyAction(game, { type: 'purchase', item: 'assembler_blueprint' }).ok, true);
  build(game, 'assembler', 6, 5);
  assert.equal(game.coins, 0);
});

test('radars reveal and enable mining new ore tiers without granting machines', () => {
  const game = createFactory(0);
  game.coins = 2000;
  assert.equal(tileAt(game, 12, 14), 'iron');
  assert.equal(tileAt(game, 5, 23), 'stone');
  for (const [x, y] of [[27, 10], [18, 4], [27, 20]]) {
    assert.equal(tileAt(game, x, y), 'ground');
    assert.equal(applyAction(game, { type: 'build', building: 'miner', x, y, dir: 1 }).ok, false);
  }
  assert.equal(game.coins, 2000);
  const undiscoveredMiner = { ...game.buildings[0], id: 'b999', x: 28, y: 10, item: null };
  game.buildings.push(undiscoveredMiner);
  advanceFactory(game, 20);
  assert.equal(undiscoveredMiner.item, null);
  assert.equal(undiscoveredMiner.progress, 0);
  game.buildings.pop();
  assert.equal(applyAction(game, { type: 'purchase', item: 'radar_copper' }).ok, true);
  assert.equal(tileAt(game, 27, 10), 'copper');
  assert.equal(tileAt(game, 27, 20), 'ground');
  const copper = build(game, 'miner', 27, 10);
  advanceFactory(game, 4);
  assert.equal(copper.item, 'copper_ore');
  assert.equal(applyAction(game, { type: 'purchase', item: 'radar_coal' }).ok, true);
  assert.equal(tileAt(game, 18, 4), 'coal');
  assert.equal(tileAt(game, 27, 20), 'coal');
  const coal = build(game, 'miner', 27, 20);
  advanceFactory(game, 4);
  assert.equal(coal.item, 'coal');
  const previous = serializeFactory(game, 0);
  for (const item of ['radar_copper', 'radar_coal']) assert.equal(applyAction(game, { type: 'purchase', item }).ok, false);
  assert.deepEqual(serializeFactory(game, 0), previous);
  assert.equal(buildingUnlocked(game, 'smelter'), false);
});

test('transmitters sell multiple adjacent deliveries once, and recovery conserves inventory and coins', () => {
  const game = empty();
  game.coins = 1000;
  assert.equal(applyAction(game, { type: 'build', building: 'transmitter', x: 6, y: 6, dir: 1 }).ok, false);
  assert.equal(applyAction(game, { type: 'purchase', item: 'transmitter' }).ok, true);
  assert.equal(applyAction(game, { type: 'purchase', item: 'transmitter' }).ok, true);
  assert.equal(game.coins, 500);
  assert.equal(game.progression.transmitters, 2);
  const transmitter = build(game, 'transmitter', 6, 6);
  assert.equal(game.coins, 500);
  assert.equal(game.progression.transmitters, 1);
  const left = build(game, 'belt', 5, 6, 1), upper = build(game, 'belt', 6, 5, 2);
  left.item = 'engine'; upper.item = 'coal';
  const result = advanceFactory(game, 1);
  assert.equal(result.earned, ITEMS.engine.price + ITEMS.coal.price);
  assert.equal(result.events.filter(event => event.type === 'sale' && event.x === 6 && event.y === 6).length, 2);
  assert.equal(game.soldCount, 2);
  assert.equal(factoryStats(game).inventory, 0);
  assert.equal(transmitter.item, null);
  assert.deepEqual(transmitter.buffer, {});
  assert.equal(advanceFactory(game, 500).earned, 0);
  assert.equal(upgradeCost(transmitter), Infinity);
  assert.equal(applyAction(game, { type: 'upgrade', x: 6, y: 6 }).ok, false);
  const money = game.coins;
  for (let count = 0; count < 5; count++) {
    assert.equal(applyAction(game, { type: 'remove', x: 6, y: 6 }).ok, true);
    assert.equal(game.progression.transmitters, 2);
    assert.equal(applyAction(game, { type: 'remove', x: 6, y: 6 }).ok, false);
    build(game, 'transmitter', 6, 6);
    assert.equal(game.progression.transmitters, 1);
    assert.equal(game.coins, money);
  }
});

test('prestige requires this run revenue, resets the factory in place, and preserves permanent progress', () => {
  const game = createFactory(1000, { demo: true }), identity = game;
  game.nickname = '별빛 공장장';
  game.lifetimeRevenue = 500_000;
  game.progression.runRevenue = 4999.75;
  const before = serializeFactory(game, 1000);
  assert.equal(prestigeInfo(game).available, false);
  assert.equal(applyAction(game, { type: 'prestige' }).ok, false);
  assert.deepEqual(serializeFactory(game, 1000), before);
  game.progression.runRevenue = 20_000;
  game.progression.cores = 1;
  game.progression.prestigeCount = 1;
  game.progression.transmitters = 2;
  game.soldCount = 3456; game.stats.sold.gear = 800;
  game.elapsed = 987; game.stepRemainder = 0.5;
  assert.deepEqual(prestigeInfo(game), { available: true, gain: 2, requiredRevenue: 5000, runRevenue: 20_000, cores: 1, multiplier: 1.25, nextMultiplier: 1.75 });
  assert.equal(applyAction(game, { type: 'prestige' }).ok, true);
  assert.equal(game, identity);
  assert.equal(game.nickname, '별빛 공장장');
  assert.equal(game.coins, 300);
  assert.equal(game.buildings.length, 7);
  assert.equal(game.lifetimeRevenue, 500_000);
  assert.equal(game.soldCount, 3456);
  assert.equal(game.elapsed, 0); assert.equal(game.stepRemainder, 0);
  assert.deepEqual(game.stats, { sold: {}, crafted: {} });
  assert.deepEqual(game.progression, { schema: 1, unlocks: { smelter: false, assembler: false }, radarLevel: 0, transmitters: 0, prestigeCount: 2, cores: 3, runRevenue: 0 });
  assert.equal(applyAction(game, { type: 'prestige' }).ok, false);
  const result = advanceFactory(game, 100);
  assert.equal(result.earned, game.stats.sold.iron_ore * ITEMS.iron_ore.price * 1.75);
  assert.equal(game.progression.runRevenue, result.earned);
  assert.equal(game.lifetimeRevenue, 500_000 + result.earned);
  assert.equal(factoryStats(game).rate, result.earned / 100);
  assert.equal(factoryStats(game).rateLabel, '회차 평균');
});

test('core sale bonuses preserve exact quarter coins at merchant and transmitter', () => {
  const game = empty();
  game.progression.cores = 1;
  const merchantBelt = build(game, 'belt', 18, 14);
  applyAction(game, { type: 'purchase', item: 'transmitter' });
  build(game, 'transmitter', 6, 6);
  const transmitterBelt = build(game, 'belt', 5, 6);
  merchantBelt.item = 'stone'; transmitterBelt.item = 'iron_ore';
  const result = advanceFactory(game, 1);
  assert.equal(result.earned, 3.75);
  assert.deepEqual(result.events.filter(event => event.type === 'sale').map(event => event.value).sort(), [1.25, 2.5]);
  assert.equal(game.progression.runRevenue, 3.75);
});

test('assemblers wait for all inputs, consume exact quantities, and sell only completed output', () => {
  const game = empty();
  const assembler = build(game, 'assembler', 18, 14, 1, 'circuit');
  assembler.buffer = { iron_plate: 1, copper_plate: 1 };
  advanceFactory(game, 20);
  assert.equal(game.soldCount, 0);
  assert.deepEqual(assembler.buffer, { iron_plate: 1, copper_plate: 1 });
  assembler.buffer.copper_plate++;
  advanceFactory(game, RECIPES.circuit.seconds - 1);
  assert.equal(game.soldCount, 0);
  advanceFactory(game, 1);
  assert.equal(game.stats.sold.circuit, 1);
  assert.deepEqual(assembler.buffer, {});
  assert.equal(game.lifetimeRevenue, ITEMS.circuit.price);
});

test('changing recipes preserves materials and finished output but resets partial work', () => {
  const game = empty(), smelter = build(game, 'smelter', 5, 5, 1, 'iron_plate');
  smelter.buffer = { iron_ore: 5, copper_ore: 4 }; smelter.progress = 2;
  smelter.item = 'iron_plate';
  assert.equal(applyAction(game, { type: 'recipe', x: 5, y: 5, recipe: 'copper_plate' }).ok, true);
  assert.deepEqual(smelter.buffer, { iron_ore: 5, copper_ore: 4 });
  assert.equal(smelter.item, 'iron_plate');
  assert.equal(smelter.progress, 0);
  advanceFactory(game, 60);
  assert.deepEqual(smelter.buffer, { iron_ore: 5, copper_ore: 4 });
});

test('blocked outputs retain items and miners stop without duplicating inventory', () => {
  const game = empty(), miner = build(game, 'miner', 12, 14);
  advanceFactory(game, 1000);
  assert.equal(miner.item, 'iron_ore');
  assert.equal(factoryStats(game).inventory, 1);
  assert.equal(game.soldCount, 0);
  const state = economicState(structuredClone(game));
  advanceFactory(game, 1000);
  assert.deepEqual(economicState(game), state);
});

test('belts turn corners and cannot teleport through a line in one pass', () => {
  const game = empty();
  const first = build(game, 'belt', 18, 12, 2);
  const second = build(game, 'belt', 18, 13, 1);
  first.item = 'iron_ore';
  advanceFactory(game, 1);
  assert.equal(first.item, null); assert.equal(second.item, 'iron_ore');
  assert.equal(game.soldCount, 0);
  const result = advanceFactory(game, 1);
  assert.equal(game.stats.sold.iron_ore, 1);
  assert.equal(second.item, null);
  assert.ok(result.events.some(event => event.type === 'sale' && event.x === 19 && event.y === 13));
});

test('two incoming belts cannot overwrite one destination or exceed an input buffer', () => {
  for (const targetType of ['belt', 'smelter']) {
    const game = empty();
    const a = build(game, 'belt', 17, 12, 1), b = build(game, 'belt', 18, 11, 2);
    const target = build(game, targetType, 18, 12, 3, targetType === 'smelter' ? 'iron_plate' : undefined);
    a.item = 'iron_ore'; b.item = 'iron_ore';
    if (targetType === 'smelter') { target.buffer.iron_ore = 19; target.item = 'iron_plate'; }
    const count = factoryStats(game).inventory;
    advanceFactory(game, 1);
    assert.equal(factoryStats(game).inventory, count);
    assert.equal([a, b].filter(building => building.item === 'iron_ore').length, 1);
    if (targetType === 'smelter') assert.equal(target.buffer.iron_ore, 20);
    else assert.equal(target.item, 'iron_ore');
  }
});

test('transport results do not depend on building array insertion order', () => {
  const forward = createFactory(0, { demo: true }), reversed = structuredClone(forward);
  reversed.buildings.reverse();
  advanceFactory(forward, 400); advanceFactory(reversed, 400);
  reversed.buildings.reverse();
  assert.deepEqual(economicState(forward), economicState(reversed));
});

test('upgrades improve miners, processors and belts with bounded levels and charges', () => {
  const slow = createFactory(0), fast = createFactory(0);
  fast.coins = 100_000;
  for (const building of fast.buildings) while (building.level < 5) {
    const before = fast.coins, cost = upgradeCost(building);
    assert.equal(applyAction(fast, { type: 'upgrade', x: building.x, y: building.y }).ok, true);
    assert.equal(fast.coins, before - cost);
  }
  advanceFactory(slow, 200); advanceFactory(fast, 200);
  assert.ok(fast.soldCount > slow.soldCount * 3);
  assert.equal(upgradeCost(fast.buildings[0]), Infinity);
  assert.equal(applyAction(fast, { type: 'upgrade', x: 12, y: 14 }).ok, false);
  const game = empty(), assembler = build(game, 'assembler', 18, 14, 1, 'engine');
  assembler.buffer = { steel: 4, gear: 4, circuit: 2 };
  assert.equal(applyAction(game, { type: 'upgrade', x: 18, y: 14 }).ok, true);
  advanceFactory(game, RECIPES.engine.seconds / 2);
  assert.equal(game.stats.sold.engine, 1);
  assert.deepEqual(assembler.buffer, { steel: 2, gear: 2, circuit: 1 });
});

test('invalid actions and deltas cannot mutate state or mint currency', () => {
  const game = createFactory(0), before = serializeFactory(game, 0);
  const bad = [
    null, [], { type: 'coins', amount: 1e9 }, { type: 'move', dx: 10, dy: 0 },
    { type: 'move', dx: 1, dy: 1 }, { type: 'move', dx: NaN, dy: 0 },
    { type: 'build', building: 'miner', x: 5, y: 5, dir: 1 },
    { type: 'build', building: '__proto__', x: 5, y: 5, dir: 1 },
    { type: 'build', building: 'belt', x: 20, y: 14, dir: 1 },
    { type: 'build', building: 'belt', x: 0, y: 5, dir: 1 },
    { type: 'build', building: 'belt', x: 5.5, y: 5, dir: 1 },
    { type: 'build', building: 'belt', x: 5, y: 5, dir: 4 },
    { type: 'build', building: 'assembler', x: 5, y: 5, dir: 1, recipe: 'iron_plate' },
    { type: 'build', building: 'belt', x: 13, y: 14, dir: 1 },
    { type: 'remove', x: 5, y: 5 }, { type: 'recipe', x: 12, y: 14, recipe: 'engine' },
  ];
  for (const action of bad) assert.equal(applyAction(game, action).ok, false);
  for (const delta of [0, -1, NaN, Infinity, undefined, '10']) assert.deepEqual(advanceFactory(game, delta), { earned: 0, events: [] });
  assert.deepEqual(serializeFactory(game, 0), before);
});

test('build, upgrade and salvage never create a profitable repeated refund', () => {
  const game = empty(), before = game.coins;
  const belt = build(game, 'belt', 5, 5);
  const expense = BUILDINGS.belt.cost + upgradeCost(belt);
  applyAction(game, { type: 'upgrade', x: 5, y: 5 });
  assert.equal(applyAction(game, { type: 'remove', x: 5, y: 5 }).ok, true);
  assert.equal(game.coins, before - expense + Math.floor(expense / 2));
  assert.equal(applyAction(game, { type: 'remove', x: 5, y: 5 }).ok, false);
});

test('WASD movement can cross machines and merchant but cannot exit map', () => {
  const game = createFactory(0);
  game.player = { x: 18, y: 14 };
  assert.equal(applyAction(game, { type: 'move', dx: 1, dy: 0 }).ok, true);
  assert.deepEqual(game.player, { x: 19, y: 14 });
  game.player = { x: 1, y: 1 };
  assert.equal(applyAction(game, { type: 'move', dx: -1, dy: 0 }).ok, false);
});

test('simulation is frame independent and cycle skipping matches full substep simulation', () => {
  const whole = createFactory(0, { demo: true });
  advanceFactory(whole, 360);
  for (const fps of [24, 30]) {
    const frames = createFactory(0, { demo: true });
    for (let frame = 0; frame < 360 * fps; frame++) advanceFactory(frames, 1 / fps);
    assert.deepEqual(economicState(whole), economicState(frames));
    close(whole.elapsed, frames.elapsed); close(whole.stepRemainder, frames.stepRemainder);
  }
  const skipped = createFactory(0, { demo: true }), reference = structuredClone(skipped);
  advanceFactory(skipped, MAX_OFFLINE_SECONDS);
  for (let second = 0; second < MAX_OFFLINE_SECONDS; second += 60) advanceFactory(reference, 60);
  assert.deepEqual(economicState(skipped), economicState(reference));
});

test('prestige bonuses and transmitter sales match frames and cycle skips after resuming', () => {
  const original = createFactory(1000, { demo: true });
  original.progression.cores = 3;
  original.progression.prestigeCount = 2;
  original.lifetimeRevenue = 30_000;
  applyAction(original, { type: 'purchase', item: 'transmitter' });
  build(original, 'transmitter', 11, 21);
  build(original, 'miner', 11, 22, 0);
  const skipped = structuredClone(original), seconds = structuredClone(original), frames = structuredClone(original);
  advanceFactory(skipped, 300);
  for (let i = 0; i < 300; i++) advanceFactory(seconds, 1);
  for (let i = 0; i < 300 * 24; i++) advanceFactory(frames, 1 / 24);
  assert.deepEqual(economicState(skipped), economicState(seconds));
  assert.deepEqual(economicState(skipped), economicState(frames));
  const restored = hydrateFactory(serializeFactory(original, 1000), 1000 + MAX_OFFLINE_SECONDS * 1000);
  assert.deepEqual(economicState(restored.game), economicState(original));
  assert.equal(restored.offlineEarned, 0);
  advanceFactory(restored.game, MAX_OFFLINE_SECONDS);
  advanceFactory(original, MAX_OFFLINE_SECONDS);
  assert.deepEqual(economicState(restored.game), economicState(original));
  assert.equal(original.lifetimeRevenue, 30_000 + original.progression.runRevenue);
});

test('dense independent conveyor loops catch up8h without waiting for one combined period', () => {
  const game = empty();
  let id = 1;
  for (let y = 1; y < 27; y += 2) for (let start = 1; start < 40;) {
    const width = Math.min(40 - start, 3 + ((y * 7 + start * 11) % 17));
    if (width < 2) break;
    for (let x = start; x < start + width; x++) for (let yy = y; yy <= y + 1; yy++) {
      if (tileAt(game, x, yy) === 'merchant') continue;
      game.buildings.push({ id: `b${id++}`, type: 'belt', x, y: yy,
        dir: yy === y ? (x === start + width - 1 ? 2 : 1) : (x === start ? 0 : 3),
        level: 5, recipe: '', buffer: {}, progress: 0, item: (x + yy) % 3 === 0 ? 'iron_ore' : null });
    }
    start += width;
  }
  const inventory = factoryStats(game).inventory;
  assert.ok(game.buildings.length > 1000);
  const start = performance.now();
  advanceFactory(game, MAX_OFFLINE_SECONDS);
  assert.ok(performance.now() - start < 2000, '8h catchup should remain within the nominal Edge CPU allowance');
  assert.equal(factoryStats(game).inventory + game.soldCount, inventory);
});

test('save roundtrip preserves factory, buffers, progress, counters and removed IDs', () => {
  const game = createFactory(1000, { demo: true });
  advanceFactory(game, 103.4);
  build(game, 'belt', 5, 5); applyAction(game, { type: 'remove', x: 5, y: 5 });
  const raw = serializeFactory(game, 1000);
  assert.equal(raw.version, 3);
  const restored = hydrateFactory(JSON.stringify(raw), 1000, { offline: false });
  assert.deepEqual(serializeFactory(restored.game, 1000), raw);
  raw.buildings[0].buffer.coal = 20;
  assert.notEqual(game.buildings[0].buffer.coal, 20);
  raw.progression.unlocks.smelter = false;
  assert.equal(game.progression.unlocks.smelter, true);
});

test('local nickname normalizes and persists alongside factory progress without changing save version', () => {
  const game = createFactory(1000, { demo: true });
  assert.equal(game.nickname, '공장장');
  advanceFactory(game, 103.4);
  game.nickname = '  Ｓｔａｒ   공장_1-2  ';
  const raw = serializeFactory(game, 1000);
  assert.equal(raw.version, 3);
  assert.equal(raw.nickname, 'Star 공장_1-2');
  const restored = hydrateFactory(JSON.stringify(raw), 1000, { offline: false }).game;
  assert.equal(restored.nickname, 'Star 공장_1-2');
  assert.deepEqual(economicState(restored), economicState(game));
  assert.deepEqual(serializeFactory(restored, 1000), raw);
  const rawNickname = { ...raw, nickname: '  Ａ   별빛  ' };
  assert.equal(hydrateFactory(rawNickname, 1000, { offline: false }).game.nickname, 'A 별빛');
  // Match the public profile's Unicode character limit, including astral letters.
  for (const nickname of ['가나', '가'.repeat(20), '\u{10400}'.repeat(20)]) {
    assert.equal(hydrateFactory({ ...raw, nickname }, 1000, { offline: false }).game.nickname, nickname);
  }
});

test('v2 and v3 saves without a nickname receive a local default without resetting progress', () => {
  const game = createFactory(1000, { demo: true });
  advanceFactory(game, 120);
  for (const version of [2, 3]) {
    const raw = serializeFactory(game, 1000);
    raw.version = version;
    delete raw.nickname;
    const restored = hydrateFactory(raw, 1000, { offline: false }).game;
    assert.equal(restored.nickname, '공장장');
    assert.deepEqual(economicState(restored), economicState(game));
  }
});

test('malformed local nicknames fall back independently of all saved factory progress', () => {
  const game = createFactory(1000, { demo: true });
  advanceFactory(game, 120);
  game.progression.cores = 3;
  for (const nickname of [null, undefined, 7, {}, [], '', ' ', 'A', '가'.repeat(21), '\u{10400}'.repeat(21), '별빛\n공장', '별빛\t공장', '별빛💎', '\u001b[31m공장']) {
    const raw = { ...serializeFactory(game, 1000), nickname };
    const restored = hydrateFactory(raw, 1000, { offline: false }).game;
    assert.equal(restored.nickname, '공장장');
    assert.deepEqual(economicState(restored), economicState(game));
    game.nickname = nickname;
    assert.equal(serializeFactory(game, 1000).nickname, '공장장');
  }
});

test('old v2 saves migrate with their production lines and unlocked ore preserved', () => {
  const old = createFactory(1000, { demo: true });
  advanceFactory(old, 300);
  const raw = serializeFactory(old, 1000);
  raw.version = 2;
  delete raw.progression;
  delete raw.nickname;
  const { game } = hydrateFactory(raw, 1000, { offline: false });
  assert.equal(game.version, 3);
  assert.equal(game.nickname, '공장장');
  assert.equal(serializeFactory(game, 1000).version, 3);
  assert.deepEqual(game.buildings, old.buildings);
  assert.deepEqual(game.stats, old.stats);
  assert.equal(game.coins, old.coins);
  assert.equal(game.lifetimeRevenue, old.lifetimeRevenue);
  assert.equal(game.soldCount, old.soldCount);
  assert.deepEqual(game.progression, {
    schema: 1, unlocks: { smelter: true, assembler: true }, radarLevel: 2,
    transmitters: 0, cores: 0, prestigeCount: 0, runRevenue: old.lifetimeRevenue,
  });
  assert.equal(tileAt(game, 27, 10), 'copper');
  assert.equal(tileAt(game, 27, 20), 'coal');
  const restored = hydrateFactory(serializeFactory(game, 1000), 1000, { offline: false }).game;
  assert.deepEqual(economicState(restored), economicState(game));
});

test('current v3 missing progression stays locked and transitional v2 retains explicit progression', () => {
  const raw = serializeFactory(createFactory(1000, { demo: true }), 1000);
  delete raw.progression;
  raw.lifetimeRevenue = 9000;
  const { game: current } = hydrateFactory(raw, 1000, { offline: false });
  assert.equal(current.version, 3);
  assert.equal(current.progression.runRevenue, 0);
  assert.equal(current.progression.cores, 0);
  assert.deepEqual(current.progression.unlocks, { smelter: false, assembler: false });
  assert.equal(current.progression.radarLevel, 0);
  assert.ok(current.buildings.every(building => !['smelter', 'assembler'].includes(building.type)));
  const transitional = serializeFactory(createFactory(1000), 1000);
  transitional.version = 2;
  transitional.progression.cores = 4;
  transitional.progression.prestigeCount = 2;
  const restored = hydrateFactory(transitional, 1000, { offline: false }).game;
  assert.equal(restored.version, 3);
  assert.deepEqual(restored.progression, transitional.progression);
  assert.equal(serializeFactory(restored, 1000).version, 3);
});

test('malformed current progression cannot receive legacy unlocks or phantom transmitter contents', () => {
  const raw = serializeFactory(createFactory(1000, { demo: true }), 1000);
  for (const progression of [null, undefined, [], {}, { schema: 9 }, {
    schema: 1, unlocks: { smelter: 'true', assembler: true }, radarLevel: 100,
    cores: Infinity, transmitters: -5, prestigeCount: '3', runRevenue: NaN,
  }]) {
    const game = hydrateFactory({ ...raw, progression }, 1000, { offline: false }).game;
    assert.deepEqual(game.progression, {
      schema: 1, unlocks: { smelter: false, assembler: false }, radarLevel: 0,
      transmitters: 0, cores: 0, prestigeCount: 0, runRevenue: 0,
    });
    assert.ok(game.buildings.every(building => !['smelter', 'assembler'].includes(building.type)));
    assert.equal(tileAt(game, 27, 10), 'ground');
  }
  const game = empty();
  game.progression.transmitters = 1;
  const transmitter = build(game, 'transmitter', 6, 6);
  Object.assign(transmitter, { level: 5, item: 'engine', buffer: { engine: 20 }, progress: 5 });
  game.progression.runRevenue = 120;
  game.lifetimeRevenue = 0;
  game.stats.sold.iron_ore = 60;
  game.soldCount = 0;
  const restored = hydrateFactory(serializeFactory(game, 0), 0, { offline: false }).game;
  assert.equal(restored.buildings[0].item, null);
  assert.equal(restored.buildings[0].level, 1);
  assert.equal(restored.buildings[0].progress, 0);
  assert.deepEqual(restored.buildings[0].buffer, {});
  assert.equal(restored.lifetimeRevenue, 120);
  assert.equal(restored.soldCount, 60);
  assert.equal(advanceFactory(restored, 100).earned, 0);
});

test('untrusted saves reject unknown buildings, invalid positions, duplicate tiles and malformed fields', () => {
  for (const raw of [null, [], '{oops', 5, {}, { version: 999 }]) {
    assert.deepEqual(hydrateFactory(raw, 1000).game, createFactory(1000));
  }
  const raw = serializeFactory(createFactory(1000), 1000);
  raw.coins = Infinity; raw.lifetimeRevenue = -20; raw.elapsed = 'bad';
  raw.player = { x: -3, y: 9 }; raw.merchant = { x: 0, y: 0 };
  raw.buildings[0].level = 900; raw.buildings[0].dir = -1;
  raw.buildings[0].buffer = { coal: 1e9, iron_ore: -5, unknown: 900 };
  raw.buildings[0].item = '__proto__'; raw.buildings[0].progress = NaN;
  raw.buildings.push({ ...raw.buildings[0] }, { type: 'constructor', x: 1, y: 1 }, { type: 'miner', x: 1, y: 1 }, { type: 'belt', x: 20, y: 14 });
  const { game } = hydrateFactory(raw, 1000);
  assert.equal(game.buildings.length, 7);
  assert.equal(game.coins, 300); assert.equal(game.lifetimeRevenue, 0);
  assert.deepEqual(game.player, { x: 17, y: 16 });
  assert.deepEqual(game.merchant, { x: 20, y: 14 });
  assert.equal(game.buildings[0].level, 5);
  assert.equal(game.buildings[0].item, null);
  assert.deepEqual(game.buildings[0].buffer, { coal: 20 });
  assert.ok(Number.isFinite(advanceFactory(game, 100).earned));
});

test('loading never advances inventory, production progress, timers or revenue', () => {
  const game = createFactory(1000, { demo: true });
  advanceFactory(game, 37.4);
  const raw = serializeFactory(game, 1000);
  for (const resumedAt of [0, 1000, 1000 + 30 * 24 * 3600 * 1000]) {
    // Legacy callers cannot opt back into rewarding wall time.
    const restored = hydrateFactory(raw, resumedAt, { offline: true });
    assert.equal(restored.offlineSeconds, 0);
    assert.equal(restored.offlineEarned, 0);
    assert.equal(restored.game.savedAt, resumedAt);
    assert.deepEqual(serializeFactory(restored.game, 0), serializeFactory(game, 0));
    assert.ok(advanceFactory(restored.game, 60).earned > 0);
  }
});
