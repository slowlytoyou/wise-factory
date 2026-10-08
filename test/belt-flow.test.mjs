import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DIRECTIONS, ITEMS, applyAction, advanceFactory, buildingAt, createFactory, factoryStats,
} from '../src/factory.mjs';

function emptyFactory() {
  const game = createFactory(0);
  game.buildings = [];
  game.coins = 10_000;
  return game;
}

function build(game, type, x, y, dir = 1, level = 1) {
  const result = applyAction(game, { type: 'build', building: type, x, y, dir });
  assert.equal(result.ok, true, result.message);
  const building = buildingAt(game, x, y);
  building.level = level;
  return building;
}

function installTransmitter(game, x, y) {
  assert.equal(applyAction(game, { type: 'purchase', item: 'transmitter' }).ok, true);
  return build(game, 'transmitter', x, y);
}

const factoryContents = game => ({
  buildings: structuredClone(game.buildings),
  coins: game.coins,
  lifetimeRevenue: game.lifetimeRevenue,
  soldCount: game.soldCount,
  stats: structuredClone(game.stats),
  progression: structuredClone(game.progression),
});

test('a blocked route fills every belt and its miner, then keeps all cargo fixed', () => {
  for (const levels of [[1, 1, 1, 1], [5, 1, 3, 2]]) {
    const game = emptyFactory();
    build(game, 'miner', 12, 10, 1, 5);
    for (let index = 0; index < levels.length; index++) build(game, 'belt', 13 + index, 10, 1, levels[index]);
    const coins = game.coins;
    advanceFactory(game, 120);
    assert.deepEqual(game.buildings.map(building => building.item), Array(5).fill('iron_ore'));
    assert.equal(factoryStats(game).inventory, 5);
    assert.equal(game.coins, coins);
    assert.equal(game.soldCount, 0);
    const blocked = factoryContents(game);
    for (const seconds of [0.25, 0.75, 1, 30, 3600]) {
      advanceFactory(game, seconds);
      assert.deepEqual(factoryContents(game), blocked, `full route must remain fixed after ${seconds}s`);
    }
  }
});

test('opening a jammed route drains each waiting item once without creating inventory', () => {
  const game = emptyFactory();
  const miner = build(game, 'miner', 12, 10);
  for (let x = 13; x <= 16; x++) build(game, 'belt', x, 10);
  advanceFactory(game, 120);
  assert.equal(factoryStats(game).inventory, 5);
  // Turn the miner away, retaining its last ore while only the queued belts drain.
  assert.equal(applyAction(game, { type: 'rotate', x: miner.x, y: miner.y }).ok, true);
  installTransmitter(game, 17, 10);
  const coins = game.coins;
  for (let seconds = 0; seconds < 12; seconds++) {
    advanceFactory(game, 1);
    assert.equal(factoryStats(game).inventory + game.soldCount, 5);
  }
  assert.equal(game.soldCount, 4);
  assert.equal(game.coins, coins + 4 * ITEMS.iron_ore.price);
  assert.equal(miner.item, 'iron_ore');
  assert.ok(game.buildings.filter(building => building.type === 'belt').every(building => building.item === null));
  const drained = factoryContents(game);
  advanceFactory(game, 3600);
  assert.deepEqual(factoryContents(game), drained);
});

test('opposing belt outputs block cargo instead of passing it back and forth in every direction', () => {
  for (let dir = 0; dir < DIRECTIONS.length; dir++) {
    for (const sourceLevel of [1, 3, 5]) {
      const game = emptyFactory();
      const { dx, dy } = DIRECTIONS[dir];
      const source = build(game, 'belt', 6, 6, dir, sourceLevel);
      const target = build(game, 'belt', 6 + dx, 6 + dy, (dir + 2) % 4);
      source.item = 'iron_ore';
      const before = factoryContents(game);
      for (let second = 0; second < 8; second++) {
        advanceFactory(game, 1);
        assert.equal(source.item, 'iron_ore', `direction ${dir}, Lv.${sourceLevel}: source must retain cargo`);
        assert.equal(target.item, null, 'a belt cannot accept an item through its own output end');
        assert.deepEqual(factoryContents(game), before);
      }
    }
  }
});

