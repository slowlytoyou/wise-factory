#!/usr/bin/env node
import { emitKeypressEvents } from 'node:readline';
import { resolve, dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createFactory, advanceFactory, applyAction, buildingAt, RECIPES, shopOffers, prestigeInfo } from './factory.mjs';
import { renderFactory, catalogPageSize, formatGoldRate, formatPlayTime } from './factory-render.mjs';
import { FactoryStore, defaultFactoryPath } from './factory-save.mjs';
import { fitText } from './terminal.mjs';
import { normalizeNickname } from './nickname.mjs';
import { SKINS, getSkin, skinText } from './skins.mjs';
import { PreferencesStore, defaultPreferencesPath } from './preferences.mjs';

const nicknameGraphemes = new Intl.Segmenter('ko', { granularity: 'grapheme' });

const HELP = `
  ✦ WISE FACTORY
  광산 → 컨베이어 → 생산 모듈 → 중앙 상인

  npm start                 개인 로컬 플레이 · 로그인/인터넷 불필요
  npm run local             개인 로컬 플레이를 명시적으로 선택
  npm run demo              생산 라인 데모 (저장 안 함)
  npm run login -- github    선택 기능: 클라우드 로그인 (google도 지원)
  npm run cloud             선택 기능: 클라우드 공장 이어 하기
  npm run classic           이전 별빛 공방 버전

  --demo              데모 모드, 저장 파일 읽기·쓰기 없음
  --snapshot          120×40 텍스트 화면, 저장 파일 읽기·쓰기 없음
  --save PATH         로컬 저장 파일 지정
  --fps 10..60        애니메이션 FPS (기본 24)
  --no-color          색상 없이 실행
  --skin NAME         original / work / work-dev (이번 실행에만 적용)
  --login [provider]  브라우저에서 회원가입 / 로그인
  --logout            로컬 로그인 세션 삭제
  --local             개인 로컬 플레이 (기본값, 로그인 정보 읽지 않음)
  --cloud             선택 기능: 서버가 검증하는 별도 클라우드 공장
  --nickname NAME     닉네임 지정 (클라우드에서는 순위에 공개)
  --leaderboard       클라우드 순위 출력
  --help              도움말

  WASD / 방향키 이동 · 1 채굴기 · 2 벨트 · 3 용광로 · 4 조립기 · 5 전송기
  E / SPACE 설치 · R 회전 · U 강화 · X 철거 · F 레시피 변경
  B 상인 상점 · T 환생 · C 제작법 · L 내 기록(클라우드는 순위) · P 정지 · ? 도움말 · Q 종료
  N 닉네임 설정 · K 스킨 설정 · G 클라우드 모드에서만 재연결

  Original Skin · Work Skin (기존 용어) · Work Skin (프로그래밍 용어)
  K → W/S 또는 1/2/3 선택 → Enter 적용. 스킨은 이 기기에 저장됩니다.

  상인 구역이나 인접 칸에서 B → W/S 선택 → E/Enter 구매.
  용광로·조립기 설계도를 사고, 레이더로 구리·석탄·원목·석영·금을 발견하세요.
  C 생산 도감: W/S 선택 · A/D 페이지 · Enter 제작법 지정 · 최종 생산물 논문.
  상점에서 산 전송기는 5 → E로 설치하면 그 자리에서 물건을 판매합니다.
  T에서 환생 보상·초기화 범위 확인 → E/Enter → Y로 최종 확정합니다.
  OH 코어는 보유만 해도 1개당 모든 판매가 +25%, 소모되지 않습니다.
  권장 120열 × 40행, 최소 88열 × 30행. 좁은 창에서는 맵이 스크롤됩니다.
  로컬 10초 자동 저장 · 게임 실행 중에만 생산합니다.
  개인 플레이에서도 채굴·상점·레이더·전송기·환생을 모두 이용할 수 있습니다.
  로그인해도 npm start는 개인 로컬 저장을 사용합니다.
  클라우드 모드에서는 접속 중 화면만 정지해도 생산을 계속합니다.
  저장 위치: __FACTORY_SAVE_PATH__
  Supabase 설정 안내: docs/CLOUD_SETUP.md
`;

