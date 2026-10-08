import { randomUUID } from 'node:crypto';
import { advanceFactory, applyAction, hydrateFactory } from './factory.mjs';
import { normalizeNickname } from './nickname.mjs';

/** Owns one authoritative cloud save. Sends actions, active time and a chosen nickname. */
export class CloudGame {
  constructor(client, { nickname, onMessage = () => {}, clock = Date.now, minSyncIntervalMs = 600 } = {}) {
    if (typeof clock !== 'function' || !Number.isFinite(minSyncIntervalMs) || minSyncIntervalMs < 0) throw new TypeError('올바른 동기화 간격이 필요합니다.');
    this.client = client;
    this.nickname = nickname;
    this.onMessage = onMessage;
    this.clock = clock;
    this.minSyncIntervalMs = minSyncIntervalMs;
    this.retryAt = 0;
    this.catchUpNeeded = false;
    this.activeSeconds = 0;
    this.game = null;
    this.revision = null;
    this.queue = [];
    this.queuedNickname = undefined;
    this.pending = null;
    this.flight = null;
    this.status = 'connecting';
    this.message = '클라우드 공장 불러오는 중';
  }

  get retryDelayMs() { return Math.max(0, this.retryAt - this.clock()); }
  get needsSync() { return Boolean(this.pending || this.queue.length || this.queuedNickname !== undefined || this.catchUpNeeded); }
  get pendingNickname() { return this.queuedNickname ?? this.pending?.nickname; }

  async connect() {
    this.activeSeconds = 0;
    this.retryAt = this.clock() + this.minSyncIntervalMs;
    const result = await this.client.sync({ revision: null, actions: [], activeSeconds: 0, requestId: randomUUID(), nickname: this.nickname });
    this.accept(result);
    return this.game;
  }

  trackActiveTime(seconds) {
    // Only short, live frame intervals count. Suspended computers and lost
    // connections must not become production when a request finally succeeds.
    if (this.status !== 'online' || !Number.isFinite(seconds) || seconds <= 0 || seconds > 1) return;
    this.activeSeconds = Math.min(120, this.activeSeconds + seconds);
  }

  accept(result) {
    const state = result?.state;
    if (!state || typeof state !== 'object' || Array.isArray(state) || ![2, 3].includes(state.version) || !Number.isInteger(result.revision)) throw new Error('지원하지 않는 클라우드 저장 형식입니다. 게임을 업데이트하세요.');
    if (Object.hasOwn(state, 'contentVersion') && (!Number.isInteger(state.contentVersion) || state.contentVersion < 1 || state.contentVersion > 2)) throw new Error('지원하지 않는 공장 콘텐츠입니다. 게임을 업데이트하세요.');
    const hasProgression = Object.hasOwn(state, 'progression');
    if (hasProgression ? state.progression?.schema !== 1 : state.version !== 2) throw new Error('지원하지 않는 공장 진행 형식입니다. 게임을 업데이트하세요.');
    const cursor = this.game?.player;
    this.game = hydrateFactory(state, state.savedAt ?? Date.now(), { offline: false }).game;
    if (cursor) this.game.player = { ...cursor };
    this.revision = result.revision;
    this.nickname = result.nickname ?? this.nickname ?? '공장장';
    this.status = 'online';
    this.message = '클라우드 동기화 완료';
  }

  action(action) {
    if (this.status === 'rate_limited') return { ok: false, message: '서버 요청 제한 대기 중입니다. 잠시 후 자동으로 다시 연결합니다.' };
    if (this.status === 'error') return { ok: false, message: '로그인이 만료되었습니다. 게임을 종료하고 다시 로그인하세요.' };
    if (this.status !== 'online') return { ok: false, message: '클라우드 연결을 복구한 뒤 작업할 수 있습니다. [G] 재연결' };
    if (this.queue.length + (this.pending?.actions.length ?? 0) >= 32) return { ok: false, message: '공장 작업을 서버에 반영 중입니다. 잠시 기다려 주세요.' };
    const result = applyAction(this.game, action);
    if (result.ok) this.queue.push(structuredClone(action));
    return result;
  }

