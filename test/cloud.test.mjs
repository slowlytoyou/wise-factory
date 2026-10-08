import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Server } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CloudClient, CloudError, readCloudConfig } from '../src/cloud.mjs';
import { createHandler, processSync, requestDigest, validateRequest, verifyUser, SupabaseRepository } from '../supabase/functions/factory-sync/server.mjs';
import { BUILDINGS, SHOP_ITEMS } from '../src/factory.mjs';

const CONFIG = { url: 'https://factory-test.supabase.co', key: 'sb_publishable_test' };
const USER = '06a56578-6ad7-4a20-bbb2-bae4c487a0ae';
const token = (overrides = {}) => ({ access_token: 'test.access.token', refresh_token: 'refresh-token', expires_in: 3600, user: { id: USER, email: 'private@example.test' }, ...overrides });
const json = (body, status = 200) => Response.json(body, { status });
const fresh = (extra = {}) => ({ revision: null, actions: [], requestId: randomUUID(), ...extra });
async function fixture(t, fetchImpl) {
  const dir = await mkdtemp(join(tmpdir(), 'starfall-cloud-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return new CloudClient(CONFIG, { fetchImpl, sessionFile: join(dir, 'session.json'), callbackPort: 0, callbackTimeoutMs: 3000 });
}

test('cloud config pairs stay together, environment overrides JSON and secrets are rejected', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'starfall-config-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configFile = join(dir, 'cloud.json');
  assert.equal(readCloudConfig({ env: {}, configFile, defaultConfigFile: null }), null);
  assert.throws(() => readCloudConfig({ env: { SUPABASE_URL: CONFIG.url }, configFile }), /함께/);
  await writeFile(configFile, JSON.stringify({ url: CONFIG.url, publishableKey: CONFIG.key }));
  assert.equal(readCloudConfig({ env: {}, configFile }).url, CONFIG.url);
  assert.throws(() => readCloudConfig({ env: { SUPABASE_URL: 'https://other.supabase.co' }, configFile }), /함께/);
  assert.equal(readCloudConfig({ env: { SUPABASE_URL: 'https://other.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_other' }, configFile }).url, 'https://other.supabase.co');
  assert.throws(() => new CloudClient({ ...CONFIG, key: 'sb_secret_never-on-client' }), /관리자/);
  const service = `e30.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.signature`;
  assert.throws(() => new CloudClient({ ...CONFIG, key: service }), /관리자/);
  assert.throws(() => new CloudClient({ ...CONFIG, url: 'http://example.com' }), /HTTPS/);
  assert.throws(() => new CloudClient({ ...CONFIG, url: 'https://user:secret@example.com' }), /HTTPS/);
});

test('fresh installations use the bundled public server without personal configuration', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wise-shared-config-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configFile = join(dir, 'absent.json');
  const bundled = JSON.parse(await readFile(new URL('../config/cloud.default.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(bundled).sort(), ['port', 'publishableKey', 'url']);
  assert.match(bundled.publishableKey, /^sb_publishable_[A-Za-z0-9_-]+$/);
  const config = readCloudConfig({ env: {}, configFile });
  assert.deepEqual(config, { url: bundled.url, key: bundled.publishableKey, port: bundled.port });
  assert.equal(readCloudConfig({ env: { STARFALL_AUTH_PORT: '55000' }, configFile }).port, 55000);
  await writeFile(configFile, JSON.stringify({ url: CONFIG.url, publishableKey: CONFIG.key, port: 55001 }));
  assert.deepEqual(readCloudConfig({ env: {}, configFile }), { ...CONFIG, port: 55001 });
  await writeFile(configFile, JSON.stringify({ url: CONFIG.url }));
  assert.throws(() => readCloudConfig({ env: {}, configFile }), /함께/);
  await writeFile(configFile, '{broken');
  assert.throws(() => readCloudConfig({ env: {}, configFile }), /JSON/);
  // Complete environment credentials have priority even over a broken local file.
  assert.deepEqual(readCloudConfig({ env: { SUPABASE_URL: CONFIG.url, SUPABASE_PUBLISHABLE_KEY: CONFIG.key }, configFile }), { ...CONFIG, port: 53682 });
});

test('sessions are scoped, private, atomic and do not persist provider or email fields', async (t) => {
  const client = await fixture(t);
  await client.saveSession(token({ provider_token: 'not-persisted' }));
  const text = await readFile(client.sessionFile, 'utf8');
  assert.equal((await stat(client.sessionFile)).mode & 0o777, 0o600);
  assert.ok(!text.includes('private@example') && !text.includes('not-persisted'));
  const same = new CloudClient(CONFIG, { sessionFile: client.sessionFile });
  assert.equal(await same.loadSession(), true);
  const other = new CloudClient({ ...CONFIG, url: 'https://other.supabase.co' }, { sessionFile: client.sessionFile });
  assert.equal(await other.loadSession(), false);
  assert.equal(other.hasSession(), false);
});

test('malformed session data is treated as logged out', async (t) => {
  const client = await fixture(t);
  await writeFile(client.sessionFile, '{broken');
  assert.equal(await client.loadSession(), false);
  await writeFile(client.sessionFile, JSON.stringify({ project: CONFIG.url, session: { access_token: 'x', refresh_token: 'y', expires_at: 'later' } }));
  assert.equal(await client.loadSession(), false);
});

test('rate limits carry Retry-After without refreshing or discarding the login session', async (t) => {
  let calls = 0;
  const client = await fixture(t, async () => {
    calls++;
    return Response.json({ code: 'rate_limited', message: '잠시 후 다시 시도하세요.' }, {
      status: 429, headers: { 'Retry-After': '60' },
    });
  });
  await client.saveSession(token());
  const saved = await readFile(client.sessionFile, 'utf8');
  await assert.rejects(client.sync(), { status: 429, code: 'rate_limited', retryAfterMs: 60_000 });
  assert.equal(calls, 1);
  assert.equal(await readFile(client.sessionFile, 'utf8'), saved);
  assert.equal(client.hasSession(), true);
});

test('Retry-After dates and malformed values produce a usable retry delay', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-10-08T05:00:00Z'));
  for (const [header, expected] of [
    ['Thu, 08 Oct 2026 05:00:30 GMT', 30_000], ['bad', 0], ['-1', 0],
    ['Thu, 08 Oct 2026 04:00:00 GMT', 0], [null, 0],
  ]) {
    const client = await fixture(t, async () => Response.json({ code: 'rate_limited' }, {
      status: 429, headers: header === null ? {} : { 'Retry-After': header },
    }));
    await assert.rejects(client.request('/test'), { retryAfterMs: expected });
  }
});

test('PKCE browser login binds loopback callback, exchanges verifier and closes listener', async (t) => {
  let authUrl;
  let exchanged = 0;
  const client = await fixture(t, async (url, options) => {
    if (url === `${CONFIG.url}/auth/v1/settings`) {
      assert.equal(options.method, 'GET');
      assert.equal(options.headers.apikey, CONFIG.key);
      assert.equal(options.headers.Authorization, undefined);
      return json({ external: { github: true } });
    }
    assert.equal(url, `${CONFIG.url}/auth/v1/token?grant_type=pkce`);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.apikey, CONFIG.key);
    const body = JSON.parse(options.body);
    assert.equal(body.auth_code, 'one-time-code');
    assert.equal(createHash('sha256').update(body.code_verifier).digest('base64url'), authUrl.searchParams.get('code_challenge'));
    exchanged++;
    return json(token());
  });
  const result = await client.login('github', async (url) => {
    authUrl = new URL(url);
    assert.equal(authUrl.origin, CONFIG.url);
    assert.equal(authUrl.searchParams.get('provider'), 'github');
    assert.equal(authUrl.searchParams.get('code_challenge_method'), 's256');
    const callback = new URL(authUrl.searchParams.get('redirect_to'));
    assert.equal(callback.hostname, '127.0.0.1');
    assert.match(callback.pathname, /^\/auth\/callback\/[a-f0-9]{64}$/);
    const wrong = new URL(callback); wrong.pathname = '/auth/callback/wrong'; wrong.searchParams.set('code', 'bad');
    assert.equal((await fetch(wrong)).status, 404);
    assert.equal(exchanged, 0);
    callback.searchParams.set('code', 'one-time-code');
    const response = await fetch(callback);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    await response.text();
  });
  assert.equal(result.user.id, USER);
  assert.equal(client.hasSession(), true);
  assert.equal(exchanged, 1);
  await assert.rejects(fetch(authUrl.searchParams.get('redirect_to')));
});

test('cancelled OAuth never creates a session', async (t) => {
  const client = await fixture(t, (url) => {
    assert.equal(url, `${CONFIG.url}/auth/v1/settings`, 'cancelled login must not exchange a token');
    return json({ external: { google: true } });
  });
  await assert.rejects(client.login('google', async (url) => {
    const callback = new URL(new URL(url).searchParams.get('redirect_to'));
    callback.searchParams.set('error', 'access_denied');
    const response = await fetch(callback);
    assert.equal(response.status, 400);
    await response.text();
  }), /취소/);
  assert.equal(client.hasSession(), false);
});

test('disabled OAuth providers do not open a browser or listener, exchange tokens, or write sessions', async (t) => {
  t.mock.method(Server.prototype, 'listen', () => assert.fail('disabled login must not listen'));
  for (const provider of ['github', 'google']) {
    const calls = [];
    const client = await fixture(t, async (url, options) => {
      calls.push(url);
      assert.equal(options.method, 'GET');
      assert.equal(options.headers.Authorization, undefined);
      return json({ external: { [provider]: false } });
    });
    await assert.rejects(client.login(provider, () => assert.fail('disabled login must not open a browser')), (error) => {
      assert.ok(error instanceof CloudError);
      assert.equal(error.code, 'provider_disabled');
      assert.match(error.message, /npm start/);
      assert.match(error.message, /로그인 없이/);
      return true;
    });
    assert.deepEqual(calls, [`${CONFIG.url}/auth/v1/settings`]);
    assert.equal(client.hasSession(), false);
    await assert.rejects(stat(client.sessionFile), { code: 'ENOENT' });
  }
});

test('disabled provider preflight preserves an existing session unchanged', async (t) => {
  const client = await fixture(t, async () => json({ external: { github: false } }));
  await client.saveSession(token());
  const saved = await readFile(client.sessionFile, 'utf8');
  const session = client.session;
  await assert.rejects(client.login('github', () => assert.fail('must not open a browser')), { code: 'provider_disabled' });
  assert.equal(client.session, session);
  assert.equal(await readFile(client.sessionFile, 'utf8'), saved);
  assert.equal(client.hasSession(), true);
});

test('missing or malformed provider settings stop login before browser, listener, or session changes', async (t) => {
  t.mock.method(Server.prototype, 'listen', () => assert.fail('unverified login must not listen'));
  for (const settings of [null, {}, { external: null }, { external: {} }, { external: { github: 'true' } }]) {
    const client = await fixture(t, async () => json(settings));
    await assert.rejects(client.login('github', () => assert.fail('must not open a browser')), (error) => {
      assert.equal(error.code, 'invalid_response');
      assert.match(error.message, /npm start/);
      return true;
    });
    assert.equal(client.hasSession(), false);
    await assert.rejects(stat(client.sessionFile), { code: 'ENOENT' });
  }
});

test('provider preflight network failure preserves credentials and never opens a browser or listener', async (t) => {
  t.mock.method(Server.prototype, 'listen', () => assert.fail('offline login must not listen'));
  const client = await fixture(t, async () => { throw new Error('offline'); });
  await client.saveSession(token());
  const saved = await readFile(client.sessionFile, 'utf8');
  await assert.rejects(client.login('github', () => assert.fail('must not open a browser')), { code: 'network_error' });
  assert.equal(await readFile(client.sessionFile, 'utf8'), saved);
  assert.equal(client.hasSession(), true);
});

test('refresh is deduplicated and sync sends only actions, revision, nickname and request ID', async (t) => {
  const calls = [];
  const client = await fixture(t, async (url, options) => {
    calls.push({ url, options });
    if (url.includes('grant_type=refresh_token')) return json(token({ access_token: 'new.token', refresh_token: 'rotated-refresh' }));
    assert.equal(options.headers.Authorization, 'Bearer new.token');
    return json({ revision: 3, state: {}, results: [] });
  });
  await client.saveSession(token({ expires_at: 1 }));
  await Promise.all([client.refreshSession(), client.refreshSession()]);
  const requestId = randomUUID();
  await client.sync({ revision: 2, actions: [{ type: 'rotate', x: 12, y: 14 }], nickname: '별빛', activeSeconds: 12.5, requestId, state: { coins: 999999 } });
  assert.equal(calls.filter((call) => call.url.includes('grant_type=refresh_token')).length, 1);
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { revision: 2, actions: [{ type: 'rotate', x: 12, y: 14 }], requestId, nickname: '별빛', activeSeconds: 12.5 });
});

