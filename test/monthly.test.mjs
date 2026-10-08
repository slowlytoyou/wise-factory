import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFactory, advanceFactory, hydrateFactory, serializeFactory } from '../src/factory.mjs';
import { hydrateMonthlyFactory, monthAt, nextMonthAt, MAX_ACTIVE_SECONDS } from '../supabase/functions/factory-sync/season.mjs';
import { processSync, SupabaseRepository, validateRequest } from '../supabase/functions/factory-sync/server.mjs';

const midnight = Date.parse('2026-11-01T00:00:00+09:00');
const user = '12345678-1234-4234-8234-123456789abc';
const request = (revision = null, actions = []) => ({ revision, actions, requestId: randomUUID() });

test('seasons switch at Korean midnight across year and leap-February boundaries', () => {
  for (const [date, before, after, next] of [
    ['2026-11-01', '2026-10-01', '2026-11-01', '2026-12-01'],
    ['2027-01-01', '2026-12-01', '2027-01-01', '2027-02-01'],
    ['2028-03-01', '2028-02-01', '2028-03-01', '2028-04-01'],
  ]) {
    const time = Date.parse(`${date}T00:00:00+09:00`);
    assert.equal(monthAt(time - 1), before);
    assert.equal(monthAt(time), after);
    assert.equal(nextMonthAt(time - 1), time);
    assert.equal(nextMonthAt(time), Date.parse(`${next}T00:00:00+09:00`));
  }
});

test('a sale on the midnight simulation tick belongs to the new month', () => {
  const game = createFactory(midnight - 1000);
  game.buildings.find((b) => b.x === 18 && b.y === 14).item = 'iron_ore';
  const result = hydrateMonthlyFactory(serializeFactory(game, midnight - 1000), midnight, 1);
  assert.deepEqual(result.monthly, [
    { month: '2026-10-01', revenue: 0, seconds: 1 },
    { month: '2026-11-01', revenue: 2, seconds: 0 },
  ]);
  assert.equal(result.earned, 2);
  assert.equal(result.offlineEarned, 0);
});

test('month splitting preserves exact goods and money during active play', () => {
  for (const [before, after, remainder] of [[30, 30, 0], [30.25, 31.125, 0.25], [0.7, 1.5, 0.3], [60, 60, 0]]) {
    const savedAt = midnight - before * 1000;
    const game = createFactory(savedAt);
    game.stepRemainder = remainder;
    const raw = serializeFactory(game, savedAt);
    const now = midnight + after * 1000;
    const result = hydrateMonthlyFactory(raw, now, before + after);
    const expected = hydrateFactory(raw, now);
    advanceFactory(expected.game, before + after);
    assert.deepEqual(result.game.buildings, expected.game.buildings);
    assert.equal(result.game.coins, expected.game.coins);
    assert.equal(result.game.lifetimeRevenue, expected.game.lifetimeRevenue);
    assert.deepEqual(result.game.stats, expected.game.stats);
    assert.ok(Math.abs(result.game.elapsed - expected.game.elapsed) < 1e-8);
    assert.ok(Math.abs(result.game.stepRemainder - expected.game.stepRemainder) < 1e-8);
    assert.equal(result.monthly.reduce((sum, item) => sum + item.revenue, 0), result.earned);
    assert.ok(Math.abs(result.monthly.reduce((sum, item) => sum + item.seconds, 0) - result.activeSeconds) < 1e-8);
  }
});

test('fractional tick rounding at midnight uses the same tolerance as the engine', () => {
  const game = createFactory(midnight - 300);
  advanceFactory(game, 300.7);
  game.buildings.find((b) => b.x === 18 && b.y === 14).item = 'iron_ore';
  const result = hydrateMonthlyFactory(serializeFactory(game, midnight - 300), midnight, 0.3);
  assert.equal(result.monthly[0].revenue, 0);
  assert.equal(result.monthly[1].revenue, 2);
});

test('long absences preserve the factory and add no monthly revenue or time', () => {
  const savedAt = Date.parse('2026-09-01T00:00:00+09:00');
  const raw = serializeFactory(createFactory(savedAt), savedAt);
  raw.lifetimeRevenue = 12345;
  const now = Date.parse('2026-11-02T00:00:00+09:00');
  for (const seconds of [0, MAX_ACTIVE_SECONDS]) {
    const result = hydrateMonthlyFactory(raw, now, seconds);
    assert.equal(result.activeSeconds, 0);
    assert.equal(result.offlineSeconds, 0);
    assert.equal(result.offlineEarned, 0);
    assert.deepEqual(result.monthly, [{ month: '2026-11-01', revenue: 0, seconds: 0 }]);
    assert.equal(result.game.lifetimeRevenue, 12345);
    assert.equal(result.game.elapsed, raw.elapsed);
    assert.deepEqual(result.game.buildings, raw.buildings);
  }
});

test('future save timestamps and missing timestamps never earn negative or invented time', () => {
  for (const savedAt of [midnight + 10000, undefined]) {
    const raw = serializeFactory(createFactory(midnight), midnight);
    raw.savedAt = savedAt;
    const result = hydrateMonthlyFactory(raw, midnight, 60);
    assert.equal(result.offlineSeconds, 0);
    assert.deepEqual(result.monthly, [{ month: '2026-11-01', revenue: 0, seconds: 0 }]);
  }
});

