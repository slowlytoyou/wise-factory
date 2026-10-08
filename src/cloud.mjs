import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIG_FILE = fileURLToPath(new URL('../config/cloud.json', import.meta.url));
const DEFAULT_CONFIG_FILE = fileURLToPath(new URL('../config/cloud.default.json', import.meta.url));
const DEFAULT_PORT = 53682;
const cleanMessage = (value) => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 220);

export class CloudError extends Error {
  constructor(message, { status = 0, code = 'cloud_error', payload = null, retryAfterMs = 0 } = {}) {
    super(cleanMessage(message));
    this.name = 'CloudError';
    this.status = status;
    this.code = code;
    this.payload = payload;
    this.retryAfterMs = retryAfterMs;
  }
}

function validateConfig(config) {
  let url;
  try { url = new URL(config.url); } catch { throw new Error('Supabase 프로젝트 URL을 확인하세요.'); }
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)
      || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))) {
    throw new Error('Supabase URL은 HTTPS 프로젝트 주소여야 합니다. 로컬 개발만 HTTP를 허용합니다.');
  }
  const key = String(config.key ?? config.publishableKey ?? '').trim();
  let legacyRole;
  try { legacyRole = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role; } catch { /* opaque key */ }
  if (key.startsWith('sb_secret_') || legacyRole === 'service_role') {
    throw new Error('관리자 secret/service_role 키는 CLI에 사용할 수 없습니다. publishable 공개 키를 사용하세요.');
  }
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key) && legacyRole !== 'anon') {
    throw new Error('Supabase publishable 공개 키 또는 기존 anon 키를 설정하세요.');
  }
  const port = Number(config.port ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('로그인 포트는 1024~65535여야 합니다.');
  return { url: url.origin, key, port };
}

function readConfigFile(path, label) {
  if (!path) return null;
  let file;
  try { file = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`${label}을 읽을 수 없습니다. JSON 형식을 확인하세요.`);
  }
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error(`${label}은 URL과 공개 키를 담은 JSON 객체여야 합니다.`);
  return file;
}

export function readCloudConfig({ env = process.env, configFile = CONFIG_FILE, defaultConfigFile = DEFAULT_CONFIG_FILE } = {}) {
  const environmentKey = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY;
  // A project URL and its key are one pair. Never combine an override URL with
  // the shared server's key (or silently switch a broken override to that server).
  const file = env.SUPABASE_URL || environmentKey
    ? { url: env.SUPABASE_URL, key: environmentKey }
    : readConfigFile(configFile, 'config/cloud.json') ?? readConfigFile(defaultConfigFile, 'config/cloud.default.json') ?? {};
  const url = file.url;
  const key = file.publishableKey || file.key;
  if (!url && !key) return null;
  if (!url || !key) throw new Error('SUPABASE_URL과 SUPABASE_PUBLISHABLE_KEY를 함께 설정하세요. docs/CLOUD_SETUP.md 참고.');
  return validateConfig({ url, key, port: env.STARFALL_AUTH_PORT || file.port });
}