test('401 refresh retries the same idempotent request and conflict preserves latest state', async (t) => {
  const bodies = [];
  let syncCalls = 0;
  const client = await fixture(t, async (url, options) => {
    if (url.includes('refresh_token')) return json(token({ access_token: 'refreshed.token' }));
    bodies.push(options.body);
    if (++syncCalls === 1) return json({ message: 'expired' }, 401);
    return json({ code: 'revision_conflict', message: '새 상태', state: { coins: 23 }, revision: 4 }, 409);
  });
  await client.saveSession(token());
  await assert.rejects(client.sync({ revision: 2, actions: [] }), (error) => {
    assert.ok(error instanceof CloudError);
    assert.equal(error.status, 409);
    assert.equal(error.payload.revision, 4);
    assert.equal(error.payload.state.coins, 23);
    return true;
  });
  assert.equal(bodies[0], bodies[1]);
});

test('refresh rejection clears saved credentials but network failures preserve them', async (t) => {
  const client = await fixture(t, async () => { throw new Error('network unavailable'); });
  await client.saveSession(token({ expires_at: 1 }));
  await assert.rejects(client.refreshSession(), { code: 'network_error' });
  assert.equal(client.hasSession(), true);
  client.fetch = async () => json({ error: 'invalid_grant' }, 400);
  await assert.rejects(client.refreshSession(), { code: 'login_required' });
  assert.equal(client.hasSession(), false);
  await assert.rejects(stat(client.sessionFile), { code: 'ENOENT' });
});