class LedgerRepository {
  constructor(state) { this.row = { state, revision: 0, nickname: 'WISE' }; this.receipts = new Map(); this.months = new Map(); }
  async prepare(_user, _initial, id, hash) {
    const receipt = this.receipts.get(id);
    return structuredClone(receipt ? receipt.hash === hash ? { ...this.row, replayed: true } : { error: 'request_id_reused' } : this.row);
  }
  async commit(p) {
    if (p.expectedRevision !== this.row.revision) return { ...this.row, error: 'revision_conflict' };
    for (const item of p.monthly) {
      const previous = this.months.get(item.month) ?? { revenue: 0, seconds: 0 };
      this.months.set(item.month, { revenue: previous.revenue + item.revenue, seconds: previous.seconds + item.seconds });
    }
    this.row = { state: p.state, revision: this.row.revision + 1, nickname: p.nickname };
    this.receipts.set(p.requestId, { hash: p.hash });
    return structuredClone(this.row);
  }
}

test('server commits monthly production once despite replay, conflict, and prestige', async () => {
  const savedAt = midnight - 60000;
  const game = createFactory(savedAt);
  game.lifetimeRevenue = 5000;
  game.progression.runRevenue = 5000;
  const repo = new LedgerRepository(serializeFactory(game, savedAt));
  const firstRequest = { ...request(0, [{ type: 'prestige' }]), activeSeconds: 120 };
  const first = await processSync(firstRequest, user, repo, midnight + 60000);
  assert.equal(first.state.progression.prestigeCount, 1);
  assert.equal(first.state.progression.runRevenue, 0);
  assert.ok(repo.months.get('2026-10-01').revenue > 0);
  assert.ok(repo.months.get('2026-11-01').revenue > 0);
  const months = structuredClone(repo.months);
  await processSync(firstRequest, user, repo, midnight + 120000);
  assert.deepEqual(repo.months, months);
  await assert.rejects(processSync(request(0), user, repo, midnight + 120000), { status: 409 });
  assert.deepEqual(repo.months, months);
  assert.equal([...months.values()].reduce((sum, item) => sum + item.revenue, 0), first.state.lifetimeRevenue - 5000);
});

test('monthly RPC receives only trusted simulation buckets and clients cannot supply metrics', async () => {
  let sent;
  const repository = new SupabaseRepository({ url: 'https://example.supabase.co', secretKey: 'sb_secret_test' }, async (url, options) => {
    sent = { url, body: JSON.parse(options.body) };
    return Response.json({});
  });
  await repository.commit({ monthly: [{ month: '2026-11-01', revenue: 5, seconds: 10 }] });
  assert.ok(sent.url.endsWith('/factory_commit_monthly'));
  assert.deepEqual(sent.body.p_monthly, [{ month: '2026-11-01', revenue: 5, seconds: 10 }]);
  for (const field of ['monthly', 'score', 'goldPerSecond', 'season']) {
    assert.throws(() => validateRequest({ ...request(), [field]: 123 }), { status: 400 });
  }
});


test('only explicit live duration is simulated, clamped to the server clock', () => {
  const raw = serializeFactory(createFactory(midnight), midnight);
  for (const [requested, elapsed, credited] of [[0, 60, 0], [10, 60, 10], [120, 5, 5], [120, 120, 120], [120, 120.001, 0], [NaN, 30, 0]]) {
    const result = hydrateMonthlyFactory(raw, midnight + elapsed * 1000, requested);
    assert.equal(result.activeSeconds, credited);
    assert.equal(result.game.elapsed, credited);
    assert.equal(result.offlineEarned, 0);
    assert.equal(result.offlineSeconds, 0);
  }
});

test('loads and old clients never produce without an explicit active duration', async () => {
  const raw = serializeFactory(createFactory(midnight), midnight);
  const repo = new LedgerRepository(raw);
  const loaded = await processSync(request(), user, repo, midnight + 60000);
  assert.equal(loaded.state.elapsed, 0);
  const legacy = await processSync(request(loaded.revision), user, repo, midnight + 120000);
  assert.equal(legacy.state.elapsed, 0);
  const active = await processSync({ ...request(legacy.revision), activeSeconds: 30 }, user, repo, midnight + 150000);
  assert.equal(active.state.elapsed, 30);
  assert.ok(active.state.lifetimeRevenue > 0);
  assert.equal([...repo.months.values()].reduce((sum, entry) => sum + entry.seconds, 0), 30);
});

test('active duration validation rejects invalid, excessive, and initial-load time', () => {
  for (const activeSeconds of [null, '60', -1, 121, Infinity, NaN, {}]) {
    assert.throws(() => validateRequest({ ...request(0), activeSeconds }), { status: 400 });
  }
  assert.throws(() => validateRequest({ ...request(), activeSeconds: 1 }), { status: 400 });
  assert.equal(validateRequest({ ...request(0), activeSeconds: 60 }).activeSeconds, 60);
});
