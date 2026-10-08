import { createFactory, applyAction, serializeFactory } from '../_shared/factory.mjs';
import { hydrateMonthlyFactory, MAX_ACTIVE_SECONDS } from './season.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
export class HttpError extends Error {
  constructor(status, code, message, payload = {}) { super(message); Object.assign(this, { status, code, payload }); }
}

function fail(message) { throw new HttpError(400, 'invalid_request', message); }

export function validateRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('JSON 요청이 필요합니다.');
  if (Object.keys(body).some((key) => !['revision', 'actions', 'requestId', 'nickname', 'activeSeconds'].includes(key))) fail('허용되지 않은 요청 필드입니다. 저장 상태나 점수를 보낼 수 없습니다.');
  if (!UUID.test(body.requestId ?? '')) fail('requestId는 UUID여야 합니다.');
  const revision = body.revision ?? null;
  if (revision !== null && (!Number.isSafeInteger(revision) || revision < 0)) fail('revision이 올바르지 않습니다.');
  if (body.activeSeconds !== undefined && (!Number.isFinite(body.activeSeconds) || body.activeSeconds < 0 || body.activeSeconds > MAX_ACTIVE_SECONDS)) fail('플레이 시간은 0~120초 범위여야 합니다.');
  if (revision === null && (body.activeSeconds ?? 0) !== 0) fail('공장을 불러올 때는 생산 시간을 보낼 수 없습니다.');
  const actions = body.actions ?? [];
  if (!Array.isArray(actions) || actions.length > 32) fail('한 번에 최대 32개 작업을 보낼 수 있습니다.');
  if (revision === null && actions.length) fail('먼저 현재 서버 상태를 불러오세요.');
  const allowed = {
    move: ['type', 'dx', 'dy'], build: ['type', 'x', 'y', 'building', 'dir', 'recipe'],
    rotate: ['type', 'x', 'y'], upgrade: ['type', 'x', 'y'], remove: ['type', 'x', 'y'], recipe: ['type', 'x', 'y', 'recipe'],
    purchase: ['type', 'item'], prestige: ['type'],
  };
  for (const action of actions) {
    if (!action || typeof action !== 'object' || Array.isArray(action)
        || !Object.hasOwn(allowed, action.type) || Object.keys(action).some((key) => !allowed[action.type].includes(key))) fail('허용되지 않은 공장 작업입니다.');
    if (action.type === 'purchase' && (typeof action.item !== 'string' || !action.item)) fail('구매할 품목이 필요합니다.');
    // Costs, unlocks, radar tiers, prestige rewards and construction rules come
    // only from the shared engine running against the stored server state.
    for (const value of Object.values(action)) {
      if (!['string', 'number'].includes(typeof value) || (typeof value === 'string' && value.length > 48)
          || (typeof value === 'number' && !Number.isFinite(value))) fail('작업 값이 올바르지 않습니다.');
    }
  }
  let nickname;
  if (body.nickname !== undefined) {
    if (typeof body.nickname !== 'string') fail('닉네임이 올바르지 않습니다.');
    nickname = body.nickname.normalize('NFKC').trim().replace(/ +/g, ' ');
    if (!/^[\p{L}\p{N}_ -]{2,20}$/u.test(nickname)) fail('닉네임은 2~20자의 문자, 숫자, 공백, _ 또는 -만 사용할 수 있습니다.');
  }
  return { revision, actions, requestId: body.requestId, ...(nickname === undefined ? {} : { nickname }),
    ...(body.activeSeconds === undefined ? {} : { activeSeconds: body.activeSeconds }) };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export async function requestDigest(body) {
  const bytes = new TextEncoder().encode(canonical(body));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function databaseError(result) {
  if (!result?.error) return result;
  const { error, ...payload } = result;
  if (error === 'revision_conflict') throw new HttpError(409, error, '다른 기기에서 공장이 변경되었습니다. 최신 서버 상태를 불러왔습니다.', payload);
  if (error === 'request_id_reused') throw new HttpError(409, error, '같은 requestId를 다른 요청에 사용할 수 없습니다.');
  if (error === 'update_required') throw new HttpError(426, error, '저장 형식이 변경되었습니다. 기존 공장을 보존했으니 서버와 게임을 업데이트하세요.');
  throw new HttpError(500, 'database_error', '클라우드 저장을 완료할 수 없습니다.');
}

// Repository methods are atomic SQL RPCs. Injecting the repository makes race and replay
// semantics testable with Node without importing Deno or handling real credentials.
export async function processSync(input, userId, repository, now = Date.now()) {
  const body = validateRequest(input);
  const hash = await requestDigest(body);
  const initial = serializeFactory(createFactory(now), now);
  const opened = databaseError(await repository.prepare(userId, initial, body.requestId, hash));
  const stored = opened.state;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored) || ![2, 3].includes(stored.version)
      || (Object.hasOwn(stored, 'contentVersion') && (!Number.isInteger(stored.contentVersion) || stored.contentVersion < 1 || stored.contentVersion > 2))
      || (Object.hasOwn(stored, 'progression') ? stored.progression?.schema !== 1 : stored.version !== 2)) {
    throw new HttpError(426, 'update_required', '지원하지 않는 저장 형식입니다. 공장을 보존했습니다. 서버와 게임을 업데이트하세요.');
  }
  if (opened.replayed) return { ...opened, offlineEarned: 0, offlineSeconds: 0 };
  if (body.revision !== null && body.revision !== opened.revision) {
    throw new HttpError(409, 'revision_conflict', '다른 기기에서 공장이 변경되었습니다. 최신 서버 상태를 불러왔습니다.', opened);
  }
  // A request delayed in prepare can observe a save newer than its own clock.
  // Never rewind that server timestamp or later syncs would award the time twice.
  const savedAt = opened.state?.savedAt;
  const simulationTime = Math.max(now, Number.isFinite(savedAt) ? savedAt : now);
  const { game, monthly } = hydrateMonthlyFactory(opened.state, simulationTime, body.activeSeconds ?? 0);
  const results = body.actions.map((action) => applyAction(game, action));
  const state = serializeFactory(game, simulationTime);
  if (!Number.isFinite(state.lifetimeRevenue) || state.lifetimeRevenue < 0) throw new HttpError(500, 'simulation_error', '공장 생산 상태를 계산할 수 없습니다.');
  return databaseError(await repository.commit({
    userId, expectedRevision: opened.revision, requestId: body.requestId, hash,
    state, score: Math.floor(state.lifetimeRevenue), nickname: body.nickname ?? opened.nickname,
    results, offlineEarned: 0, offlineSeconds: 0, monthly,
  }));
}

