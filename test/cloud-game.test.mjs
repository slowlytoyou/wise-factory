import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudGame } from '../src/cloud-game.mjs';
import { createFactory, applyAction, serializeFactory, advanceFactory, BUILDINGS, SHOP_ITEMS } from '../src/factory.mjs';

const response = (game, revision) => ({ state: serializeFactory(game, 1000000), revision, nickname: 'test', results: [] });
// Existing simulation tests bypass scheduling; cooldown behavior has its own fake-clock tests below.
const coordinator = (client, options = {}) => new CloudGame(client, { minSyncIntervalMs: 0, ...options });
const build = { type: 'build', x: 17, y: 16, building: 'belt', dir: 1 };
test('loads grant no active time and recorded frames wait for periodic sync without creating a request loop', async () => {
  const server = createFactory(1000000), calls = [];
  const cloud = coordinator({ sync: async request => {
    calls.push(structuredClone(request));
    return response(server, calls.length - 1);
  } });
  cloud.trackActiveTime(1);
  await cloud.connect();
  assert.equal(calls[0].activeSeconds, 0);
  for (const seconds of [-1, 0, NaN, Infinity, '1', 1.01, 60, 8 * 3600]) cloud.trackActiveTime(seconds);
  assert.equal(cloud.activeSeconds, 0, 'sleep intervals and malformed durations cannot accrue');
  for (let i = 0; i < 160; i++) {
    cloud.trackActiveTime(.5);
    assert.equal(cloud.needsSync, false, 'each frame must not schedule another network request');
  }
  assert.equal(calls.length, 1);
  assert.equal(cloud.activeSeconds, 80);
  for (let i = 0; i < 100; i++) cloud.trackActiveTime(1);
  assert.equal(cloud.activeSeconds, 120, 'an unusually slow request cannot grow an unbounded time backlog');
  await cloud.sync();
  assert.equal(calls[1].activeSeconds, 120);
  assert.equal(cloud.activeSeconds, 0);
  assert.equal(cloud.needsSync, false);
});

test('successful in-flight frames remain predicted and are credited exactly once on the next request', async () => {
  const server = createFactory(1000000), requests = [];
  let release;
  const cloud = coordinator({ sync: async request => {
    if (request.revision === null) return response(server, 0);
    requests.push(structuredClone(request));
    if (requests.length === 1) await new Promise(resolve => { release = resolve; });
    advanceFactory(server, request.activeSeconds);
    return response(server, requests.length);
  } });
  await cloud.connect();
  for (let i = 0; i < 5; i++) cloud.trackActiveTime(1);
  const flight = cloud.sync();
  for (let i = 0; i < 3; i++) cloud.trackActiveTime(1);
  release();
  await flight;
  assert.equal(requests[0].activeSeconds, 5);
  assert.equal(server.elapsed, 5);
  assert.equal(cloud.activeSeconds, 3);
  assert.equal(cloud.game.elapsed, 8);
  assert.equal(cloud.needsSync, false);
  await cloud.sync();
  assert.equal(requests[1].activeSeconds, 3);
  assert.equal(server.elapsed, 8);
  assert.equal(cloud.game.elapsed, 8);
});

test('a long disconnected gap keeps the exact receipt retry and never accrues a recovery reward', async () => {
  const server = createFactory(1000000), requests = [];
  let now = 0, release;
  const cloud = coordinator({ sync: async request => {
    if (request.revision === null) return response(server, 0);
    requests.push(structuredClone(request));
    if (requests.length === 1) {
      await new Promise(resolve => { release = resolve; });
      advanceFactory(server, request.activeSeconds);
      throw new Error('response lost');
    }
    return { ...response(server, 1), replayed: requests.length === 2 };
  } }, { clock: () => now });
  await cloud.connect();
  for (let i = 0; i < 5; i++) cloud.trackActiveTime(1);
  const flight = cloud.sync();
  for (let i = 0; i < 3; i++) cloud.trackActiveTime(1);
  release(); await flight;
  assert.equal(cloud.activeSeconds, 0, 'unconfirmed in-flight frames are discarded on disconnection');
  now += 8 * 3600 * 1000;
  for (let i = 0; i < 100; i++) cloud.trackActiveTime(1);
  assert.equal(cloud.activeSeconds, 0);
  await cloud.sync();
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(requests[2].activeSeconds, 0);
  assert.equal(cloud.game.elapsed, 5);
});

