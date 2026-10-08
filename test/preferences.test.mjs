import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { PreferencesStore, defaultPreferencesPath } from '../src/preferences.mjs';
import { defaultFactoryPath } from '../src/factory-save.mjs';

function sandbox(t) {
  const directory = mkdtempSync(join(tmpdir(), 'wise-preferences-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('device preferences share the default state directory, independently of factory paths', () => {
  assert.equal(defaultPreferencesPath(), join(dirname(defaultFactoryPath()), 'preferences.json'));
  const prior = process.env.XDG_STATE_HOME;
  try {
    process.env.XDG_STATE_HOME = '/tmp/wise-custom-state';
    assert.equal(defaultPreferencesPath(), '/tmp/wise-custom-state/starfall/preferences.json');
  } finally {
    if (prior === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prior;
  }
});

test('first launch is read only; explicit preference changes persist atomically with private permissions', t => {
  const directory = sandbox(t);
  const file = join(directory, 'preferences.json');
  const store = new PreferencesStore(file);
  assert.deepEqual(store.load(), { skin: 'original', warning: '' });
  assert.deepEqual(readdirSync(directory), []);
  assert.equal(store.save('work-dev').ok, true);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 1, skin: 'work-dev' });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(new PreferencesStore(file).load(), { skin: 'work-dev', warning: '' });
  assert.equal(store.save('work').ok, true);
  assert.deepEqual(readdirSync(directory), ['preferences.json']);
  assert.equal(new PreferencesStore(file).load().skin, 'work');
});

test('corrupt, future and unrelated saves are preserved even if save is called without load', t => {
  const directory = sandbox(t);
  const file = join(directory, 'preferences.json');
  for (const original of [
    '{ invalid json\n',
    JSON.stringify({ version: 2, skin: 'work' }),
    JSON.stringify({ version: 1, dust: 9000, levels: [1, 2] }),
    JSON.stringify({ version: 3, buildings: [], coins: 300 }),
    JSON.stringify({ version: 1, skin: 'work', futurePreferences: true }),
    JSON.stringify({ version: 1, skin: 3 }),
    'null',
    '[]',
  ]) {
    writeFileSync(file, original);
    const store = new PreferencesStore(file);
    assert.equal(store.save('work-dev').ok, false, original);
    assert.equal(store.load().skin, 'original');
    assert.match(store.load().warning, /원본을 보존/);
    assert.equal(readFileSync(file, 'utf8'), original);
  }
});

test('unknown skin identifiers fall back to Original without rewriting settings', t => {
  const directory = sandbox(t);
  const file = join(directory, 'preferences.json');
  const original = '{"version":1,"skin":"removed-skin"}\n';
  writeFileSync(file, original);
  const store = new PreferencesStore(file);
  assert.deepEqual(store.load(), { skin: 'original', warning: '' });
  assert.equal(readFileSync(file, 'utf8'), original);
  assert.equal(store.save('typo').ok, false);
  assert.equal(readFileSync(file, 'utf8'), original);
  assert.equal(store.save('work').ok, true);
});

test('unwritable preference destinations fail gracefully without damaging unrelated data', t => {
  const directory = sandbox(t);
  const occupied = join(directory, 'occupied');
  writeFileSync(occupied, 'preserve me');
  const store = new PreferencesStore(join(occupied, 'preferences.json'));
  assert.equal(store.load().skin, 'original');
  const result = store.save('work');
  assert.equal(result.ok, false);
  assert.match(result.message, /이번 실행/);
  assert.equal(readFileSync(occupied, 'utf8'), 'preserve me');
  assert.deepEqual(readdirSync(directory), ['occupied']);
});