test('logout deletes local credentials even if revocation cannot reach server', async (t) => {
  const client = await fixture(t, async () => { throw new Error('offline'); });
  await client.saveSession(token());
  await assert.rejects(client.logout(), { code: 'logout_remote_unconfirmed' });
  assert.equal(client.hasSession(), false);
  await assert.rejects(stat(client.sessionFile), { code: 'ENOENT' });
});

test('server rejects score/state/time spoofing, excessive actions and terminal control in names', () => {
  for (const field of ['state', 'score', 'now', 'userId', 'coins']) assert.throws(() => validateRequest(fresh({ [field]: 999 })), { status: 400 });
  assert.throws(() => validateRequest(fresh({ actions: Array(33).fill({ type: 'move', dx: 1, dy: 0 }), revision: 0 })), { status: 400 });
  assert.throws(() => validateRequest(fresh({ actions: [{ type: 'setScore', value: 10 }], revision: 0 })), { status: 400 });
  assert.throws(() => validateRequest(fresh({ nickname: '\x1b[2Jbad' })), { status: 400 });
  assert.throws(() => validateRequest(fresh({ actions: [{ type: 'build', x: 2, y: 2, building: 'belt', dir: 0 }] })), { status: 400 });
  assert.equal(validateRequest(fresh({ nickname: '  별빛  공장  ' })).nickname, '별빛 공장');
});