test('rate limits, expired sessions and conflicts discard unsent active frames', async () => {
  for (const status of [429, 401, 409]) {
    const server = createFactory(1000000);
    let now = 0, release;
    const cloud = coordinator({ sync: async request => {
      if (request.revision === null) return response(server, 0);
      await new Promise(resolve => { release = resolve; });
      throw Object.assign(new Error('sync rejected'), { status, payload: response(server, 2), retryAfterMs: 2000 });
    } }, { clock: () => now });
    await cloud.connect();
    cloud.trackActiveTime(1);
    const flight = cloud.sync();
    cloud.trackActiveTime(.5);
    release();
    await flight;
    assert.equal(cloud.activeSeconds, 0);
    if (status === 409) {
      assert.equal(cloud.pending, null);
      assert.equal(cloud.game.elapsed, 0);
      assert.equal(cloud.needsSync, false);
    } else {
      assert.equal(cloud.pending.activeSeconds, 1, 'the immutable request remains safe to retry');
      now += 3600000;
      cloud.trackActiveTime(1);
      assert.equal(cloud.activeSeconds, 0);
    }
  }
});

test('cloud sends action requests and discards optimistic scores in favor of server state', async () => {
  const server = createFactory(1000000), calls = [];
  const client = { sync: async request => {
    calls.push(structuredClone(request));
    if (request.revision !== null) request.actions.forEach(action => applyAction(server, action));
    return response(server, calls.length - 1);
  } };
  const cloud = coordinator(client);
  await cloud.connect();
  assert.equal(cloud.action(build).ok, true);
  cloud.game.lifetimeRevenue = 1e15;
  cloud.game.player = { x: 12, y: 12 };
  await cloud.sync();
  assert.equal(cloud.game.lifetimeRevenue, 0);
  assert.equal(cloud.game.coins, 296);
  assert.deepEqual(cloud.game.player, { x: 12, y: 12 });
  assert.deepEqual(calls[1].actions, [build]);
  assert.equal(Object.hasOwn(calls[1], 'state'), false);
  assert.equal(Object.hasOwn(calls[1], 'score'), false);
});
test('uncertain network outcomes retry identical idempotency key and block new construction', async () => {
  const server = createFactory(1000000), calls = [];
  let fail = true;
  const cloud = coordinator({ sync: async request => {
    if (request.revision === null) return response(server, 0);
    calls.push(structuredClone(request));
    if (fail) { fail = false; applyAction(server, request.actions[0]); throw new Error('lost response'); }
    return response(server, 1);
  } });
  await cloud.connect(); cloud.action(build);
  assert.equal((await cloud.sync()).ok, false);
  assert.equal(cloud.status, 'offline');
  assert.equal(cloud.action({ ...build, x: 18 }).ok, false);
  assert.equal((await cloud.sync()).ok, true);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(cloud.game.coins, 296);
  assert.equal(cloud.status, 'online');
});
test('concurrent-device conflict adopts server state and never merges balances', async () => {
  const server = createFactory(1000000);
  const cloud = coordinator({ sync: async request => {
    if (request.revision === null) return response(server, 0);
    server.coins = 123;
    throw Object.assign(new Error('conflict'), { status: 409, payload: response(server, 4) });
  } });
  await cloud.connect(); cloud.action(build);
  assert.equal((await cloud.sync()).conflict, true);
  assert.equal(cloud.game.coins, 123);
  assert.equal(cloud.pending, null);
  assert.deepEqual(cloud.queue, []);
});
test('an action queued during a request survives reconciliation exactly once', async () => {
  const server = createFactory(1000000);
  let release;
  const cloud = coordinator({ sync: async request => {
    if (request.revision === null) return response(server, 0);
    await new Promise(resolve => { release = resolve; });
    request.actions.forEach(action => applyAction(server, action));
    return response(server, 1);
  } });
  await cloud.connect(); cloud.action(build);
  const flight = cloud.sync();
  cloud.action({ ...build, x: 18 });
  release(); await flight;
  assert.equal(cloud.queue.length, 1);
  assert.equal(cloud.game.coins, 292);
  assert.equal(cloud.game.buildings.filter(b => b.y === 16).length, 2);
});