function namedKey(raw) {
  if (!raw) return undefined;
  try { const keys = JSON.parse(raw); return keys.default || Object.values(keys).find((v) => typeof v === 'string'); }
  catch { return undefined; }
}

export function serverConfig(env) {
  const url = env.get('SUPABASE_URL');
  const publicKey = namedKey(env.get('SUPABASE_PUBLISHABLE_KEYS')) || env.get('SUPABASE_PUBLISHABLE_KEY') || env.get('SUPABASE_ANON_KEY');
  const secretKey = namedKey(env.get('SUPABASE_SECRET_KEYS')) || env.get('SUPABASE_SECRET_KEY') || env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !publicKey || !secretKey) throw new HttpError(503, 'server_not_configured', '서버 환경 변수가 설정되지 않았습니다.');
  return { url: url.replace(/\/$/, ''), publicKey, secretKey };
}

export async function verifyUser(request, config, fetchImpl = fetch) {
  const authorization = request.headers.get('Authorization') || '';
  if (!/^Bearer [A-Za-z0-9_.-]+$/.test(authorization) || authorization.length > 8192) throw new HttpError(401, 'unauthorized', '로그인이 필요합니다.');
  // Never trust a decoded JWT or a userId supplied by the caller.
  const response = await fetchImpl(`${config.url}/auth/v1/user`, {
    headers: { apikey: config.publicKey, Authorization: authorization },
    signal: AbortSignal.timeout(10_000), redirect: 'error',
  });
  if (!response.ok) throw new HttpError(response.status >= 500 ? 503 : 401, 'unauthorized', '로그인을 확인할 수 없습니다. 다시 시도하세요.');
  const user = await response.json();
  if (!UUID.test(user?.id ?? '') || user.is_anonymous) throw new HttpError(401, 'unauthorized', '소셜 계정 로그인이 필요합니다.');
  return user.id;
}