test('a miner cannot inject ore into the output end of an opposing belt', () => {
  const game = emptyFactory();
  const miner = build(game, 'miner', 12, 14);
  const belt = build(game, 'belt', 13, 14, 3);
  advanceFactory(game, 120);
  assert.equal(miner.item, 'iron_ore');
  assert.equal(belt.item, null);
  assert.equal(factoryStats(game).inventory, 1);
  assert.equal(game.soldCount, 0);
});

test('right-angle belts keep genuine conveyor loops moving forward', () => {
  const game = emptyFactory();
  const loop = [
    build(game, 'belt', 5, 5, 1),
    build(game, 'belt', 6, 5, 2),
    build(game, 'belt', 6, 6, 3),
    build(game, 'belt', 5, 6, 0),
  ];
  loop[0].item = 'copper_ore';
  for (let second = 1; second <= 12; second++) {
    advanceFactory(game, 1);
    assert.equal(loop[second % loop.length].item, 'copper_ore');
    assert.equal(loop.filter(building => building.item !== null).length, 1);
    assert.equal(game.soldCount, 0);
  }
});

test('rear and side feeds merge without overwrites and stop when the exit is full', () => {
  const original = emptyFactory();
  const rear = build(original, 'belt', 5, 6, 1);
  const side = build(original, 'belt', 6, 5, 2);
  build(original, 'belt', 6, 6, 1);
  build(original, 'belt', 7, 6, 1);
  rear.item = 'iron_ore';
  side.item = 'copper_ore';
  const reversed = structuredClone(original);
  reversed.buildings.reverse();
  for (let second = 0; second < 12; second++) {
    advanceFactory(original, 1);
    advanceFactory(reversed, 1);
    assert.deepEqual(factoryStats(original).inventoryItems, { iron_ore: 1, copper_ore: 1 });
    const byPosition = game => game.buildings.map(building => [building.x, building.y, building.item]).sort();
    assert.deepEqual(byPosition(original), byPosition(reversed));
  }
  assert.equal(buildingAt(original, 6, 6).item, 'iron_ore');
  assert.equal(buildingAt(original, 7, 6).item, 'copper_ore');
  assert.equal(rear.item, null);
  assert.equal(side.item, null);
});

test('mixed-speed cargo advances only toward the outlet and is sold exactly once', () => {
  const game = emptyFactory();
  const items = ['iron_ore', 'copper_ore', 'gear', 'circuit'];
  const positions = new Map();
  for (const [index, level] of [5, 1, 3, 2].entries()) {
    const belt = build(game, 'belt', 5 + index, 6, 1, level);
    belt.item = items[index];
    positions.set(belt.item, belt.x);
  }
  advanceFactory(game, 120);
  assert.deepEqual(game.buildings.map(building => building.item), items);
  installTransmitter(game, 9, 6);
  const coins = game.coins;
  for (let second = 0; second < 16; second++) {
    advanceFactory(game, 1);
    for (const belt of game.buildings.filter(building => building.item !== null)) {
      assert.ok(belt.x >= positions.get(belt.item), `${belt.item} must never move backward`);
      positions.set(belt.item, belt.x);
    }
    assert.equal(factoryStats(game).inventory + game.soldCount, items.length);
  }
  assert.equal(factoryStats(game).inventory, 0);
  assert.equal(game.soldCount, items.length);
  assert.deepEqual(game.stats.sold, Object.fromEntries(items.map(item => [item, 1])));
  assert.equal(game.coins, coins + items.reduce((sum, item) => sum + ITEMS[item].price, 0));
});

test('mixed-speed throughput agrees across insertion order, frame sizes and offline cycle skipping', () => {
  const bulk = emptyFactory();
  build(bulk, 'miner', 12, 14, 1, 5);
  for (const [index, level] of [5, 1, 3, 2, 5, 1].entries()) build(bulk, 'belt', 13 + index, 14, 1, level);
  const frames = structuredClone(bulk);
  frames.buildings.reverse();
  advanceFactory(bulk, 600);
  for (let frame = 0; frame < 600 * 4; frame++) advanceFactory(frames, 0.25);
  frames.buildings.reverse();
  assert.deepEqual(factoryContents(bulk), factoryContents(frames));
  assert.ok(bulk.soldCount > 0);
});