test('replayed receipts refresh the server state without repeating construction or awarding offline time', async () => {
  const server = createFactory(1000000), requests = [];
  const cloud = coordinator({ sync: async request => {
    if (request.revision === null) return response(server, 0);
    requests.push(structuredClone(request));
    if (requests.length === 1) {
      applyAction(server, request.actions[0]);
      advanceFactory(server, request.activeSeconds);
      throw new Error('committed but response lost');
    }
    if (requests.length === 2) return { ...response(server, 1), replayed: true };
    advanceFactory(server, request.activeSeconds);
    return response(server, 2);
  } });
  await cloud.connect(); cloud.action(build);
  for (let i = 0; i < 60; i++) cloud.trackActiveTime(1);
  assert.equal((await cloud.sync()).ok, false);
  assert.equal((await cloud.sync()).ok, true);
  assert.equal(requests.length, 3);
  assert.equal(requests[0].requestId, requests[1].requestId);
  assert.notEqual(requests[1].requestId, requests[2].requestId);
  assert.deepEqual(requests[2].actions, []);
  assert.equal(requests[2].activeSeconds, 0);
  assert.equal(cloud.game.elapsed, 60);
  assert.ok(cloud.game.lifetimeRevenue > 0);
  assert.equal(cloud.game.buildings.length, createFactory().buildings.length + 1);
});

test('blueprint purchases and dependent builds are predicted and reconciled as actions only', async () => {
  const server = createFactory(1000000), requests = [];
  server.coins = 100000;
  const cloud = coordinator({ sync: async request => {
    requests.push(structuredClone(request));
    const results = request.actions.map(action => applyAction(server, action));
    return { ...response(server, requests.length - 1), results };
  } });
  await cloud.connect();
  const purchase = { type: 'purchase', item: 'smelter_blueprint' };
  const smelter = { ...build, building: 'smelter' };
  assert.equal(cloud.action(smelter).ok, false);
  assert.equal(cloud.action(purchase).ok, true);
  assert.equal(cloud.action(smelter).ok, true);
  const expectedCoins = 100000 - SHOP_ITEMS.find(item => item.id === purchase.item).cost - BUILDINGS.smelter.cost;
  assert.equal(cloud.game.coins, expectedCoins);
  await cloud.sync();
  assert.deepEqual(requests[1].actions, [purchase, smelter]);
  assert.equal(Object.hasOwn(requests[1], 'progression'), false);
  assert.equal(cloud.game.coins, expectedCoins);
  assert.equal(cloud.game.progression.unlocks.smelter, true);
});

test('prestige and a new build queued during a purchase retain their order after reconciliation', async () => {
  const server = createFactory(1000000);
  server.coins = 100000;
  server.lifetimeRevenue = 5000;
  server.progression.runRevenue = 5000;
  let release, sent = 0;
  const cloud = coordinator({ sync: async request => {
    if (request.revision === null) return response(server, 0);
    if (++sent === 1) await new Promise(resolve => { release = resolve; });
    const results = request.actions.map(action => applyAction(server, action));
    return { ...response(server, sent), results };
  } });
  await cloud.connect();
  assert.equal(cloud.action({ type: 'purchase', item: 'smelter_blueprint' }).ok, true);
  const flight = cloud.sync();
  const predictedGame = cloud.game;
  assert.equal(cloud.action({ type: 'prestige' }).ok, true);
  assert.equal(cloud.game, predictedGame, 'prestige resets the existing game object');
  assert.equal(cloud.action(build).ok, true);
  release(); await flight;
  assert.deepEqual(cloud.queue, [{ type: 'prestige' }, build]);
  assert.equal(cloud.game.progression.cores, 1);
  assert.equal(cloud.game.progression.unlocks.smelter, false);
  assert.equal(cloud.game.coins, 300 - BUILDINGS.belt.cost);
  assert.equal(server.progression.cores, 0);
  await cloud.sync();
  assert.equal(cloud.queue.length, 0);
  assert.equal(cloud.game.progression.cores, 1);
  assert.equal(server.progression.cores, 1);
  assert.equal(server.coins, 300 - BUILDINGS.belt.cost);
  assert.equal(cloud.game.lifetimeRevenue, 5000);
});

