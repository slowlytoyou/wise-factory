import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const main = fileURLToPath(new URL('../src/main.mjs', import.meta.url));

test('cloud mode rejects a custom local save before credentials, network or save access', t => {
  const directory = mkdtempSync(join(tmpdir(), 'starfall-cloud-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'personal.json');
  const original = '{"personal":"preserve every byte"}\n';
  writeFileSync(file, original);
  for (const args of [['--cloud', '--save', file], ['--save', file, '--cloud']]) {
    const result = spawnSync(process.execPath, [main, ...args], {
      cwd: directory,
      env: { ...process.env, TERM: 'xterm-256color', XDG_STATE_HOME: join(directory, 'state'),
        SUPABASE_URL: 'must-not-be-read', SUPABASE_PUBLISHABLE_KEY: 'sb_secret_must_not_be_read' },
      encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /클라우드/);
    assert.match(result.stderr, /--save/);
    assert.doesNotMatch(result.stderr, /대화형 터미널|프로젝트 URL|관리자 secret/);
    assert.equal(readFileSync(file, 'utf8'), original);
  }
  assert.deepEqual(readdirSync(directory), ['personal.json']);
});

test('leaderboard command reports monthly scores, average gold per second, total playtime and Korea reset time', t => {
  const directory = mkdtempSync(join(tmpdir(), 'wise-monthly-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const preload = join(directory, 'leaderboard.mjs');
  writeFileSync(preload, `
    import { CloudClient } from ${JSON.stringify(new URL('../src/cloud.mjs', import.meta.url).href)};
    globalThis.fetch = () => { throw new Error('Unexpected network access'); };
    CloudClient.prototype.loadSession = async function () {
      this.session = { access_token: 'fixture', refresh_token: 'fixture' }; return true;
    };
    CloudClient.prototype.leaderboard = async () => ({ month: '2026-10',
      entries: [{ rank: 1, nickname: '연구소', score: 12000, goldPerSecond: 2.75, playSeconds: 90061 }, { rank: 2, nickname: '새 공장', score: 0 }],
      me: { rank: 25, nickname: '연구소', score: 400, goldPerSecond: 0.5, playSeconds: 3600 } });
  `);
  const result = spawnSync(process.execPath, ['--import', preload, main, '--leaderboard'], {
    cwd: directory, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, XDG_STATE_HOME: join(directory, 'state'), SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /월간 판매 리더보드 · 2026-10/);
  assert.match(result.stdout, /매월 1일 00:00 \(한국 시간\) 점수 초기화/);
  assert.match(result.stdout, /초당 평균 골드 생산량/);
  assert.match(result.stdout, /연구소.*12,000 C.*2\.75 골드\/초.*25:01:01/);
  assert.match(result.stdout, /새 공장.*0 C.*0 골드\/초.*0:00:00/);
  assert.match(result.stdout, /내 순위: 25위.*0\.5 골드\/초.*총 플레이 시간 1:00:00/);
  assert.match(result.stdout, /총 플레이 시간 \(시간:분:초\) · 월간 초기화·환생에도 유지/);
  assert.doesNotMatch(result.stdout, /NaN|누적 판매 리더보드/);
  assert.deepEqual(readdirSync(directory), ['leaderboard.mjs']);
  const dev = spawnSync(process.execPath, ['--import', preload, main, '--leaderboard', '--skin', 'work-dev'], {
    cwd: directory, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, XDG_STATE_HOME: join(directory, 'state'), SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' },
  });
  assert.ifError(dev.error);
  assert.equal(dev.status, 0, dev.stderr);
  assert.match(dev.stdout, /누적 가동 시간 \(시간:분:초\)/);
  assert.match(dev.stdout, /새 공장.*0:00:00/, 'nickname stays literal in Dev mode');
  assert.match(dev.stdout, /내 순위: 25위.*누적 가동 시간 1:00:00/);
});
