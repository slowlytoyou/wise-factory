import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { displayWidth } from '../src/terminal.mjs';

const main = fileURLToPath(new URL('../src/classic.mjs', import.meta.url));

function sandbox(t) {
  const directory = mkdtempSync(join(tmpdir(), 'starfall-cli-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function run(directory, args = [], environment = {}) {
  const result = spawnSync(process.execPath, [main, ...args], {
    cwd: directory,
    env: { ...process.env, TERM: 'xterm-256color', XDG_STATE_HOME: join(directory, 'state'), ...environment },
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

test('help works without a TTY and does not create a save directory', t => {
  const directory = sandbox(t);
  for (const flag of ['--help', '-h']) {
    const result = run(directory, [flag]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /STARFALL/);
    assert.match(result.stdout, /--demo/);
    assert.match(result.stdout, /--save PATH/);
    assert.match(result.stdout, /--snapshot/);
    assert.ok(result.stdout.includes(join(directory, 'state', 'starfall', 'save.json')));
    assert.ok(!result.stdout.includes('\x1b'));
  }
  assert.deepEqual(readdirSync(directory), []);
});

test('snapshot produces a complete plain 110 by 38 screen without save side effects', t => {
  const directory = sandbox(t);
  const file = join(directory, 'uncreated', 'save.json');
  const result = run(directory, ['--snapshot', '--save', file]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.ok(!result.stdout.includes('\x1b'));
  const lines = result.stdout.trimEnd().split('\n');
  // Preserve the intentionally blank last screen row when checking geometry.
  const screenRows = result.stdout.slice(0, -1).split('\n');
  assert.equal(screenRows.length, 38);
  assert.ok(screenRows.every(row => displayWidth(row) === 110));
  assert.ok(lines.some(row => row.includes('별빛 공방')));
  assert.match(result.stdout, /채집 드론/);
  assert.equal(existsSync(file), false);
  assert.deepEqual(readdirSync(directory), []);
});

test('fresh and demo snapshots ignore existing save data and preserve every byte', t => {
  const directory = sandbox(t);
  const file = join(directory, 'existing.json');
  const baseline = run(directory, ['--snapshot']).stdout;
  const baselineDemo = run(directory, ['--snapshot', '--demo']).stdout;
  assert.notEqual(baselineDemo, baseline);
  assert.match(baselineDemo, /DEMO/);
  const original = '{"version":1,"dust":99999999,"levels":[99,99,99,99,99],"savedAt":0}\n';
  writeFileSync(file, original);
  for (const [args, expected] of [
    [['--snapshot'], baseline],
    [['--snapshot', '--demo'], baselineDemo],
  ]) {
    const result = run(directory, [...args, '--save', file]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, expected);
    assert.equal(readFileSync(file, 'utf8'), original);
  }
  writeFileSync(file, '{ invalid save\n');
  const corrupt = run(directory, ['--snapshot', '--demo', '--save', file]);
  assert.equal(corrupt.status, 0);
  assert.equal(corrupt.stderr, '');
  assert.equal(corrupt.stdout, baselineDemo);
  assert.equal(readFileSync(file, 'utf8'), '{ invalid save\n');
  assert.deepEqual(readdirSync(directory), ['existing.json']);
});

test('invalid flags and values fail helpfully before touching save storage', t => {
  const directory = sandbox(t);
  const cases = [
    [['--unknown'], /알 수 없는 옵션/],
    [['--fps'], /--fps/],
    [['--fps', '9'], /--fps/],
    [['--fps', '61'], /--fps/],
    [['--fps', '24.5'], /--fps/],
    [['--fps', 'NaN'], /--fps/],
    [['--fps', 'Infinity'], /--fps/],
    [['--save'], /--save/],
    [['--save', '--demo'], /--save/],
  ];
  for (const [args, message] of cases) {
    const result = run(directory, args);
    assert.equal(result.status, 1, args.join(' '));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, message);
    assert.match(result.stderr, /도움말/);
    assert.ok(!result.stderr.includes('at options'));
  }
  assert.deepEqual(readdirSync(directory), []);
});

test('ordinary and demo play reject redirected input or output with a snapshot hint', t => {
  const directory = sandbox(t);
  for (const args of [[], ['--demo'], ['--no-color']]) {
    const result = run(directory, args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /대화형 터미널/);
    assert.match(result.stderr, /npm run classic -- --snapshot/);
  }
  assert.deepEqual(readdirSync(directory), []);
});

test('snapshot accepts supported FPS endpoints and terminal color environment settings', t => {
  const directory = sandbox(t);
  const expected = run(directory, ['--snapshot']).stdout;
  for (const fps of ['10', '60']) {
    const result = run(directory, ['--snapshot', '--fps', fps, '--no-color'], { TERM: 'dumb', NO_COLOR: '' });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, expected);
    assert.equal(result.stderr, '');
  }
  assert.deepEqual(readdirSync(directory), []);
});