test('lost prestige responses retry once and replay queued construction without repeating the reset', async () => {
  const server = createFactory(1000000), requests = [];
  server.lifetimeRevenue = 5000;
  server.progression.runRevenue = 5000;
  let release;
  const cloud = coordinator({ sync: async request => {
    if (request.revision === null) return response(server, 0);
    requests.push(structuredClone(request));
    if (requests.length === 1) {
      await new Promise(resolve => { release = resolve; });
      assert.equal(applyAction(server, request.actions[0]).ok, true);
      throw new Error('prestige committed but response lost');
    }
    if (requests.length === 2) return { ...response(server, 1), replayed: true };
    const results = request.actions.map(action => applyAction(server, action));
    return { ...response(server, 2), results };
  } });
  await cloud.connect();
  assert.equal(cloud.action({ type: 'prestige' }).ok, true);
  const flight = cloud.sync();
  assert.equal(cloud.action(build).ok, true);
  release();
  assert.equal((await flight).ok, false);
  assert.equal(cloud.status, 'offline');
  assert.equal((await cloud.sync()).ok, true);
  assert.deepEqual(requests[0], requests[1]);
  assert.deepEqual(requests[2].actions, [build]);
  assert.notEqual(requests[1].requestId, requests[2].requestId);
  assert.equal(cloud.game.progression.cores, 1);
  assert.equal(cloud.game.progression.prestigeCount, 1);
  assert.equal(cloud.game.coins, 300 - BUILDINGS.belt.cost);
  assert.equal(cloud.queue.length, 0);
});

test('a server-denied optimistic prestige restores the authoritative progression and factory', async () => {
  const server = createFactory(1000000), messages = [];
  server.coins = 1200;
  const cloud = coordinator({ sync: async request => {
    const results = request.actions.map(action => applyAction(server, action));
    return { ...response(server, request.revision === null ? 0 : 1), results };
  } }, { onMessage: message => messages.push(message) });
  await cloud.connect();
  // Prediction is never authority: an edited local value cannot mint cores.
  cloud.game.progression.runRevenue = 5000;
  assert.equal(cloud.action({ type: 'prestige' }).ok, true);
  assert.equal(cloud.game.progression.cores, 1);
  await cloud.sync();
  assert.equal(cloud.game.progression.cores, 0);
  assert.equal(cloud.game.progression.prestigeCount, 0);
  assert.equal(cloud.game.progression.runRevenue, 0);
  assert.equal(cloud.game.coins, 1200);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /서버 확인/);
});

test('future and malformed cloud saves never replace the predicted factory or discard pending actions', async () => {
  for (const variant of ['version', 'schema', 'missing', 'malformed', 'content']) {
    const server = createFactory(1000000);
    const cloud = coordinator({ sync: async request => {
      const result = response(server, request.revision === null ? 0 : 1);
      if (request.revision !== null) {
        if (variant === 'version') result.state.version = 4;
        else if (variant === 'content') result.state.contentVersion = 3;
        else if (variant === 'schema') result.state.progression.schema = 2;
        else if (variant === 'missing') { result.state.version = 3; delete result.state.progression; }
        else result.state.progression = null;
      }
      return result;
    } });
    await cloud.connect();
    cloud.action(build);
    const predicted = cloud.game, before = structuredClone(predicted);
    assert.equal((await cloud.sync()).ok, false);
    assert.equal(cloud.status, 'offline');
    assert.equal(cloud.game, predicted);
    assert.deepEqual(cloud.game, before);
    assert.equal(cloud.revision, 0);
    assert.deepEqual(cloud.pending.actions, [build]);
  }
});

