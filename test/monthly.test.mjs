import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFactory, advanceFactory, hydrateFactory, serializeFactory, MAX_OFFLINE_SECONDS } from '../src/factory.mjs';
import { hydrateMonthlyFactory, monthAt, nextMonthAt } from '../supabase/functions/factory-sync/season.mjs';
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
  const result = hydrateMonthlyFactory(serializeFactory(game, midnight - 1000), midnight);
  assert.deepEqual(result.monthly, [
    { month: '2026-10-01', revenue: 0, seconds: 1 },
    { month: '2026-11-01', revenue: 2, seconds: 0 },
  ]);
  assert.equal(result.offlineEarned, 2);
});

test('month splitting preserves exact goods, money, and capped offline production', () => {
  for (const [before, after, remainder] of [[300, 300, 0], [300.25, 310.125, 0.25], [0.7, 1.5, 0.3], [14400, 14400, 0]]) {
    const savedAt = midnight - before * 1000;
    const game = createFactory(savedAt);
    game.stepRemainder = remainder;
    const raw = serializeFactory(game, savedAt);
    const now = midnight + after * 1000;
    const result = hydrateMonthlyFactory(raw, now);
    const expected = hydrateFactory(raw, now);
    assert.deepEqual(result.game.buildings, expected.game.buildings);
    assert.equal(result.game.coins, expected.game.coins);
    assert.equal(result.game.lifetimeRevenue, expected.game.lifetimeRevenue);
    assert.deepEqual(result.game.stats, expected.game.stats);
    assert.ok(Math.abs(result.game.elapsed - expected.game.elapsed) < 1e-8);
    assert.ok(Math.abs(result.game.stepRemainder - expected.game.stepRemainder) < 1e-8);
    assert.equal(result.monthly.reduce((sum, item) => sum + item.revenue, 0), result.offlineEarned);
    assert.ok(Math.abs(result.monthly.reduce((sum, item) => sum + item.seconds, 0) - result.offlineSeconds) < 1e-8);
  }
});

test('fractional tick rounding at midnight uses the same tolerance as the engine', () => {
  const game = createFactory(midnight - 300);
  advanceFactory(game, 300.7);
  game.buildings.find((b) => b.x === 18 && b.y === 14).item = 'iron_ore';
  const result = hydrateMonthlyFactory(serializeFactory(game, midnight - 300), midnight);
  assert.equal(result.monthly[0].revenue, 0);
  assert.equal(result.monthly[1].revenue, 2);
});

test('long absences credit only the most recent eight hours, never old lifetime sales', () => {
  const savedAt = Date.parse('2026-09-01T00:00:00+09:00');
  const raw = serializeFactory(createFactory(savedAt), savedAt);
  raw.lifetimeRevenue = 12345;
  const now = Date.parse('2026-11-02T00:00:00+09:00');
  const result = hydrateMonthlyFactory(raw, now);
  assert.equal(result.offlineSeconds, MAX_OFFLINE_SECONDS);
  assert.deepEqual(result.monthly, [{ month: '2026-11-01', revenue: result.offlineEarned, seconds: MAX_OFFLINE_SECONDS }]);
  assert.equal(result.game.lifetimeRevenue, 12345 + result.offlineEarned);
});

test('future save timestamps and missing timestamps never earn negative or invented time', () => {
  for (const savedAt of [midnight + 10000, undefined]) {
    const raw = serializeFactory(createFactory(midnight), midnight);
    raw.savedAt = savedAt;
    const result = hydrateMonthlyFactory(raw, midnight);
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
  const firstRequest = request(0, [{ type: 'prestige' }]);
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