test('progression requests accept only purchase IDs and a parameter-free prestige action', () => {
  const actions = [{ type: 'purchase', item: 'smelter_blueprint' }, { type: 'prestige' }];
  assert.deepEqual(validateRequest(fresh({ revision: 1, actions })).actions, actions);
  for (const field of ['progression', 'unlocks', 'radarLevel', 'cores', 'runRevenue', 'reward']) {
    assert.throws(() => validateRequest(fresh({ [field]: 999 })), { status: 400 });
    for (const action of actions) {
      assert.throws(() => validateRequest(fresh({ revision: 1, actions: [{ ...action, [field]: 999 }] })), { status: 400 });
    }
  }
  for (const item of [undefined, null, '', 123, {}, 'x'.repeat(49)]) {
    assert.throws(() => validateRequest(fresh({ revision: 1, actions: [{ type: 'purchase', item }] })), { status: 400 });
  }
  assert.throws(() => validateRequest(fresh({ revision: 1, actions: [{ type: 'purchase', item: 'transmitter', cost: 0 }] })), { status: 400 });
});

class MemoryRepository {
  constructor() { this.row = null; this.receipts = new Map(); this.commits = 0; this.rateAllowed = true; }
  async admit() { return this.rateAllowed; }
  async prepare(_id, state, requestId, hash) {
    this.row ??= { state, revision: 0, nickname: '공장-test' };
    const receipt = this.receipts.get(requestId);
    if (receipt) {
      if (receipt.hash !== hash) return { error: 'request_id_reused' };
      return structuredClone({ ...this.row, ...receipt.result, replayed: true });
    }
    return structuredClone(this.row);
  }
  async commit(p) {
    const receipt = this.receipts.get(p.requestId);
    if (receipt) return receipt.hash === p.hash ? structuredClone({ ...this.row, ...receipt.result, replayed: true }) : { error: 'request_id_reused' };
    if (this.row.revision !== p.expectedRevision) return structuredClone({ ...this.row, error: 'revision_conflict' });
    this.row = { state: structuredClone(p.state), revision: this.row.revision + 1, nickname: p.nickname };
    this.lastScore = p.score;
    const result = { results: p.results, offlineEarned: p.offlineEarned, offlineSeconds: p.offlineSeconds, appliedRevision: this.row.revision };
    this.receipts.set(p.requestId, { hash: p.hash, result });
    this.commits++;
    return structuredClone({ ...this.row, ...result });
  }
  async leaderboard() { return { entries: [{ rank: 1, nickname: '공장-test', score: this.row?.state.lifetimeRevenue ?? 0 }], me: null }; }
}