test('the cloud coordinator still loads legacy version2 saves for migration', async () => {
  const result = response(createFactory(1000000), 0);
  result.state.version = 2;
  delete result.state.progression;
  const cloud = coordinator({ sync: async () => result });
  await cloud.connect();
  assert.equal(cloud.game.version, 3);
  assert.equal(cloud.game.progression.radarLevel, 2);
  assert.deepEqual(cloud.game.progression.unlocks, { smelter: true, assembler: true });
});

test('default sync spacing batches rapid input below the server request limit without timers', async () => {
  const server = createFactory(1000000), dispatches = [];
  let now = 0;
  const cloud = new CloudGame({ sync: async request => {
    dispatches.push({ at: now, request: structuredClone(request) });
    const results = request.actions.map(action => applyAction(server, action));
    return { ...response(server, dispatches.length - 1), results };
  } }, { clock: () => now });
  await cloud.connect();
  cloud.action(build);
  assert.equal(cloud.retryDelayMs, 600);
  assert.equal(cloud.needsSync, true);
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.deepEqual(await cloud.sync(), { ok: false, deferred: true, retryAt: 600 });
  }
  assert.equal(dispatches.length, 1, 'cooldown calls must not dispatch requests');
  assert.equal(cloud.pending, null, 'a cooldown must not consume queued actions into a request');
  assert.deepEqual(cloud.queue, [build]);
  for (now = 100; now < 60_000; now += 100) {
    assert.equal(cloud.action({ type: 'rotate', x: 12, y: 14 }).ok, true);
    await cloud.sync();
  }
  assert.equal(dispatches.length, 100, 'one connection plus spaced syncs stay below 120/minute');
  assert.ok(dispatches.slice(1).every((entry, i) => entry.at - dispatches[i].at >= 600));
  assert.ok(dispatches.slice(1).some(entry => entry.request.actions.length > 1), 'rapid actions are batched');
  assert.equal((await cloud.sync()).ok, true);
  assert.equal(cloud.needsSync, false);
  assert.equal(server.coins, 296);
});

test('429 waits until Retry-After, preserves the exact request and resumes automatically without extra spending', async () => {
  const server = createFactory(1000000), calls = [];
  let now = 0;
  const cloud = new CloudGame({ sync: async request => {
    if (request.revision === null) return response(server, 0);
    calls.push(structuredClone(request));
    if (calls.length === 1) throw Object.assign(new Error('limited'), { status: 429, retryAfterMs: 2000 });
    request.actions.forEach(action => applyAction(server, action));
    return response(server, 1);
  } }, { clock: () => now });
  await cloud.connect();
  cloud.action(build);
  now = 600;
  assert.deepEqual(await cloud.sync(), { ok: false, deferred: true, retryAt: 2600 });
  assert.equal(cloud.status, 'rate_limited');
  assert.equal(cloud.needsSync, true);
  assert.match(cloud.action({ ...build, x: 18 }).message, /자동/);
  assert.equal(cloud.queue.length, 0);
  for (now = 601; now < 2600; now += 17) assert.equal((await cloud.sync()).deferred, true);
  assert.equal(calls.length, 1, 'manual retries cannot bypass the cooldown');
  assert.deepEqual(cloud.pending, calls[0]);
  now = 2600;
  assert.equal((await cloud.sync()).ok, true);
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(cloud.status, 'online');
  assert.equal(cloud.needsSync, false);
  assert.equal(cloud.game.coins, 296);
  assert.equal(cloud.game.buildings.filter(b => b.x === 17 && b.y === 16).length, 1);
});