export class SupabaseRepository {
  constructor(config, fetchImpl = fetch) { this.config = config; this.fetch = fetchImpl; }
  async rpc(name, body) {
    const { url, secretKey } = this.config;
    const headers = { apikey: secretKey, 'Content-Type': 'application/json' };
    // New secret keys belong on apikey; legacy service_role JWTs also need Bearer.
    if (!secretKey.startsWith('sb_secret_')) headers.Authorization = `Bearer ${secretKey}`;
    const response = await this.fetch(`${url}/rest/v1/rpc/${name}`, {
      method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000), redirect: 'error',
    });
    if (!response.ok) throw new HttpError(503, 'database_unavailable', '클라우드 DB에 연결할 수 없습니다. 마이그레이션과 서버 설정을 확인하세요.');
    return response.json();
  }
  admit(userId, scope) { return this.rpc('factory_admit', { p_user_id: userId, p_scope: scope }); }
  prepare(userId, state, requestId, hash) {
    return this.rpc('factory_prepare', { p_user_id: userId, p_initial_state: state, p_request_id: requestId, p_hash: hash });
  }
  commit(p) {
    return this.rpc('factory_commit_monthly', {
      p_user_id: p.userId, p_expected_revision: p.expectedRevision, p_request_id: p.requestId, p_hash: p.hash,
      p_state: p.state, p_score: p.score, p_nickname: p.nickname, p_results: p.results,
      p_offline_earned: p.offlineEarned, p_offline_seconds: p.offlineSeconds, p_monthly: p.monthly,
    });
  }
  leaderboard(userId) { return this.rpc('factory_leaderboard', { p_user_id: userId }); }
}

async function boundedJson(request) {
  if (!(request.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json')) throw new HttpError(415, 'invalid_content_type', 'application/json 형식이 필요합니다.');
  if (Number(request.headers.get('Content-Length')) > 16_384) throw new HttpError(413, 'request_too_large', '요청은 16 KiB 이하여야 합니다.');
  const reader = request.body?.getReader();
  if (!reader) fail('JSON 요청이 필요합니다.');
  let size = 0;
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 16_384) { await reader.cancel(); throw new HttpError(413, 'request_too_large', '요청은 16 KiB 이하여야 합니다.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { fail('JSON 형식이 올바르지 않습니다.'); }
}

export function createHandler({ operation = 'sync', env = globalThis.Deno?.env, fetchImpl = globalThis.fetch, clock = Date.now, repository } = {}) {
  return async (request) => {
    try {
      const method = operation === 'sync' ? 'POST' : 'GET';
      if (request.method !== method) return Response.json({ code: 'method_not_allowed', message: `${method} 요청이 필요합니다.` }, { status: 405, headers: { ...JSON_HEADERS, Allow: method } });
      const body = operation === 'sync' ? validateRequest(await boundedJson(request)) : null;
      const config = serverConfig(env);
      const userId = await verifyUser(request, config, fetchImpl);
      const repo = repository ?? new SupabaseRepository(config, fetchImpl);
      if (!await repo.admit(userId, operation)) throw new HttpError(429, 'rate_limited', '요청이 너무 잦습니다. 잠시 후 다시 시도하세요.');
      const payload = operation === 'sync' ? await processSync(body, userId, repo, clock()) : await repo.leaderboard(userId);
      return Response.json(payload, { headers: JSON_HEADERS });
    } catch (error) {
      if (error instanceof HttpError) return Response.json({ ...error.payload, code: error.code, message: error.message }, {
        status: error.status, headers: { ...JSON_HEADERS, ...(error.status === 429 ? { 'Retry-After': '60' } : {}) },
      });
      // Never send stack traces, database diagnostics, keys or private account fields.
      return Response.json({ code: 'server_error', message: '서버 요청을 완료할 수 없습니다. 잠시 후 다시 시도하세요.' }, { status: 503, headers: JSON_HEADERS });
    }
  };
}