function openBrowser(url) {
  const command = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : ['xdg-open', [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command[1], { stdio: 'ignore', detached: true, shell: false });
    child.once('error', () => reject(new Error('브라우저를 열 수 없습니다. 표시된 로그인 URL을 직접 여세요.')));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export class CloudClient {
  constructor(config, { fetchImpl = globalThis.fetch, sessionFile, callbackPort, callbackTimeoutMs = 180_000 } = {}) {
    if (!config) throw new Error('클라우드 설정이 없습니다. docs/CLOUD_SETUP.md를 확인하세요.');
    this.config = validateConfig(config);
    this.fetch = fetchImpl;
    const project = createHash('sha256').update(this.config.url).digest('hex').slice(0, 24);
    this.sessionFile = sessionFile ?? join(homedir(), '.config', 'starfall-idle', 'cloud', `${project}.json`);
    this.callbackPort = callbackPort ?? this.config.port;
    this.callbackTimeoutMs = callbackTimeoutMs;
    this.session = null;
    this.refreshPromise = null;
  }

  hasSession() { return Boolean(this.session?.refresh_token && this.session?.access_token); }

  async loadSession() {
    try {
      const stored = JSON.parse(await readFile(this.sessionFile, 'utf8'));
      if (stored.project !== this.config.url || !stored.session || typeof stored.session.access_token !== 'string'
          || typeof stored.session.refresh_token !== 'string' || !Number.isFinite(stored.session.expires_at)) {
        this.session = null;
        return false;
      }
      await chmod(this.sessionFile, 0o600);
      this.session = stored.session;
      return this.hasSession();
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) { this.session = null; return false; }
      throw new Error('로그인 정보를 읽을 수 없습니다. 세션 파일의 접근 권한을 확인하세요.');
    }
  }

  async saveSession(data) {
    if (typeof data.access_token !== 'string' || typeof data.refresh_token !== 'string'
        || !data.access_token || !data.refresh_token) throw new Error('서버가 올바른 로그인 정보를 반환하지 않았습니다.');
    const expires = Number(data.expires_at ?? (Date.now() / 1000 + Number(data.expires_in ?? 3600)));
    if (!Number.isFinite(expires)) throw new Error('로그인 만료 정보가 올바르지 않습니다.');
    // Do not persist provider tokens or the private email/profile in our session file.
    const session = { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: expires, user: { id: data.user?.id } };
    await mkdir(dirname(this.sessionFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.sessionFile}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ project: this.config.url, session }), { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.sessionFile);
      await chmod(this.sessionFile, 0o600);
      this.session = session;
    } finally { await rm(temporary, { force: true }); }
  }

  async request(path, { method = 'POST', body, token } = {}) {
    let response;
    try {
      response = await this.fetch(`${this.config.url}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { apikey: this.config.key, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new CloudError('클라우드에 연결할 수 없습니다. 네트워크와 프로젝트 주소를 확인하세요.', { code: 'network_error' }); }
    let payload = null;
    if (response.status !== 204) {
      try { payload = await response.json(); }
      catch { if (response.ok) throw new CloudError('클라우드 응답 형식이 올바르지 않습니다.', { code: 'invalid_response' }); }
    }
    if (!response.ok) {
      const retryAfter = response.headers.get('Retry-After');
      const retryDelay = retryAfter === null ? NaN : /^\d+(\.\d+)?$/.test(retryAfter.trim())
        ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
      const retryAfterMs = Number.isFinite(retryDelay) && retryDelay > 0 ? Math.ceil(retryDelay) : 0;
      throw new CloudError(payload?.message || payload?.error_description || payload?.msg || `클라우드 요청 실패 (${response.status})`, {
        status: response.status, code: payload?.code || payload?.error_code || 'request_failed', payload, retryAfterMs,
      });
    }
    return payload;
  }

  async login(provider = 'github', onUrl) {
    if (!['github', 'google'].includes(provider)) throw new Error('로그인은 github 또는 google을 선택하세요.');
    const settings = await this.request('/auth/v1/settings', { method: 'GET' });
    const enabled = settings?.external?.[provider];
    if (enabled === false) {
      const name = provider === 'github' ? 'GitHub' : 'Google';
      throw new CloudError(`${name} 클라우드 로그인이 아직 준비되지 않았습니다. npm start로 로그인 없이 모든 게임 기능을 로컬에서 즐길 수 있습니다.`, { code: 'provider_disabled' });
    }
    if (enabled !== true) {
      throw new CloudError('클라우드 로그인 가능 여부를 확인할 수 없습니다. npm start로 로그인 없이 로컬 플레이를 시작할 수 있습니다.', { code: 'invalid_response' });
    }
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(32).toString('hex');
    const callbackPath = `/auth/callback/${state}`;
    let finish;
    const callback = new Promise((resolve, reject) => { finish = (error, code) => error ? reject(error) : resolve(code); });
    // The rejection may occur while an async onUrl handler is still running.
    callback.catch(() => {});
    let consumed = false;
    const server = createServer((req, res) => {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const candidate = Buffer.from(url.pathname);
      const expected = Buffer.from(callbackPath);
      const stateMatches = candidate.length === expected.length && timingSafeEqual(candidate, expected);
      if (req.method !== 'GET' || req.headers.host !== `127.0.0.1:${server.address().port}` || !stateMatches || consumed) {
        res.writeHead(404); res.end('Not found'); return;
      }
      const code = url.searchParams.get('code');
      if (!code && !url.searchParams.has('error')) { res.writeHead(400); res.end('Missing authorization code'); return; }
      consumed = true;
      if (url.searchParams.has('error')) {
        res.writeHead(400); res.end('로그인이 취소되었거나 실패했습니다. 터미널로 돌아가세요.');
        finish(new Error('소셜 로그인이 취소되었거나 실패했습니다. 다시 로그인하세요.'));
      } else if (code.length > 4096) {
        res.writeHead(400); res.end('Invalid code'); finish(new Error('로그인 코드가 올바르지 않습니다.'));
      } else {
        res.end('인증 응답을 받았습니다. 터미널로 돌아가 로그인 결과를 확인하세요.'); finish(null, code);
      }
    });
    let timer;
    const interrupted = () => finish(new Error('로그인을 취소했습니다.'));
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(this.callbackPort, '127.0.0.1', resolve); });
      timer = setTimeout(() => finish(new Error('로그인 시간이 초과되었습니다. 다시 로그인하세요.')), this.callbackTimeoutMs);
      process.once('SIGINT', interrupted);
      const authUrl = new URL(`${this.config.url}/auth/v1/authorize`);
      authUrl.search = new URLSearchParams({ provider,
        redirect_to: `http://127.0.0.1:${server.address().port}${callbackPath}`,
        code_challenge: challenge, code_challenge_method: 's256',
      }).toString();
      if (onUrl) await onUrl(authUrl.href);
      else {
        process.stdout.write(`브라우저에서 로그인하세요: ${authUrl.href}\n`);
        await openBrowser(authUrl.href);
      }
      const authCode = await callback;
      const data = await this.request('/auth/v1/token?grant_type=pkce', { body: { auth_code: authCode, code_verifier: verifier } });
      await this.saveSession(data);
      return { user: this.session.user, provider };
    } catch (error) {
      if (error.code === 'EADDRINUSE') throw new Error(`로그인 포트 ${this.callbackPort}가 사용 중입니다. 다른 로그인 창을 닫고 다시 시도하세요.`);
      throw error;
    } finally {
      clearTimeout(timer);
      process.removeListener('SIGINT', interrupted);
      server.close();
      server.closeAllConnections();
    }
  }

  async refreshSession() {
    if (this.refreshPromise) return this.refreshPromise;
    if (!this.hasSession()) throw new CloudError('먼저 --login으로 로그인하세요.', { code: 'login_required', status: 401 });
    this.refreshPromise = (async () => {
      try {
        const data = await this.request('/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: this.session.refresh_token } });
        await this.saveSession(data);
        return this.session;
      } catch (error) {
        if (error.status === 400 || error.status === 401) {
          this.session = null;
          await rm(this.sessionFile, { force: true });
          throw new CloudError('로그인이 만료되었습니다. --login으로 다시 로그인하세요.', { status: 401, code: 'login_required' });
        }
        throw error;
      } finally { this.refreshPromise = null; }
    })();
    return this.refreshPromise;
  }

  async authenticated(path, options) {
    if (!this.hasSession()) throw new CloudError('먼저 --login으로 로그인하세요.', { status: 401, code: 'login_required' });
    if (this.session.expires_at <= Date.now() / 1000 + 60) await this.refreshSession();
    try { return await this.request(path, { ...options, token: this.session.access_token }); }
    catch (error) {
      if (error.status !== 401) throw error;
      await this.refreshSession();
      return this.request(path, { ...options, token: this.session.access_token });
    }
  }

  async sync({ revision = null, actions = [], activeSeconds = 0, requestId = randomUUID(), nickname } = {}) {
    if (!Array.isArray(actions) || actions.length > 32) throw new Error('동기화 작업은 한 번에 최대 32개입니다.');
    if (!Number.isFinite(activeSeconds) || activeSeconds < 0 || activeSeconds > 120) throw new Error('실행 시간은 0–120초 사이여야 합니다.');
    return this.authenticated('/functions/v1/factory-sync', { body: { revision, actions, activeSeconds, requestId, ...(nickname === undefined ? {} : { nickname }) } });
  }

  async leaderboard() { return this.authenticated('/functions/v1/factory-leaderboard', { method: 'GET' }); }

  async logout() {
    let error;
    try {
      if (this.hasSession()) await this.authenticated('/auth/v1/logout?scope=local', { body: {} });
    } catch (caught) { error = caught; }
    finally { this.session = null; await rm(this.sessionFile, { force: true }); }
    if (error) throw new CloudError('이 기기의 로그인 정보는 삭제했습니다. 서버 세션 해제는 연결 문제로 확인하지 못했습니다.', { code: 'logout_remote_unconfirmed' });
  }
}