test('server initializes canonical factory, applies costs and returns failed action results', async () => {
  const repo = new MemoryRepository();
  const loaded = await processSync(fresh(), USER, repo, 1_000_000);
  assert.equal(loaded.state.coins, 300);
  const built = await processSync(fresh({ revision: loaded.revision, actions: [
    { type: 'build', x: 16, y: 16, building: 'belt', dir: 1 },
    { type: 'build', x: 20, y: 14, building: 'miner', dir: 1 },
  ] }), USER, repo, 1_000_000);
  assert.equal(built.state.coins, 300 - BUILDINGS.belt.cost);
  assert.deepEqual(built.results.map((r) => r.ok), [true, false]);
});

test('nickname-only sync preserves the factory and a replay cannot revert a newer name', async () => {
  const repo = new MemoryRepository();
  const loaded = await processSync(fresh(), USER, repo, 1000);
  const request = fresh({ revision: loaded.revision, nickname: '  은하   공장  ' });
  const renamed = await processSync(request, USER, repo, 1000);
  assert.equal(renamed.nickname, '은하 공장');
  assert.deepEqual(renamed.state, loaded.state);
  assert.deepEqual(renamed.results, []);
  assert.equal(repo.lastScore, loaded.state.lifetimeRevenue);
  const newer = await processSync(fresh({ revision: renamed.revision, nickname: '별빛 주인' }), USER, repo, 1000);
  const commits = repo.commits;
  const replayed = await processSync(request, USER, repo, 2000);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.nickname, '별빛 주인');
  assert.equal(repo.commits, commits);
  assert.deepEqual(repo.row.state, newer.state);
  await assert.rejects(processSync({ ...request, nickname: '다른 이름' }, USER, repo, 2000), { code: 'request_id_reused' });
  assert.equal(repo.row.nickname, '별빛 주인');
});

test('unsupported stored formats are preserved without simulation or commit, including receipt retries', async () => {
  for (const variant of ['version', 'schema', 'missing', 'malformed', 'content']) {
    const repo = new MemoryRepository();
    const originalRequest = fresh();
    await processSync(originalRequest, USER, repo, 1000);
    if (variant === 'version') repo.row.state.version = 4;
    else if (variant === 'content') repo.row.state.contentVersion = 3;
    else if (variant === 'schema') repo.row.state.progression.schema = 2;
    else if (variant === 'missing') { repo.row.state.version = 3; delete repo.row.state.progression; }
    else repo.row.state.progression = null;
    const before = structuredClone(repo.row);
    for (const request of [fresh(), originalRequest]) {
      await assert.rejects(processSync(request, USER, repo, 60000), { status: 426, code: 'update_required' });
      assert.deepEqual(repo.row, before);
      assert.equal(repo.commits, 1);
    }
  }
});