function options(args) {
  const result = { demo: false, fps: 24, color: process.env.NO_COLOR === undefined, snapshot: false, file: defaultFactoryPath() };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') result.help = true;
    else if (['--demo', '--snapshot', '--local', '--cloud', '--logout', '--leaderboard'].includes(arg)) result[arg.slice(2)] = true;
    else if (arg === '--no-color') result.color = false;
    else if (arg === '--login') {
      result.login = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'github';
      if (!['github', 'google'].includes(result.login)) throw new Error('--login은 github 또는 google을 선택하세요.');
    } else if (arg === '--fps') {
      result.fps = Number(args[++i]);
      if (!Number.isInteger(result.fps) || result.fps < 10 || result.fps > 60) throw new Error('--fps는 10–60 사이 정수여야 합니다.');
    } else if (arg === '--save' || arg === '--nickname' || arg === '--skin') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} 뒤에 값이 필요합니다.`);
      if (arg === '--save') { result.file = resolve(value); result.customFile = true; }
      else if (arg === '--skin') {
        if (!SKINS.some(skin => skin.id === value)) throw new Error('--skin은 original, work 또는 work-dev를 선택하세요.');
        result.skin = value;
      }
      else result.nickname = normalizeNickname(value);
    } else throw new Error(`알 수 없는 옵션: ${arg}`);
  }
  if (result.demo && result.cloud) throw new Error('--demo와 --cloud는 함께 사용할 수 없습니다.');
  if (result.customFile && result.file === resolve(defaultPreferencesPath())) {
    throw new Error('--save에는 스킨 설정 경로를 사용할 수 없습니다. 다른 저장 경로를 지정하세요.');
  }
  if (result.cloud && result.customFile) throw new Error('--save는 개인 로컬 저장에만 사용합니다. 클라우드 공장은 npm run cloud로 실행하세요.');
  if (result.local && (result.cloud || result.login || result.logout || result.leaderboard)) {
    throw new Error('--local은 클라우드 명령과 함께 사용할 수 없습니다. 개인 플레이는 npm start로 실행하세요.');
  }
  if ((result.demo || result.snapshot) && (result.login || result.logout || result.leaderboard)) {
    throw new Error('데모·화면 미리보기는 클라우드 계정 명령과 함께 사용할 수 없습니다.');
  }
  return result;
}

async function cloudClient() {
  // Load cloud credentials and networking only for an explicit cloud command.
  const { readCloudConfig, CloudClient } = await import('./cloud.mjs');
  const config = readCloudConfig();
  if (!config) throw new Error('선택 기능인 클라우드의 연결 설정이 없습니다. 설정 절차: docs/CLOUD_SETUP.md');
  const client = new CloudClient(config);
  await client.loadSession();
  return client;
}

async function run(config) {
  const say = text => process.stdout.write(skinText(text, config.skin));
  const warn = text => process.stderr.write(skinText(text, config.skin));
  if (config.help) { process.stdout.write(skinText(HELP, config.skin).replace('__FACTORY_SAVE_PATH__', defaultFactoryPath())); return; }
  if (config.snapshot) {
    const game = createFactory(1_700_000_000_000, { demo: config.demo });
    if (config.nickname !== undefined) game.nickname = config.nickname;
    if (config.demo) advanceFactory(game, 35);
    const ui = { time: 2.6, demo: config.demo, skin: getSkin(config.skin).id, selected: 'belt', direction: 1, recipe: 'iron_plate', logs: [], effects: [], cloud: { status: 'local' } };
    process.stdout.write(renderFactory(game, ui, 120, 40).plain() + '\n');
    return;
  }
  if (config.login || config.logout || config.leaderboard) {
    const client = await cloudClient();
    if (config.logout) { await client.logout(); say('로그아웃했습니다. 클라우드 공장은 보존됩니다.\n'); return; }
    if (config.login) {
      say('선택한 클라우드 로그인 공급자의 지원 여부를 확인하고 있습니다…\n');
      await client.login(config.login);
      say('로그인 완료! npm run cloud로 공장을 시작하세요.\n');
      return;
    }
    if (!client.hasSession()) throw new Error('먼저 npm run login으로 로그인해 주세요.');
    const ranks = await client.leaderboard();
    say(`WISE FACTORY · 월간 판매 리더보드${/^\d{4}-\d{2}$/.test(ranks.month ?? '') ? ` · ${ranks.month}` : ''}\n`);
    say('매월 1일 00:00 (한국 시간) 점수 초기화 · 공장과 OH 코어는 유지\n');
    say('초당 평균 골드 생산량 = 월간 판매액 ÷ 생산 반영 시간 · 접속하여 실행 중에만 생산\n');
    say('총 플레이 시간 (시간:분:초) · 월간 초기화·환생에도 유지\n');
    for (const entry of ranks.entries ?? []) {
      process.stdout.write(`${String(entry.rank).padStart(3)}  ${fitText(entry.nickname, 24)}  `);
      say(`${Math.floor(Number.isFinite(entry.score) ? Math.max(0, entry.score) : 0).toLocaleString('en-US')} C  · ${formatGoldRate(entry.goldPerSecond)} 골드/초 · ${formatPlayTime(entry.playSeconds)}\n`);
    }
    if (!ranks.entries?.length) say('아직 등록된 공장이 없습니다.\n');
    if (ranks.me) say(`내 순위: ${ranks.me.rank}위 · ${Number.isFinite(ranks.me.score) ? Math.max(0, ranks.me.score) : 0} C · ${formatGoldRate(ranks.me.goldPerSecond)} 골드/초 · 총 플레이 시간 ${formatPlayTime(ranks.me.playSeconds)}\n`);
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.TERM === 'dumb') {
    warn('WISE FACTORY는 대화형 터미널에서 실행해 주세요.\n화면 미리보기: npm run snapshot\n');
    process.exitCode = 1;
    return;
  }
  const preferences = config.demo ? null : new PreferencesStore();
  const preference = preferences?.load() ?? { skin: 'original', warning: '' };
  config.skin = getSkin(config.skin ?? preference.skin).id;
  let cloud;
  if (config.cloud) {
    const { CloudGame } = await import('./cloud-game.mjs');
    const client = await cloudClient();
    if (!client.hasSession()) throw new Error('먼저 npm run login으로 로그인해 주세요.');
    say('클라우드 공장을 불러오고 있습니다…\n');
    cloud = new CloudGame(client, { nickname: config.nickname });
    await cloud.connect();
  }
  const store = new FactoryStore(cloud ? join(dirname(defaultFactoryPath()), 'factory-cloud-cache.json') : config.file);
  const loaded = config.demo ? { game: createFactory(Date.now(), { demo: true }) } : cloud ? { game: cloud.game } : store.load();
  let game = loaded.game;
  if (!cloud && config.nickname !== undefined) game.nickname = config.nickname;
  if (config.demo) advanceFactory(game, 35);
  const ui = { time: 0, paused: false, demo: config.demo, effects: [], logs: [], selected: 'belt', direction: 1, recipe: 'iron_plate', help: false, recipes: false, leaderboard: false, shop: false, shopIndex: 0, prestige: false, prestigeConfirm: false, leaders: [], myRank: null, cloud: { status: cloud?.status ?? 'local', nickname: cloud?.nickname ?? '', message: cloud?.message ?? '' }, saveError: loaded.warning ?? '' };
  Object.assign(ui, { nicknameEditor: false, nicknameDraft: '', nicknameError: '', nicknameSaving: false });
  Object.assign(ui, { skin: config.skin, skinPicker: false, skinIndex: 0, skinError: preference.warning });
  let dirty = true;
  const log = message => { ui.logs.unshift(message); ui.logs = ui.logs.slice(0, 8); dirty = true; };
  if (cloud) cloud.onMessage = log;
  log(config.demo ? 'DEMO · 철·구리 생산 라인이 중앙 상인에게 공급합니다.' : cloud ? '클라우드 공장 · 서버 저장 연결됨 · 상인 옆 B 상점' : '개인 플레이 · 로그인 없이 자동 저장 · 상인 옆 B 상점 · L 내 기록');
  if (loaded.warning) log(loaded.warning);
  let nextBoardRefresh = Infinity;
  let previous = null;
  let lastTime = performance.now();
  let lastSave = lastTime;
  let lastCloudSync = lastTime;
  let interval, syncTimer;
  let closed = false, suspended = false, outputBlocked = false, boardLoading = false;
  const originalRaw = process.stdin.isRaw;

  function saveLocal() {
    if (config.demo) return { ok: true };
    const result = store.save(game);
    if (!result.ok && result.message !== ui.saveError) log(result.message);
    ui.saveError = result.ok ? '' : result.message;
    return result;
  }
  async function syncCloud() {
    if (!cloud) return { ok: true };
    const beforeNickname = cloud.nickname;
    const result = await cloud.sync();
    game = cloud.game;
    ui.cloud = { status: cloud.status, nickname: cloud.nickname, message: cloud.message };
    ui.nicknameSaving = cloud.pendingNickname !== undefined;
    if (cloud.nickname !== beforeNickname) {
      ui.leaders = []; ui.myRank = null;
    }
    lastCloudSync = performance.now();
    dirty = true;
    if (!closed && cloud.needsSync && ['online', 'rate_limited'].includes(cloud.status)) queueSync();
    return result;
  }
  function queueSync() {
    if (!cloud || syncTimer || closed) return;
    syncTimer = setTimeout(async () => {
      syncTimer = null;
      await syncCloud();
    }, Math.max(180, cloud.retryDelayMs));
  }
  function restore() {
    if (process.stdin.isTTY) process.stdin.setRawMode(Boolean(originalRaw));
    process.stdin.pause();
    process.stdout.write('\x1b[0m\x1b[?25h\x1b[?7h\x1b[?1049l');
  }
  async function cleanup(code = 0, error) {
    if (closed) return;
    closed = true;
    clearInterval(interval);
    clearTimeout(syncTimer);
    process.stdin.removeListener('keypress', keypress);
    process.stdout.removeListener('resize', resize);
    for (const [signal, handler] of [['SIGINT', sigint], ['SIGTERM', sigterm], ['SIGHUP', sighup], ['SIGTSTP', suspend], ['SIGCONT', resume]]) process.removeListener(signal, handler);
    restore();
    let synced = { ok: true };
    if (cloud) {
      say('클라우드에 마지막 작업을 확인하고 있습니다…\n');
      // Finish a request already in flight and its queued actions, respecting
      // normal spacing without holding terminal exit for a server rate limit.
      for (let attempt = 0; attempt < 4; attempt++) {
        if (cloud.retryDelayMs > 1000) { synced = { ok: false }; break; }
        if (cloud.retryDelayMs > 0) await new Promise(resolve => setTimeout(resolve, cloud.retryDelayMs));
        synced = await syncCloud();
        if (!synced.ok && !synced.deferred) break;
        if (!cloud.needsSync && cloud.activeSeconds === 0 && synced.ok) break;
      }
      if (cloud.needsSync || cloud.activeSeconds > 0) synced = { ok: false };
    }
    const saved = saveLocal();
    if (error) { warn('게임 종료: '); process.stderr.write(`${error.message}\n`); }
    if (!saved.ok) warn(`저장하지 못했습니다: ${saved.message}\n`);
    if (!synced.ok) warn('클라우드 저장을 확인하지 못했습니다. 다음 접속 시 마지막 서버 확인 상태로 이어집니다.\n');
    else if (saved.ok) {
      say(config.demo ? '✦ 공장 데모를 종료했습니다.\n' : cloud ? '✦ 클라우드 공장을 저장했습니다.\n' : '✦ 공장을 저장했습니다.\n');
      if (!config.demo && !cloud) process.stdout.write(`${store.file}\n`);
    }
    process.exitCode = error || !saved.ok || !synced.ok ? 1 : code;
  }
  function resize() { previous = null; dirty = true; }
  function sigint() { void cleanup(); }
  function sigterm() { void cleanup(143); }
  function sighup() { void cleanup(129); }
  function suspend() {
    if (process.platform === 'win32' || suspended || closed) return;
    suspended = true;
    saveLocal();
    restore();
    process.kill(process.pid, 'SIGSTOP');
  }
  function resume() {
    if (closed || !suspended) return;
    suspended = false;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write('\x1b[?1049h\x1b[2J\x1b[?25l\x1b[?7l');
    previous = null;
    lastTime = performance.now();
    if (cloud) queueSync();
  }
  function perform(action) {
    const result = cloud ? cloud.action(action) : applyAction(game, action);
    if (cloud) game = cloud.game;
    log(result.message);
    if (result.ok) {
      ui.effects.push({ x: action.x ?? game.merchant.x, y: action.y ?? game.merchant.y, kind: action.type, time: ui.time });
      queueSync();
    }
    return result;
  }
  function closePanels() {
    ui.help = ui.recipes = ui.leaderboard = ui.shop = ui.prestige = ui.prestigeConfirm = false;
    ui.nicknameEditor = false;
    ui.skinPicker = false;
    dirty = true;
  }
  function openSkins() {
    closePanels();
    ui.skinPicker = true;
    ui.skinIndex = SKINS.findIndex(skin => skin.id === ui.skin);
  }
  function selectSkin(text, name) {
    if (name === 'escape' || name === 'k') { closePanels(); return; }
    if (name === 'w' || name === 'up') ui.skinIndex = (ui.skinIndex + SKINS.length - 1) % SKINS.length;
    else if (name === 's' || name === 'down') ui.skinIndex = (ui.skinIndex + 1) % SKINS.length;
    else if (/^[1-3]$/.test(text ?? '')) ui.skinIndex = Number(text) - 1;
    else if (['e', 'return', 'enter'].includes(name)) {
      ui.skin = config.skin = SKINS[ui.skinIndex].id;
      previous = null;
      const result = preferences?.save(ui.skin) ?? { ok: true };
      ui.skinError = result.ok ? '' : result.message;
      if (result.ok) { closePanels(); log(`스킨 적용 · ${getSkin(ui.skin).name}`); }
      else log(result.message);
    }
    dirty = true;
  }
  function openNickname() {
    closePanels();
    ui.nicknameEditor = true;
    ui.nicknameDraft = cloud?.pendingNickname ?? cloud?.nickname ?? game.nickname ?? '공장장';
    ui.nicknameError = '';
    ui.nicknameSaving = cloud?.pendingNickname !== undefined;
  }
  function editNickname(text, key, name) {
    if (name === 'escape') { closePanels(); return; }
    if (key.ctrl && name === 'u') { ui.nicknameDraft = ''; ui.nicknameError = ''; dirty = true; return; }
    if (name === 'backspace' || name === 'delete' || (key.ctrl && name === 'h')) {
      const parts = [...nicknameGraphemes.segment(ui.nicknameDraft)];
      ui.nicknameDraft = parts.slice(0, -1).map(part => part.segment).join('');
      ui.nicknameError = ''; dirty = true; return;
    }
    if (name === 'return' || name === 'enter') {
      try {
        const nickname = normalizeNickname(ui.nicknameDraft);
        if (cloud) {
          const result = cloud.setNickname(nickname);
          if (!result.ok) { ui.nicknameError = result.message; dirty = true; return; }
          ui.nicknameSaving = cloud.pendingNickname !== undefined;
          closePanels(); log(result.message); queueSync();
        } else {
          const previousNickname = game.nickname;
          game.nickname = nickname;
          const result = saveLocal();
          if (!result.ok) { game.nickname = previousNickname; ui.nicknameError = result.message; dirty = true; return; }
          closePanels(); log(config.demo ? `데모 닉네임 · ${nickname}` : `닉네임 저장 완료 · ${nickname}`);
        }
      } catch (error) { ui.nicknameError = error.message; dirty = true; }
      return;
    }
    // Consume gameplay shortcuts while editing. Terminal escape/control
    // sequences and modifier shortcuts must never become part of a name.
    if (!key.ctrl && !key.meta && typeof text === 'string' && !/[\p{Cc}\p{Cf}]/u.test(text)) {
      if (ui.nicknameDraft.length + text.length <= 80) { ui.nicknameDraft += text; ui.nicknameError = ''; }
      else ui.nicknameError = '닉네임은 최대 20자로 입력하세요.';
      dirty = true;
    }
  }
  async function loadLeaderboard() {
    if (!cloud || boardLoading) return;
    boardLoading = true;
    ui.leaderboardLoading = true;
    nextBoardRefresh = Infinity;
    let refreshAfter = 60_000;
    if (Date.parse(ui.leaderboardResetsAt) <= Date.now()) {
      ui.leaders = []; ui.myRank = null; ui.leaderboardMonth = '';
    }
    ui.cloud.message = '순위 불러오는 중';
    try {
      const ranks = await cloud.client.leaderboard();
      ui.leaders = ranks.entries ?? [];
      ui.myRank = ranks.me ?? null;
      ui.leaderboardMonth = ranks.month;
      ui.leaderboardResetsAt = ranks.resetsAt;
      const untilReset = Date.parse(ranks.resetsAt) - Date.now();
      if (Number.isFinite(untilReset) && untilReset > 0) refreshAfter = Math.min(refreshAfter, Math.max(100, untilReset));
      ui.cloud.message = '서버에서 확인한 월간 판매 순위';
    } catch (error) { ui.cloud.message = error.message; log(error.message); }
    finally {
      boardLoading = false; ui.leaderboardLoading = false;
      nextBoardRefresh = performance.now() + refreshAfter; dirty = true;
    }
  }
  async function showLeaderboard() {
    const opening = !ui.leaderboard;
    closePanels();
    ui.leaderboard = opening;
    if (opening) await loadLeaderboard();
  }
  function keypress(text, key = {}) {
    if (closed || suspended) return;
    try {
      const name = (key.name ?? text ?? '').toLowerCase();
      if (key.ctrl && name === 'c') { void cleanup(); return; }
      if (key.ctrl && name === 'z') { suspend(); return; }
      if (ui.nicknameEditor) { editNickname(text, key, name); return; }
      if (ui.skinPicker) { selectSkin(text, name); return; }
      if (name === 'q') { void cleanup(); return; }
      if (name === 'escape') { closePanels(); return; }
      if (name === 'k') { openSkins(); return; }
      if (text === '?' || name === 'h') { const opening = !ui.help; closePanels(); ui.help = opening; return; }
      if (name === 'c') {
        const opening = !ui.recipes; closePanels(); ui.recipes = opening;
        if (opening) ui.recipeIndex = Math.max(0, Object.keys(RECIPES).indexOf(buildingAt(game, game.player.x, game.player.y)?.recipe || ui.recipe));
        return;
      }
      if (name === 'l') { void showLeaderboard(); return; }
      if (name === 'g') { if (cloud) queueSync(); else log('개인 플레이 · 이 기기에 자동 저장 중입니다.'); return; }
      if (name === 'b') {
        const opening = !ui.shop;
        closePanels();
        if (!opening) return;
        if (Math.max(Math.abs(game.player.x - game.merchant.x), Math.abs(game.player.y - game.merchant.y)) > 2) {
          log('중앙 상인 구역 또는 인접 칸으로 이동한 뒤 [B]를 누르세요.');
          return;
        }
        ui.shop = true;
        return;
      }
      if (name === 't') { const opening = !ui.prestige; closePanels(); ui.prestige = opening; return; }
      if (name === 'n' && !ui.prestige) { openNickname(); return; }
      if (ui.shop) {
        const offers = shopOffers(game);
        if (name === 'w' || name === 'up') ui.shopIndex = (ui.shopIndex + offers.length - 1) % offers.length;
        else if (name === 's' || name === 'down') ui.shopIndex = (ui.shopIndex + 1) % offers.length;
        else if (['a', 'left', 'pageup'].includes(name)) ui.shopIndex = Math.max(0, ui.shopIndex - catalogPageSize(process.stdout.rows || 40, 'shop'));
        else if (['d', 'right', 'pagedown'].includes(name)) ui.shopIndex = Math.min(offers.length - 1, ui.shopIndex + catalogPageSize(process.stdout.rows || 40, 'shop'));
        else if (name === 'home') ui.shopIndex = 0;
        else if (name === 'end') ui.shopIndex = offers.length - 1;
        else if (/^[1-9]$/.test(text ?? '') && Number(text) <= offers.length) ui.shopIndex = Number(text) - 1;
        else if (['e', 'return', 'enter', 'space'].includes(name) || text === ' ') {
          if (ui.paused) log('일시 정지를 해제한 뒤 구매하세요. [ESC] → [P]');
          else perform({ type: 'purchase', item: offers[ui.shopIndex].id });
        }
        dirty = true;
        return;
      }
      if (ui.prestige) {
        if (name === 'n') { ui.prestigeConfirm = false; dirty = true; return; }
        if (ui.paused) {
          if (['e', 'return', 'enter', 'y'].includes(name)) log('일시 정지를 해제한 뒤 환생하세요. [ESC] → [P]');
          return;
        }
        if (!ui.prestigeConfirm && ['e', 'return', 'enter'].includes(name)) {
          if (prestigeInfo(game).available) ui.prestigeConfirm = true;
          else log('환생은 이번 회차 판매액 5,000 C부터 가능합니다.');
        } else if (ui.prestigeConfirm && name === 'y') {
          const result = perform({ type: 'prestige' });
          if (result.ok) {
            closePanels(); ui.selected = 'belt'; ui.recipe = 'iron_plate'; ui.effects = [];
            saveLocal();
          }
        }
        dirty = true;
        return;
      }
      if (ui.recipes) {
        const ids = Object.keys(RECIPES);
        if (name === 'w' || name === 'up') ui.recipeIndex = (ui.recipeIndex + ids.length - 1) % ids.length;
        else if (name === 's' || name === 'down') ui.recipeIndex = (ui.recipeIndex + 1) % ids.length;
        else if (['a', 'left', 'pageup'].includes(name)) ui.recipeIndex = Math.max(0, ui.recipeIndex - catalogPageSize(process.stdout.rows || 40));
        else if (['d', 'right', 'pagedown'].includes(name)) ui.recipeIndex = Math.min(ids.length - 1, ui.recipeIndex + catalogPageSize(process.stdout.rows || 40));
        else if (name === 'home') ui.recipeIndex = 0;
        else if (name === 'end') ui.recipeIndex = ids.length - 1;
        else if (['e', 'return', 'enter'].includes(name)) {
          const recipe = ids[ui.recipeIndex];
          const here = buildingAt(game, game.player.x, game.player.y);
          if (here?.type === RECIPES[recipe].building) {
            if (ui.paused) { log('일시 정지를 해제한 뒤 제작법을 바꾸세요. [ESC] → [P]'); return; }
            if (!perform({ type: 'recipe', x: here.x, y: here.y, recipe }).ok) return;
          }
          ui.recipe = recipe; ui.selected = RECIPES[recipe].building;
          closePanels(); log(`제작법 선택: ${RECIPES[recipe].name}`);
        }
        dirty = true;
        return;
      }
      if (ui.help || ui.leaderboard) return;
      if (name === 'p') {
        ui.paused = !ui.paused;
        log(ui.paused ? cloud ? '화면 정지 · 접속 중 생산은 계속됩니다. [P] 재개' : '일시 정지 · [P]로 공장 재개' : '공장을 다시 표시합니다.');
        if (cloud && !ui.paused) queueSync();
        return;
      }
      if (ui.paused) return;
      const moves = { w: [0, -1], up: [0, -1], s: [0, 1], down: [0, 1], a: [-1, 0], left: [-1, 0], d: [1, 0], right: [1, 0] };
      if (moves[name]) {
        const [dx, dy] = moves[name];
        applyAction(game, { type: 'move', dx, dy });
        dirty = true;
        return;
      }
      if (/^[1-5]$/.test(text ?? '')) {
        ui.selected = ['miner', 'belt', 'smelter', 'assembler', 'transmitter'][Number(text) - 1];
        const recipes = Object.entries(RECIPES).filter(([, r]) => r.building === ui.selected);
        if (recipes.length && RECIPES[ui.recipe]?.building !== ui.selected) ui.recipe = recipes[0][0];
        dirty = true;
        return;
      }
      const { x, y } = game.player;
      const here = buildingAt(game, x, y);
      if (name === 'r') {
        ui.direction = ((here?.dir ?? ui.direction) + 1) % 4;
        if (here) perform({ type: 'rotate', x, y });
        else log(`설치 방향: ${['북 ↑', '동 →', '남 ↓', '서 ←'][ui.direction]}`);
      } else if (name === 'u') perform({ type: 'upgrade', x, y });
      else if (name === 'x' || name === 'backspace') perform({ type: 'remove', x, y });
      else if (name === 'f') {
        const type = here?.type ?? ui.selected;
        const ids = Object.keys(RECIPES).filter(id => RECIPES[id].building === type);
        if (!ids.length) { log('제련소 또는 조립기를 선택하면 제작법을 바꿀 수 있습니다.'); return; }
        const previousId = here?.recipe ?? ui.recipe;
        ui.recipe = ids[(ids.indexOf(previousId) + 1) % ids.length];
        if (here) perform({ type: 'recipe', x, y, recipe: ui.recipe });
        else log(`제작법: ${RECIPES[ui.recipe].name}`);
      } else if (name === 'e' || name === 'space' || text === ' ') {
        perform({ type: 'build', x, y, building: ui.selected, dir: ui.direction, recipe: ui.recipe });
      }
      dirty = true;
    } catch (error) { void cleanup(1, error); }
  }
  function frame() {
    if (closed || suspended) return;
    try {
      const now = performance.now();
      const elapsed = Math.max(0, (now - lastTime) / 1000);
      // A suspended process or sleeping computer does not earn production.
      const dt = elapsed <= 1 ? elapsed : 0;
      lastTime = now;
      if (cloud) cloud.trackActiveTime(dt);
      if (!ui.paused && (!cloud || cloud.status === 'online')) {
        ui.time += Math.min(dt, .25);
        const update = advanceFactory(game, dt);
        for (const event of update.events ?? []) {
          if (event.type === 'sale' || event.type === 'craft') ui.effects.push({ x: event.x, y: event.y, kind: event.type, time: ui.time });
        }
        if (update.earned > 0) log(`상인에게 납품 · +${update.earned.toLocaleString('en-US')} C`);
        ui.effects = ui.effects.filter(effect => ui.time - effect.time <= 1.2);
        if (ui.effects.length > 64) ui.effects = ui.effects.slice(-64);
      }
      if (cloud && ui.leaderboard && now >= nextBoardRefresh) void loadLeaderboard();
      if (now - lastSave >= 10_000) { saveLocal(); lastSave = now; }
      if (cloud && now - lastCloudSync >= 60_000) { lastCloudSync = now; queueSync(); }
      if (outputBlocked || (ui.paused && previous && !dirty)) return;
      const screen = renderFactory(game, ui, process.stdout.columns || 120, process.stdout.rows || 40);
      const output = (previous ? '' : '\x1b[2J') + screen.render(previous, { color: config.color });
      if (output) outputBlocked = !process.stdout.write(output);
      previous = screen;
      dirty = false;
    } catch (error) { void cleanup(1, error); }
  }
  process.stdout.on('drain', () => { outputBlocked = false; });
  process.stdout.on('error', error => { void cleanup(1, error); });
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('keypress', keypress);
  process.stdout.on('resize', resize);
  for (const [signal, handler] of [['SIGINT', sigint], ['SIGTERM', sigterm], ['SIGHUP', sighup], ['SIGTSTP', suspend], ['SIGCONT', resume]]) process.on(signal, handler);
  process.stdout.write('\x1b[?1049h\x1b[2J\x1b[?25l\x1b[?7l');
  interval = setInterval(frame, 1000 / config.fps);
  frame();
}

let config;
try { config = options(process.argv.slice(2)); await run(config); }
catch (error) {
  process.stderr.write(`${error.message}\n`);
  if (config && (config.cloud || config.login || config.logout || config.leaderboard)) {
    process.stderr.write(skinText('개인 로컬 플레이는 로그인 없이 이용할 수 있습니다: npm start\n개인 공장 저장은 클라우드 연결과 별도로 유지됩니다.\n', config.skin));
  }
  process.stderr.write('도움말: node src/main.mjs --help\n');
  process.exitCode = 1;
}