test('429 without a valid retry delay returns immediately with a one-minute recovery deadline', async () => {
  for (const retryAfterMs of [undefined, 0, -1, NaN, Infinity]) {
    let now = 0, requests = 0;
    const cloud = new CloudGame({ sync: async request => {
      requests++;
      if (request.revision === null) return response(createFactory(1000000), 0);
      throw Object.assign(new Error('limited'), { status: 429, retryAfterMs });
    } }, { clock: () => now });
    await cloud.connect();
    now = 600;
    const result = await cloud.sync();
    assert.equal(result.deferred, true);
    assert.equal(cloud.retryAt, 60_600);
    assert.equal(cloud.retryDelayMs, 60_000);
    assert.equal(cloud.needsSync, true, 'an empty periodic request must also be retried');
    now = 60_599;
    assert.equal((await cloud.sync()).deferred, true);
    assert.equal(requests, 2);
  }
});

test('receipt replay schedules fresh catchup after spacing while retaining queued actions', async () => {
  const server = createFactory(1000000), requests = [];
  let now = 0;
  const cloud = new CloudGame({ sync: async request => {
    if (request.revision === null) return response(server, 0);
    requests.push(structuredClone(request));
    if (requests.length === 1) {
      request.actions.forEach(action => applyAction(server, action));
      advanceFactory(server, request.activeSeconds);
      throw new Error('response lost');
    }
    if (requests.length === 2) return { ...response(server, 1), replayed: true };
    request.actions.forEach(action => applyAction(server, action));
    advanceFactory(server, request.activeSeconds);
    return response(server, 2);
  } }, { clock: () => now });
  await cloud.connect();
  cloud.action(build);
  for (let i = 0; i < 60; i++) cloud.trackActiveTime(1);
  now = 600;
  assert.equal((await cloud.sync()).ok, false);
  now = 1200;
  assert.deepEqual(await cloud.sync(), { ok: true, deferred: true, retryAt: 1800 });
  assert.equal(requests.length, 2, 'a replay must not trigger a second unspaced dispatch');
  assert.equal(cloud.pending, null);
  assert.equal(cloud.needsSync, true, 'catchup remains scheduled even with no queued actions');
  assert.equal(cloud.action({ ...build, x: 18 }).ok, true);
  assert.equal((await cloud.sync()).deferred, true);
  now = 1800;
  assert.equal((await cloud.sync()).ok, true);
  assert.deepEqual(requests[0], requests[1]);
  assert.notEqual(requests[2].requestId, requests[1].requestId);
  assert.deepEqual(requests[2].actions, [{ ...build, x: 18 }]);
  assert.equal(cloud.needsSync, false);
  assert.equal(cloud.game.buildings.filter(b => b.y === 16).length, 2);
  assert.ok(cloud.game.lifetimeRevenue > 0);
});

test('expired authentication remains distinct from temporary rate limits and network outages', async () => {
  const errors = [
    { error: Object.assign(new Error('login again'), { code: 'login_required' }), status: 'error', loginRequired: true },
    { error: Object.assign(new Error('unauthorized'), { status: 401 }), status: 'error', loginRequired: true },
    { error: new Error('network unavailable'), status: 'offline', loginRequired: undefined },
  ];
  for (const entry of errors) {
    const cloud = coordinator({ sync: async request => {
      if (request.revision === null) return response(createFactory(1000000), 0);
      throw entry.error;
    } });
    await cloud.connect();
    cloud.action(build);
    const result = await cloud.sync();
    assert.equal(cloud.status, entry.status);
    assert.equal(result.loginRequired, entry.loginRequired);
    assert.equal(result.deferred, undefined);
    assert.equal(cloud.needsSync, true);
    assert.equal(cloud.action({ ...build, x: 18 }).ok, false);
  }
});