test('database downgrade refusal is reported as an update requirement without retrying the write', async () => {
  const repo = new MemoryRepository();
  const initial = await processSync(fresh(), USER, repo, 1000);
  const before = structuredClone(repo.row);
  let attempted = 0;
  repo.commit = async () => { attempted++; return { error: 'update_required' }; };
  await assert.rejects(processSync(fresh({
    revision: initial.revision, actions: [{ type: 'purchase', item: 'smelter_blueprint' }],
  }), USER, repo, 1000), { status: 426, code: 'update_required' });
  assert.equal(attempted, 1);
  assert.equal(repo.commits, 1);
  assert.deepEqual(repo.row, before);
});

test('a legacy version2 cloud save migrates once without losing revenue or its existing factory', async () => {
  const repo = new MemoryRepository();
  await processSync(fresh(), USER, repo, 1000);
  repo.row.state.version = 2;
  delete repo.row.state.progression;
  repo.row.state.lifetimeRevenue = 6500;
  const previousBuildings = structuredClone(repo.row.state.buildings);
  const migrated = await processSync(fresh(), USER, repo, 1000);
  assert.equal(migrated.state.version, 3);
  assert.equal(migrated.state.progression.runRevenue, 6500);
  assert.deepEqual(migrated.state.progression.unlocks, { smelter: true, assembler: true });
  assert.equal(migrated.state.progression.radarLevel, 2);
  assert.deepEqual(migrated.state.buildings, previousBuildings);
  assert.equal(repo.lastScore, 6500);
});

test('server gates production buildings and sells progression only at authoritative shop prices', async () => {
  const repo = new MemoryRepository();
  const loaded = await processSync(fresh(), USER, repo, 1000);
  assert.deepEqual(loaded.state.progression.unlocks, { smelter: false, assembler: false });
  assert.equal(loaded.state.progression.radarLevel, 0);
  // This is an earned-balance fixture in the database, never a client payload.
  repo.row.state.coins = 100000;
  const itemIds = ['smelter_blueprint', 'assembler_blueprint', 'radar_copper', 'radar_coal', 'transmitter'];
  const smelter = { type: 'build', x: 16, y: 16, building: 'smelter', dir: 1 };
  const purchased = await processSync(fresh({ revision: loaded.revision, actions: [
    smelter,
    ...itemIds.map(item => ({ type: 'purchase', item })),
    smelter,
    { type: 'purchase', item: 'smelter_blueprint' },
    { type: 'purchase', item: 'free_cores' },
  ] }), USER, repo, 1000);
  assert.deepEqual(purchased.results.map(result => result.ok), [false, true, true, true, true, true, true, false, false]);
  const cost = itemIds.reduce((sum, id) => sum + SHOP_ITEMS.find(item => item.id === id).cost, 0);
  assert.equal(purchased.state.coins, 100000 - cost - BUILDINGS.smelter.cost);
  assert.deepEqual(purchased.state.progression.unlocks, { smelter: true, assembler: true });
  assert.equal(purchased.state.progression.radarLevel, 2);
  assert.equal(purchased.state.progression.transmitters, 1);
  assert.equal(purchased.state.progression.cores, 0);
});

test('prestige eligibility uses the stored run revenue, not coins or previous lifetime sales', async () => {
  const repo = new MemoryRepository();
  const initial = await processSync(fresh(), USER, repo, 1000);
  repo.row.state.coins = 100000;
  repo.row.state.lifetimeRevenue = 100000;
  repo.row.state.progression.runRevenue = 4999;
  const result = await processSync(fresh({ revision: initial.revision, actions: [{ type: 'prestige' }] }), USER, repo, 1000);
  assert.equal(result.results[0].ok, false);
  assert.equal(result.state.coins, 100000);
  assert.equal(result.state.progression.runRevenue, 4999);
  assert.equal(result.state.progression.cores, 0);
  assert.equal(result.state.progression.prestigeCount, 0);
});

