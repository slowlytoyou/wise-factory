import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WORLD_WIDTH, WORLD_HEIGHT, MAX_RADAR_LEVEL, ITEMS, RECIPES, SHOP_ITEMS,
  createFactory, applyAction, advanceFactory, tileAt, buildingAt,
  serializeFactory, hydrateFactory, shopOffers,
} from '../src/factory.mjs';

const rawMaterials = ['iron_ore', 'copper_ore', 'coal', 'stone', 'wood', 'quartz', 'gold_ore'];
const newDeposits = [
  { radar: 'radar_wood', tier: 3, tile: 'wood', item: 'wood', x: 3, y: 5 },
  { radar: 'radar_quartz', tier: 4, tile: 'quartz', item: 'quartz', x: 33, y: 4 },
  { radar: 'radar_gold', tier: 5, tile: 'gold', item: 'gold_ore', x: 33, y: 22 },
];
function build(game, type, x, y, dir = 1, recipe) {
  const result = applyAction(game, { type: 'build', building: type, x, y, dir, recipe });
  assert.equal(result.ok, true, result.message);
  return buildingAt(game, x, y);
}
function empty() {
  const game = createFactory(0, { demo: true });
  game.buildings = []; game.coins = 1_000_000;
  return game;
}

test('new raw materials require ordered paid radars and are mineable after discovery', () => {
  const game = empty();
  assert.equal(MAX_RADAR_LEVEL, 5);
  for (const deposit of newDeposits) {
    assert.equal(tileAt(game, deposit.x, deposit.y), 'ground');
    assert.equal(applyAction(game, { type: 'build', building: 'miner', x: deposit.x, y: deposit.y, dir: 1 }).ok, false);
  }
  for (const deposit of newDeposits.slice(1)) {
    const before = serializeFactory(game, 0);
    assert.equal(applyAction(game, { type: 'purchase', item: deposit.radar }).ok, false);
    assert.deepEqual(serializeFactory(game, 0), before);
  }
  for (const deposit of newDeposits) {
    const coins = game.coins;
    const offer = shopOffers(game).find(item => item.id === deposit.radar);
    assert.equal(offer.available, true);
    assert.equal(applyAction(game, { type: 'purchase', item: deposit.radar }).ok, true);
    assert.equal(game.coins, coins - offer.cost);
    assert.equal(game.progression.radarLevel, deposit.tier);
    assert.equal(tileAt(game, deposit.x, deposit.y), deposit.tile);
    const miner = build(game, 'miner', deposit.x, deposit.y);
    advanceFactory(game, 4);
    assert.equal(miner.item, deposit.item);
    for (const later of newDeposits.filter(entry => entry.tier > deposit.tier)) {
      assert.equal(tileAt(game, later.x, later.y), 'ground');
    }
    const purchased = serializeFactory(game, 0);
    assert.equal(applyAction(game, { type: 'purchase', item: deposit.radar }).ok, false);
    assert.deepEqual(serializeFactory(game, 0), purchased);
  }
});

test('expansion preserves every original ore tile, recipe ID order and shop shortcut', () => {
  assert.deepEqual(Object.keys(RECIPES).slice(0, 6), ['iron_plate', 'copper_plate', 'steel', 'gear', 'circuit', 'engine']);
  assert.deepEqual(SHOP_ITEMS.slice(0, 5).map(item => item.id), ['smelter_blueprint', 'assembler_blueprint', 'radar_copper', 'radar_coal', 'transmitter']);
  const old = createFactory(0, { demo: true });
  const expanded = createFactory(0, { demo: true });
  expanded.progression.radarLevel = 5;
  for (let y = 1; y < WORLD_HEIGHT - 1; y++) for (let x = 1; x < WORLD_WIDTH - 1; x++) {
    let expected = 'ground';
    if (Math.abs(x - 20) <= 1 && Math.abs(y - 14) <= 1) expected = 'merchant';
    else if ((x >= 9 && x <= 12 && y >= 9 && y <= 15) || (x >= 9 && x <= 12 && y >= 19 && y <= 23)) expected = 'iron';
    else if (x >= 27 && x <= 30 && y >= 8 && y <= 13) expected = 'copper';
    else if ((x >= 18 && x <= 21 && y >= 3 && y <= 5) || (x >= 27 && x <= 30 && y >= 19 && y <= 22)) expected = 'coal';
    else if (x >= 5 && x <= 8 && y >= 22 && y <= 25) expected = 'stone';
    assert.equal(tileAt(old, x, y), expected, `${x},${y}`);
    if (expected !== 'ground') assert.equal(tileAt(expanded, x, y), expected, `${x},${y}`);
  }
});