  setNickname(value) {
    let nickname;
    try { nickname = normalizeNickname(value); }
    catch (error) { return { ok: false, message: error.message }; }
    if (this.status === 'rate_limited') return { ok: false, message: '서버 요청 제한 대기 중입니다. 잠시 후 자동으로 다시 연결합니다.' };
    if (this.status === 'error') return { ok: false, message: '로그인이 만료되었습니다. 게임을 종료하고 다시 로그인하세요.' };
    if (this.status !== 'online') return { ok: false, message: '클라우드 연결을 복구한 뒤 닉네임을 변경할 수 있습니다. [G] 재연결' };
    // The confirmed name stays visible until the server accepts the request.
    // A newer edit must not mutate an in-flight request's idempotent payload.
    const nextConfirmed = this.pending?.nickname ?? this.nickname;
    this.queuedNickname = nickname === nextConfirmed ? undefined : nickname;
    return { ok: true, message: this.pendingNickname === undefined ? '현재 닉네임을 유지합니다.' : '닉네임 변경을 클라우드에 저장 중입니다.' };
  }

  async sync() {
    if (this.flight) return this.flight;
    if (this.retryDelayMs > 0) return { ok: false, deferred: true, retryAt: this.retryAt };
    this.flight = this.performSync().finally(() => { this.flight = null; });
    return this.flight;
  }

  async performSync(catchUpReplay = true) {
    if (!this.pending) {
      this.pending = { revision: this.revision, actions: this.queue.splice(0, 32), activeSeconds: this.activeSeconds, requestId: randomUUID() };
      this.activeSeconds = 0;
      if (this.queuedNickname !== undefined) {
        this.pending.nickname = this.queuedNickname;
        this.queuedNickname = undefined;
      }
    }
    const request = this.pending;
    this.retryAt = this.clock() + this.minSyncIntervalMs;
    try {
      const response = await this.client.sync(request);
      this.accept(response);
      this.pending = null;
      // The renderer already simulated these in-flight frames. Keep that
      // prediction after adopting the confirmed state; they are sent next time.
      if (this.activeSeconds > 0) advanceFactory(this.game, this.activeSeconds);
      if (request.nickname !== undefined && this.nickname === request.nickname) this.onMessage(`닉네임 저장 완료 · ${this.nickname}`);
      this.catchUpNeeded = Boolean(response.replayed);
      const acceptedQueue = [];
      for (const action of this.queue) {
        const result = applyAction(this.game, action);
        if (result.ok) acceptedQueue.push(action);
        else this.onMessage(`공장 상태 조정 · ${result.message}`);
      }
      this.queue = acceptedQueue;
      for (const result of response.results ?? []) if (!result.ok) this.onMessage(`서버 확인 · ${result.message}`);
      // An idempotent receipt confirms the actions and their active time.
      // Refresh from the current revision after the minimum spacing;
      // retries and receipt handling must obey the same request rate as builds.
      if (response.replayed && catchUpReplay) {
        if (this.retryDelayMs > 0) return { ok: true, deferred: true, retryAt: this.retryAt };
        return this.performSync(false);
      }
      return { ok: true };
    } catch (error) {
      this.activeSeconds = 0;
      if (error.status === 409 && error.payload?.state) {
        try {
          const nicknameDiscarded = this.pendingNickname !== undefined;
          this.accept(error.payload);
          this.pending = null;
          this.queue = [];
          this.queuedNickname = undefined;
          this.catchUpNeeded = false;
          this.onMessage(`다른 접속에서 공장이 변경되어 서버 상태로 갱신했습니다.${nicknameDiscarded ? ' 대기 중인 닉네임 변경은 취소되었습니다.' : ''}`);
          return { ok: false, conflict: true };
        } catch { /* Treat malformed conflict responses as an unavailable server. */ }
      }
      if (error.status === 429) {
        const delay = Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0 ? error.retryAfterMs : 60_000;
        this.retryAt = Math.max(this.retryAt, this.clock() + delay);
        this.status = 'rate_limited';
        this.message = '서버 요청 제한 · 잠시 후 자동으로 재시도합니다.';
        this.onMessage(this.message);
        return { ok: false, deferred: true, retryAt: this.retryAt };
      }
      if (error.status === 401 || error.code === 'login_required') {
        this.status = 'error';
        this.message = error.message || '로그인이 만료되었습니다. 다시 로그인하세요.';
        this.onMessage(this.message);
        return { ok: false, loginRequired: true };
      }
      this.status = 'offline';
      this.message = error.message || '클라우드 연결 실패';
      this.onMessage(`${this.message} · [G] 재연결`);
      // Keep the exact request ID on retry: the server may already have committed it.
      return { ok: false };
    }
  }
}