test('prestige computes permanent cores once, resets the run and preserves the leaderboard score', async () => {
  const repo = new MemoryRepository();
  const initial = await processSync(fresh(), USER, repo, 1000);
  Object.assign(repo.row.state, { coins: 9000, lifetimeRevenue: 55000, soldCount: 8000 });
  Object.assign(repo.row.state.progression, {
    runRevenue: 20000, cores: 3, prestigeCount: 2, radarLevel: 2, transmitters: 4,
    unlocks: { smelter: true, assembler: true },
  });
  const request = fresh({ revision: initial.revision, actions: [{ type: 'prestige' }, { type: 'prestige' }] });
  const first = await processSync(request, USER, repo, 1000);
  assert.deepEqual(first.results.map(result => result.ok), [true, false]);
  assert.deepEqual(first.state.progression, {
    schema: 1, unlocks: { smelter: false, assembler: false }, radarLevel: 0,
    transmitters: 0, prestigeCount: 3, cores: 5, runRevenue: 0,
  });
  assert.equal(first.state.coins, 300);
  assert.equal(first.state.lifetimeRevenue, 55000);
  assert.equal(first.state.soldCount, 8000);
  assert.equal(repo.lastScore, 55000);
  const repeated = await processSync(request, USER, repo, 60000);
  assert.equal(repeated.replayed, true);
  assert.deepEqual(repeated.state, first.state);
  assert.equal(repo.commits, 2);
  assert.equal((await repo.leaderboard()).entries[0].score, 55000);
});

test('replaying a shop receipt cannot charge again or duplicate transmitter inventory', async () => {
  const repo = new MemoryRepository();
  const initial = await processSync(fresh(), USER, repo, 1000);
  repo.row.state.coins = 100000;
  const request = fresh({ revision: initial.revision, actions: [{ type: 'purchase', item: 'transmitter' }] });
  const first = await processSync(request, USER, repo, 1000);
  const replay = await processSync(request, USER, repo, 1000);
  assert.equal(first.results[0].ok, true);
  assert.equal(first.state.progression.transmitters, 1);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.state, first.state);
  assert.equal(repo.commits, 2);
});

test('reopening a cloud factory after two days never grants offline rewards', async () => {
  const repo = new MemoryRepository();
  const initial = await processSync(fresh(), USER, repo, 1_000_000);
  const loaded = await processSync(fresh(), USER, repo, 1_000_000 + 48 * 3600 * 1000);
  assert.equal(loaded.offlineSeconds, 0);
  assert.equal(loaded.offlineEarned, 0);
  assert.equal(loaded.state.coins, initial.state.coins);
  assert.equal(loaded.state.elapsed, initial.state.elapsed);
  assert.deepEqual(loaded.state.buildings, initial.state.buildings);
  assert.equal(loaded.state.savedAt, 1_000_000 + 48 * 3600 * 1000);
});

test('a delayed sync cannot move the saved clock backwards and award production twice', async () => {
  const repo = new MemoryRepository();
  await processSync(fresh(), USER, repo, 1000);
  const delayedRequest = fresh();
  let release, markWaiting;
  const paused = new Promise((resolve) => { release = resolve; });
  const waiting = new Promise((resolve) => { markWaiting = resolve; });
  const prepare = repo.prepare.bind(repo);
  repo.prepare = async (...args) => {
    if (args[2] === delayedRequest.requestId) { markWaiting(); await paused; }
    return prepare(...args);
  };
  const pending = processSync(delayedRequest, USER, repo, 11_000);
  await waiting;
  const newer = await processSync(fresh(), USER, repo, 21_000);
  release();
  const delayed = await pending;
  assert.equal(delayed.state.savedAt, newer.state.savedAt);
  assert.equal(delayed.offlineSeconds, 0);
  const repeated = await processSync(fresh(), USER, repo, 21_000);
  assert.equal(repeated.offlineSeconds, 0);
  assert.equal(repeated.state.elapsed, newer.state.elapsed);
  assert.equal(repeated.state.lifetimeRevenue, newer.state.lifetimeRevenue);
  assert.equal(repeated.state.coins, newer.state.coins);
  const later = await processSync(fresh({ revision: repeated.revision, activeSeconds: 10 }), USER, repo, 31_000);
  assert.equal(later.offlineSeconds, 0);
  assert.equal(later.state.elapsed, newer.state.elapsed + 10);
});

