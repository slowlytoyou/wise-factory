import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { SaveStore, defaultSavePath } from '../src/save.mjs';
import { createGame, buyUpgrade, tick, productionRate } from '../src/model.mjs';

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'starfall-save-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('default save location honors absolute XDG_STATE_HOME without writing', () => {
  const original = process.env.XDG_STATE_HOME;
  try {
    process.env.XDG_STATE_HOME = '/tmp/starfall-custom-state';
    assert.equal(defaultSavePath(), '/tmp/starfall-custom-state/starfall/save.json');
    delete process.env.XDG_STATE_HOME;
    assert.equal(defaultSavePath(), join(homedir(), '.local', 'state', 'starfall', 'save.json'));
    process.env.XDG_STATE_HOME = 'relative-is-not-valid-xdg';
    assert.equal(defaultSavePath(), join(homedir(), '.local', 'state', 'starfall', 'save.json'));
  } finally {
    if (original === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = original;
  }
});

test('loading a missing file starts fresh without creating files or folders', t => {
  const directory = temporaryDirectory(t);
  const file = join(directory, 'not-created', 'save.json');
  const store = new SaveStore(file);
  const loaded = store.load(1000);
  assert.deepEqual(loaded.game, createGame(1000));
  assert.equal(loaded.offlineEarned, 0);
  assert.equal(loaded.warning, null);
  assert.equal(store.blocked, false);
  assert.equal(existsSync(join(directory, 'not-created')), false);
});

test('atomic save round trip awards offline income and restricts file permissions', t => {
  const directory = temporaryDirectory(t);
  const file = join(directory, 'nested', 'save.json');
  const store = new SaveStore(file);
  const game = createGame(1000);
  buyUpgrade(game, 0);
  tick(game, 20);
  assert.equal(store.save(game, 21_000).ok, true);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(join(directory, 'nested')), ['save.json']);
  const loaded = new SaveStore(file).load(81_000);
  assert.equal(loaded.warning, null);
  assert.equal(loaded.offlineSeconds, 60);
  assert.equal(loaded.offlineEarned, productionRate(game) * 60);
  assert.equal(loaded.game.dust, game.dust + loaded.offlineEarned);
  assert.deepEqual(loaded.game.levels, game.levels);
  const bytes = readFileSync(file, 'utf8');
  assert.equal(store.save(loaded.game, 81_000).ok, true);
  assert.notEqual(readFileSync(file, 'utf8'), bytes);
  assert.deepEqual(readdirSync(join(directory, 'nested')), ['save.json']);
});

test('corrupt JSON, unknown versions and nonobjects block saves and preserve original bytes', t => {
  const directory = temporaryDirectory(t);
  const file = join(directory, 'save.json');
  for (const original of ['{ damaged json\n', '{"version":999,"dust":456}', 'null', '[1,2,3]', '17', '{}']) {
    writeFileSync(file, original);
    const store = new SaveStore(file);
    const result = store.load(1000);
    assert.equal(store.blocked, true);
    assert.match(result.warning, /--save/);
    assert.equal(result.warning, store.lastError);
    assert.deepEqual(result.game, createGame(1000));
    assert.equal(store.save(createGame(), 2000).ok, false);
    assert.equal(readFileSync(file, 'utf8'), original);
    assert.deepEqual(readdirSync(directory), ['save.json']);
  }
});

test('read errors block writes without throwing', t => {
  const directory = temporaryDirectory(t);
  const file = join(directory, 'save.json');
  mkdirSync(file);
  const store = new SaveStore(file);
  assert.doesNotThrow(() => store.load(1000));
  assert.equal(store.blocked, true);
  assert.match(store.lastError, /폴더/);
  assert.equal(store.save(createGame(1000)).ok, false);
  assert.equal(statSync(file).isDirectory(), true);
});

test('save errors preserve existing destinations and remove temporary files', t => {
  const directory = temporaryDirectory(t);
  const occupied = join(directory, 'occupied.json');
  mkdirSync(occupied);
  writeFileSync(join(occupied, 'keep.txt'), 'preserve this');
  const store = new SaveStore(occupied);
  const result = store.save(createGame(1000), 2000);
  assert.equal(result.ok, false);
  assert.equal(result.message, store.lastError);
  assert.match(result.message, /저장하지 못했어요/);
  assert.equal(readFileSync(join(occupied, 'keep.txt'), 'utf8'), 'preserve this');
  assert.deepEqual(readdirSync(directory), ['occupied.json']);
  const parentFile = join(directory, 'not-a-folder');
  writeFileSync(parentFile, 'preserve parent');
  const badParent = new SaveStore(join(parentFile, 'save.json'));
  assert.equal(badParent.save(createGame()).ok, false);
  assert.equal(readFileSync(parentFile, 'utf8'), 'preserve parent');
});

test('a subsequent successful save clears a transient error', t => {
  const directory = temporaryDirectory(t);
  const file = join(directory, 'save.json');
  mkdirSync(file);
  const store = new SaveStore(file);
  assert.equal(store.save(createGame()).ok, false);
  rmSync(file, { recursive: true });
  assert.equal(store.save(createGame()).ok, true);
  assert.equal(store.lastError, null);
});
