import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FactoryStore } from '../src/factory-save.mjs';
import { createFactory, advanceFactory, serializeFactory } from '../src/factory.mjs';

function path(t) { const d = mkdtempSync(join(tmpdir(), 'factory-save-')); t.after(() => rmSync(d, { recursive: true, force: true })); return join(d, 'factory.json'); }
test('factory saving roundtrips a live conveyor and applies offline revenue once', t => {
  const file = path(t), now = 1000000, store = new FactoryStore(file);
  const game = createFactory(now);
  advanceFactory(game, 20);
  assert.equal(store.save(game, now).ok, true);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const loaded = store.load(now + 3600000);
  assert.ok(loaded.offlineEarned > 0);
  assert.ok(loaded.game.lifetimeRevenue > game.lifetimeRevenue);
  assert.equal(loaded.game.buildings.length, game.buildings.length);
  store.save(loaded.game, now + 3600000);
  assert.equal(store.load(now + 3600000).offlineEarned, 0);
});
test('fresh factory does not touch storage until saved', t => {
  const file = path(t);
  assert.equal(new FactoryStore(file).load().game.version, 3);
  assert.equal(existsSync(file), false);
});
test('future content saves remain intact rather than dropping unknown resources', t => {
  const file = path(t);
  for (const contentVersion of [3, null, '2', 0]) {
    const content = JSON.stringify({ ...serializeFactory(createFactory(1000), 1000), contentVersion });
    writeFileSync(file, content);
    const store = new FactoryStore(file), loaded = store.load(1000);
    assert.ok(loaded.warning);
    assert.equal(store.save(loaded.game, 1000).ok, false);
    assert.equal(readFileSync(file, 'utf8'), content);
  }
});
test('unsupported progression formats are preserved without an automatic overwrite', t => {
  const file = path(t);
  for (const progression of [{ schema: 2, cores: 99 }, null, []]) {
    const raw = serializeFactory(createFactory(1000), 1000);
    raw.progression = progression;
    const content = JSON.stringify(raw);
    writeFileSync(file, content);
    const store = new FactoryStore(file), loaded = store.load(1000);
    assert.ok(loaded.warning);
    assert.equal(store.save(loaded.game, 1000).ok, false);
    assert.equal(readFileSync(file, 'utf8'), content);
  }
});
test('legacy factory files migrate in place while current saves retain earned progression', t => {
  const file = path(t), store = new FactoryStore(file);
  const raw = serializeFactory(createFactory(1000), 1000);
  raw.version = 2;
  delete raw.progression;
  writeFileSync(file, JSON.stringify(raw));
  const { game, warning } = store.load(1000);
  assert.equal(warning, '');
  assert.equal(game.progression.unlocks.assembler, true);
  game.progression.cores = 3;
  game.progression.prestigeCount = 2;
  assert.equal(store.save(game, 1000).ok, true);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 3);
  assert.equal(store.load(1000).game.progression.cores, 3);
  assert.equal(store.load(1000).game.progression.prestigeCount, 2);
});
test('v1 or corrupt save remains byte-for-byte intact', t => {
  const file = path(t);
  for (const content of ['{bad', '{"version":1,"dust":9999}', '{"version":2}']) {
    writeFileSync(file, content);
    const store = new FactoryStore(file), result = store.load();
    assert.ok(result.warning);
    assert.equal(store.save(result.game).ok, false);
    assert.equal(readFileSync(file, 'utf8'), content);
  }
});