test('nickname-only changes normalize, obey sync spacing and become visible only after confirmation', async () => {
  const server = createFactory(1000000), requests = [], messages = [];
  let now = 0, release;
  const cloud = new CloudGame({ sync: async request => {
    if (request.revision === null) return response(server, 0);
    requests.push(structuredClone(request));
    await new Promise(resolve => { release = resolve; });
    return { ...response(server, 1), nickname: request.nickname };
  } }, { clock: () => now, onMessage: message => messages.push(message) });
  await cloud.connect();
  assert.equal(cloud.setNickname('  Ｆａｃｔｏｒｙ   공장  ').ok, true);
  assert.equal(cloud.pendingNickname, 'Factory 공장');
  assert.equal(cloud.nickname, 'test');
  assert.equal(cloud.needsSync, true);
  assert.equal((await cloud.sync()).deferred, true);
  assert.equal(requests.length, 0);
  now = 600;
  const flight = cloud.sync();
  assert.equal(cloud.nickname, 'test');
  assert.equal(cloud.pendingNickname, 'Factory 공장');
  assert.deepEqual(requests[0].actions, []);
  assert.equal(requests[0].nickname, 'Factory 공장');
  assert.deepEqual(Object.keys(requests[0]).sort(), ['actions', 'activeSeconds', 'nickname', 'requestId', 'revision']);
  release();
  assert.equal((await flight).ok, true);
  assert.equal(cloud.nickname, 'Factory 공장');
  assert.equal(cloud.pendingNickname, undefined);
  assert.equal(cloud.needsSync, false);
  assert.match(messages[0], /저장 완료.*Factory 공장/);
});

test('invalid nickname edits leave the confirmed name and an existing queued change intact', async () => {
  const cloud = coordinator({ sync: async () => response(createFactory(1000000), 0) });
  await cloud.connect();
  assert.equal(cloud.setNickname('별빛 공장').ok, true);
  for (const invalid of ['', ' ', 'a', 'x'.repeat(21), 'hi!', 'factory\nname', '\u001b[31mname', null, 123]) {
    assert.equal(cloud.setNickname(invalid).ok, false);
    assert.equal(cloud.pendingNickname, '별빛 공장');
    assert.equal(cloud.nickname, 'test');
  }
  assert.equal(cloud.setNickname('test').ok, true);
  assert.equal(cloud.pendingNickname, undefined);
  assert.equal(cloud.needsSync, false, 'reverting an unsent change needs no request');
});

test('a newer nickname queued during an in-flight rename survives confirmation and is sent separately', async () => {
  const server = createFactory(1000000), requests = [];
  let release;
  const cloud = coordinator({ sync: async request => {
    if (request.revision === null) return response(server, 0);
    requests.push(structuredClone(request));
    if (requests.length === 1) await new Promise(resolve => { release = resolve; });
    return { ...response(server, requests.length), nickname: request.nickname };
  } });
  await cloud.connect();
  cloud.setNickname('첫 번째');
  const flight = cloud.sync();
  assert.equal(cloud.setNickname('두 번째').ok, true);
  assert.equal(cloud.pendingNickname, '두 번째');
  assert.equal(cloud.pending.nickname, '첫 번째');
  release();
  await flight;
  assert.equal(cloud.nickname, '첫 번째');
  assert.equal(cloud.pendingNickname, '두 번째');
  assert.equal(cloud.needsSync, true);
  await cloud.sync();
  assert.equal(cloud.nickname, '두 번째');
  assert.equal(cloud.pendingNickname, undefined);
  assert.equal(requests[1].revision, 1);
  assert.notEqual(requests[1].requestId, requests[0].requestId);
  assert.deepEqual(requests.map(request => request.nickname), ['첫 번째', '두 번째']);
});