test('same request ID is idempotent and a changed payload cannot reuse it', async () => {
  const repo = new MemoryRepository();
  const initial = await processSync(fresh(), USER, repo, 1000);
  const request = fresh({ revision: initial.revision, actions: [{ type: 'build', x: 16, y: 16, building: 'belt', dir: 1 }] });
  const first = await processSync(request, USER, repo, 1000);
  const repeated = await processSync(request, USER, repo, 3000);
  assert.equal(repeated.replayed, true);
  assert.equal(repeated.state.coins, first.state.coins);
  assert.equal(repo.commits, 2);
  await assert.rejects(processSync({ ...request, actions: [] }, USER, repo, 3000), { status: 409, code: 'request_id_reused' });
});

test('concurrent modifications have one winner and stale revisions never spend', async () => {
  const repo = new MemoryRepository();
  const initial = await processSync(fresh(), USER, repo, 1000);
  const requests = [16, 17].map((x) => fresh({ revision: initial.revision, actions: [{ type: 'build', x, y: 16, building: 'belt', dir: 1 }] }));
  const results = await Promise.allSettled(requests.map((body) => processSync(body, USER, repo, 1000)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'revision_conflict');
  assert.equal(repo.row.state.coins, 300 - BUILDINGS.belt.cost);
  assert.equal(repo.row.revision, 2);
});

test('request fingerprint is independent of property insertion order', async () => {
  const id = randomUUID();
  assert.equal(await requestDigest({ requestId: id, revision: 2, actions: [{ x: 2, type: 'remove', y: 3 }] }),
    await requestDigest({ actions: [{ y: 3, type: 'remove', x: 2 }], revision: 2, requestId: id }));
});

test('server verifies JWT against Auth rather than trusting forged token content', async () => {
  const config = { ...CONFIG, publicKey: CONFIG.key };
  const request = new Request(CONFIG.url, { headers: { Authorization: 'Bearer forged.jwt.signature' } });
  await assert.rejects(verifyUser(request, config, async (url, options) => {
    assert.equal(url, `${CONFIG.url}/auth/v1/user`);
    assert.equal(options.headers.Authorization, 'Bearer forged.jwt.signature');
    return json({ message: 'invalid JWT' }, 401);
  }), { status: 401 });
  await assert.rejects(verifyUser(new Request(CONFIG.url), config, () => { throw new Error('must not call'); }), { status: 401 });
  assert.equal(await verifyUser(request, config, async () => json({ id: USER, email: 'not-returned' })), USER);
});

test('Edge handler enforces authentication, request size, method and rate limits', async () => {
  const repo = new MemoryRepository();
  const env = { get: (key) => ({ SUPABASE_URL: CONFIG.url, SUPABASE_ANON_KEY: CONFIG.key, SUPABASE_SERVICE_ROLE_KEY: 'server-only' })[key] };
  const handler = createHandler({ env, repository: repo, fetchImpl: async () => json({ id: USER }), clock: () => 1000 });
  const request = (body, headers = {}) => new Request(CONFIG.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await handler(new Request(CONFIG.url))).status, 405);
  assert.equal((await handler(request(fresh()))).status, 401);
  assert.equal((await handler(request(fresh({ nickname: 'x'.repeat(17_000) })))).status, 413);
  const response = await handler(request(fresh(), { Authorization: 'Bearer valid.jwt.token' }));
  assert.equal(response.status, 200);
  repo.rateAllowed = false;
  const limited = await handler(request(fresh(), { Authorization: 'Bearer valid.jwt.token' }));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('Retry-After'), '60');
});

test('new server keys stay in apikey and database errors do not leak diagnostics', async () => {
  const repo = new SupabaseRepository({ url: CONFIG.url, secretKey: 'sb_secret_server-only' }, async (_url, options) => {
    assert.equal(options.headers.apikey, 'sb_secret_server-only');
    assert.equal(options.headers.Authorization, undefined);
    return json({ details: 'private data and secret' }, 500);
  });
  await assert.rejects(repo.leaderboard(USER), (error) => {
    assert.equal(error.status, 503);
    assert.ok(!error.message.includes('secret'));
    return true;
  });
});