test('the highest-value research paper converges every raw material through an acyclic production chain', () => {
  assert.equal(Object.keys(ITEMS).length, 25);
  assert.equal(Object.keys(RECIPES).length, 18);
  assert.equal(ITEMS.research_paper.name, '논문');
  assert.equal(ITEMS.research_paper.price, 6000);
  assert.ok(Object.entries(ITEMS).every(([id, item]) => id === 'research_paper' || item.price < ITEMS.research_paper.price));
  const producers = new Map(Object.values(RECIPES).map(recipe => [recipe.output, recipe]));
  const visited = new Set();
  function visit(item, ancestors = new Set()) {
    assert.ok(ITEMS[item], `known ingredient ${item}`);
    assert.ok(!ancestors.has(item), `no circular ingredient ${item}`);
    visited.add(item);
    const recipe = producers.get(item);
    if (!recipe) { assert.ok(rawMaterials.includes(item)); return; }
    assert.ok(Object.keys(recipe.inputs).length <= 3, `${recipe.name} leaves a fourth face for its output`);
    assert.ok(Object.values(recipe.inputs).every(count => Number.isInteger(count) && count > 0 && count <= 20));
    const inputsValue = Object.entries(recipe.inputs).reduce((sum, [id, count]) => sum + ITEMS[id].price * count, 0);
    assert.ok(ITEMS[item].price > inputsValue, `${recipe.name} adds sale value`);
    const next = new Set(ancestors).add(item);
    for (const input of Object.keys(recipe.inputs)) visit(input, next);
  }
  visit('research_paper');
  for (const material of rawMaterials) assert.ok(visited.has(material), `${material} contributes to the final paper`);
  assert.equal(visited.size, Object.keys(ITEMS).length);
});

for (const [id, recipe] of Object.entries(RECIPES).slice(6)) {
  test(`${recipe.name} accepts its actual ingredients from at most three belts and sells its output`, () => {
    const game = empty();
    const machine = build(game, recipe.building, 18, 14, 1, id);
    const feeders = [[17, 14, 1], [18, 13, 2], [18, 15, 0]];
    const inputs = Object.entries(recipe.inputs).map(([item, amount], index) => ({
      item, remaining: amount, belt: build(game, 'belt', ...feeders[index]),
    }));
    while (inputs.some(input => input.remaining > 0)) {
      for (const input of inputs) if (input.remaining > 0) {
        assert.equal(input.belt.item, null);
        input.belt.item = input.item;
        input.remaining--;
      }
      advanceFactory(game, 1);
    }
    advanceFactory(game, recipe.seconds + 1);
    assert.equal(game.stats.crafted[recipe.output], 1);
    assert.equal(game.stats.sold[recipe.output], 1);
    assert.equal(game.lifetimeRevenue, ITEMS[recipe.output].price);
    assert.deepEqual(machine.buffer, {});
    assert.equal(machine.item, null);
    assert.ok(inputs.every(input => input.belt.item === null));
  });
}

test('new resources, recipes, cargo, buffers and radar levels survive a save round trip', () => {
  const game = empty();
  game.progression.radarLevel = 5;
  for (const deposit of newDeposits) build(game, 'miner', deposit.x, deposit.y);
  const machine = build(game, 'assembler', 15, 18, 1, 'research_paper');
  machine.buffer = { research_data: 4, paper: 6, chip: 2 };
  advanceFactory(game, 12);
  const carrier = build(game, 'belt', 16, 18);
  carrier.item = 'research_device';
  game.stats.crafted.research_device = 2;
  const raw = serializeFactory(game, 1234);
  assert.equal(raw.version, 3);
  assert.equal(raw.contentVersion, 2);
  const restored = hydrateFactory(JSON.stringify(raw), 1234, { offline: false }).game;
  assert.deepEqual(serializeFactory(restored, 1234), raw);
  assert.equal(restored.progression.radarLevel, 5);
  assert.equal(buildingAt(restored, 15, 18).recipe, 'research_paper');
  for (const deposit of newDeposits) assert.equal(buildingAt(restored, deposit.x, deposit.y).item, deposit.item);
});

test('legacy saves gain the content marker while retaining their old factory and radar tier', () => {
  for (const version of [2, 3]) {
    const game = createFactory(1000, { demo: true });
    advanceFactory(game, 300);
    const raw = serializeFactory(game, 1000);
    raw.version = version;
    delete raw.contentVersion;
    const restored = hydrateFactory(raw, 1000, { offline: false }).game;
    assert.equal(restored.contentVersion, 2);
    assert.equal(restored.progression.radarLevel, 2);
    assert.deepEqual(restored.buildings, game.buildings);
    assert.deepEqual(restored.stats, game.stats);
    assert.equal(restored.coins, game.coins);
    assert.equal(restored.lifetimeRevenue, game.lifetimeRevenue);
    assert.equal(tileAt(restored, 3, 5), 'ground');
  }
});

test('new mining and research production remain deterministic during offline cycle skipping', () => {
  const fast = empty();
  fast.progression.radarLevel = 5;
  fast.progression.transmitters = 3;
  for (const deposit of newDeposits) {
    build(fast, 'miner', deposit.x, deposit.y);
    build(fast, 'belt', deposit.x + 1, deposit.y);
    build(fast, 'transmitter', deposit.x + 2, deposit.y);
  }
  const machine = build(fast, 'assembler', 18, 14, 1, 'research_paper');
  machine.buffer = { research_data: 10, paper: 15, chip: 5 };
  const reference = hydrateFactory(serializeFactory(fast, 0), 0, { offline: false }).game;
  advanceFactory(fast, 1200);
  for (let second = 0; second < 1200; second++) advanceFactory(reference, 1);
  assert.equal(fast.stats.sold.research_paper, 5);
  for (const deposit of newDeposits) assert.ok(fast.stats.sold[deposit.item] > 0);
  assert.deepEqual(serializeFactory(fast, 0), serializeFactory(reference, 0));
});