test('an uncertain nickname commit retries its exact payload before sending a newer queued name', async () => {
  const server = createFactory(1000000), requests = [];
  let release;
  const cloud = coordinator({ sync: async request => {
    if (request.revision === null) return response(server, 0);
    requests.push(structuredClone(request));
    if (requests.length === 1) {
      await new Promise(resolve => { release = resolve; });
      throw new Error('rename committed but response lost');
    }
    if (requests.length === 2) return { ...response(server, 1), nickname: request.nickname, replayed: true };
    return { ...response(server, 2), nickname: request.nickname };
  } });
  await cloud.connect();
  cloud.setNickname('첫 번째');
  const flight = cloud.sync();
  cloud.setNickname('최종 이름');
  release();
  assert.equal((await flight).ok, false);
  assert.equal(cloud.nickname, 'test');
  assert.equal(cloud.pendingNickname, '최종 이름');
  assert.equal(cloud.setNickname('오프라인 변경').ok, false);
  assert.equal((await cloud.sync()).ok, true);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[1], requests[0]);
  assert.notEqual(requests[2].requestId, requests[1].requestId);
  assert.equal(requests[2].nickname, '최종 이름');
  assert.equal(cloud.nickname, '최종 이름');
  assert.equal(cloud.needsSync, false);
});

test('rate-limited nickname requests retain the exact payload and confirmed name until the retry succeeds', async () => {
  const server = createFactory(1000000), requests = [];
  let now = 0;
  const cloud = new CloudGame({ sync: async request => {
    if (request.revision === null) return response(server, 0);
    requests.push(structuredClone(request));
    if (requests.length === 1) throw Object.assign(new Error('limited'), { status: 429, retryAfterMs: 2000 });
    return { ...response(server, 1), nickname: request.nickname };
  } }, { clock: () => now });
  await cloud.connect();
  cloud.setNickname('느긋한 공장');
  now = 600;
  assert.equal((await cloud.sync()).deferred, true);
  assert.equal(cloud.nickname, 'test');
  assert.equal(cloud.pendingNickname, '느긋한 공장');
  assert.equal(cloud.setNickname('다른 공장').ok, false);
  now = 2599;
  assert.equal((await cloud.sync()).deferred, true);
  assert.equal(requests.length, 1);
  now = 2600;
  assert.equal((await cloud.sync()).ok, true);
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(cloud.nickname, '느긋한 공장');
  assert.equal(cloud.needsSync, false);
});

test('nickname revision conflicts adopt the server name and explicitly discard pending and newer edits', async () => {
  const server = createFactory(1000000), messages = [];
  let release;
  const cloud = coordinator({ sync: async request => {
    if (request.revision === null) return response(server, 0);
    await new Promise(resolve => { release = resolve; });
    throw Object.assign(new Error('conflict'), { status: 409, payload: { ...response(server, 4), nickname: '다른 기기' } });
  } }, { onMessage: message => messages.push(message) });
  await cloud.connect();
  cloud.setNickname('변경 중');
  const flight = cloud.sync();
  cloud.setNickname('다음 이름');
  release();
  assert.equal((await flight).conflict, true);
  assert.equal(cloud.nickname, '다른 기기');
  assert.equal(cloud.pendingNickname, undefined);
  assert.equal(cloud.queuedNickname, undefined);
  assert.equal(cloud.pending, null);
  assert.equal(cloud.needsSync, false);
  assert.match(messages.at(-1), /닉네임 변경은 취소/);
});

test('reverting to the old name during a rename still queues the reversal after that rename is confirmed', async () => {
  const server = createFactory(1000000), requests = [];
  let release;
  const cloud = coordinator({ sync: async request => {
    if (request.revision === null) return response(server, 0);
    requests.push(structuredClone(request));
    if (requests.length === 1) await new Promise(resolve => { release = resolve; });
    return { ...response(server, requests.length), nickname: request.nickname };
  } });
  await cloud.connect();
  cloud.setNickname('새로운 이름');
  const flight = cloud.sync();
  cloud.setNickname('중간 이름');
  cloud.setNickname('새로운 이름');
  assert.equal(cloud.queuedNickname, undefined, 'choosing the in-flight name cancels only the unsent edit');
  cloud.setNickname('test');
  assert.equal(cloud.pendingNickname, 'test');
  release();
  await flight;
  assert.equal(cloud.nickname, '새로운 이름');
  assert.equal(cloud.needsSync, true);
  await cloud.sync();
  assert.equal(cloud.nickname, 'test');
  assert.deepEqual(requests.map(request => request.nickname), ['새로운 이름', 'test']);
});
