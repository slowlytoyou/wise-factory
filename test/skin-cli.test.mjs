import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { displayWidth } from '../src/terminal.mjs';

const main = fileURLToPath(new URL('../src/main.mjs', import.meta.url));
function sandbox(t) {
  const directory = mkdtempSync(join(tmpdir(), 'wise-skin-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function run(directory, args) {
  const result = spawnSync(process.execPath, [main, ...args], {
    cwd: directory, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, XDG_STATE_HOME: join(directory, 'state'), TERM: 'xterm-256color' },
  });
  assert.ifError(result.error);
  return result;
}

test('skin option rejects typos and missing values before touching storage', t => {
  const directory = sandbox(t);
  for (const args of [['--skin'], ['--skin', '--snapshot'], ['--skin', 'WORK'], ['--skin', 'other']]) {
    const result = run(directory, args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--skin/);
    assert.equal(result.stdout, '');
  }
  assert.deepEqual(readdirSync(directory), []);
});

test('factory saves cannot use the reserved device preferences path even before it exists', t => {
  const directory = sandbox(t);
  const preferences = join(directory, 'state', 'starfall', 'preferences.json');
  const result = run(directory, ['--save', preferences]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--save.*스킨 설정 경로/);
  assert.deepEqual(readdirSync(directory), []);
});

test('all skin previews and translated help work without reading or writing stored preferences', t => {
  const directory = sandbox(t);
  const baseline = run(directory, ['--snapshot']).stdout;
  const preferences = join(directory, 'state', 'starfall', 'preferences.json');
  mkdirSync(join(directory, 'state', 'starfall'), { recursive: true });
  const original = '{"version":1,"skin":"work-dev"}\n';
  writeFileSync(preferences, original);
  assert.equal(run(directory, ['--snapshot']).stdout, baseline);
  const previews = {};
  for (const skin of ['original', 'work', 'work-dev']) {
    const result = run(directory, ['--snapshot', '--skin', skin]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const rows = result.stdout.slice(0, -1).split('\n');
    assert.equal(rows.length, 40);
    assert.ok(rows.every(row => displayWidth(row) === 120));
    assert.equal(readFileSync(preferences, 'utf8'), original);
    previews[skin] = result.stdout;
    const help = run(directory, ['--help', '--skin', skin]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /--skin NAME/);
    assert.ok(help.stdout.includes(join(directory, 'state', 'starfall', 'factory-v2.json')));
  }
  assert.equal(previews.original, baseline);
  assert.notEqual(previews.work, previews.original);
  assert.notEqual(previews['work-dev'], previews.work);
  assert.match(previews.work, /채굴기/);
  assert.doesNotMatch(previews['work-dev'], /채굴기/);
  assert.deepEqual(readdirSync(join(directory, 'state', 'starfall')), ['preferences.json']);
  writeFileSync(preferences, '{broken');
  assert.equal(run(directory, ['--snapshot']).stdout, baseline);
  assert.equal(run(directory, ['--help']).status, 0);
  assert.equal(readFileSync(preferences, 'utf8'), '{broken');
});

test('developer skin preserves player-provided names and literal help paths', t => {
  const directory = sandbox(t);
  const nickname = '채굴기 공장장';
  const result = run(directory, ['--snapshot', '--skin', 'work-dev', '--nickname', nickname]);
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes(nickname));
  const help = spawnSync(process.execPath, [main, '--help', '--skin', 'work-dev'], {
    encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: join(directory, '공장장') },
  });
  assert.equal(help.status, 0);
  assert.ok(help.stdout.includes(join(directory, '공장장', 'starfall', 'factory-v2.json')));
  assert.deepEqual(readdirSync(directory), []);
});
