#!/usr/bin/env node
import { emitKeypressEvents } from 'node:readline';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createGame, tick, buyUpgrade, pulse, prestige, canPrestige, toggleAutomation } from './model.mjs';
import { renderGame, number } from './render.mjs';
import { SaveStore, defaultSavePath } from './save.mjs';

const HELP = `
  ✦ STARFALL · 별빛 공방
  유성의 별가루로 키우는 작은 우주 공방

  실행: npm run classic
        node src/classic.mjs [옵션]

  --demo            모든 설비가 움직이는 데모 (저장하지 않음)
  --fps 10..60      애니메이션 프레임 속도 (기본 24)
  --save PATH       저장 파일 지정
  --no-color        색상 없이 실행
  --snapshot        110×38 텍스트 화면 출력 (저장하지 않음)
  --help            도움말

  1–5 설비 구매 · SPACE 수집 · A 자동 구매 · R 승천
  P 일시 정지 · ? 도움말 · Q 저장하고 종료

  최소 88열 × 32행, 권장 110열 × 38행, UTF-8 터미널.
  10초마다 자동 저장 · 오프라인 생산 최대 8시간.
  저장 위치: ${defaultSavePath()}
`;

function options(args) {
  const result = { demo: false, fps: 24, color: process.env.NO_COLOR === undefined, snapshot: false, file: defaultSavePath() };
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (argument === '--help' || argument === '-h') result.help = true;
    else if (argument === '--demo') result.demo = true;
    else if (argument === '--snapshot') result.snapshot = true;
    else if (argument === '--no-color') result.color = false;
    else if (argument === '--fps') {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 10 || value > 60) throw new Error('--fps는 10–60 사이 정수여야 합니다.');
      result.fps = value;
    } else if (argument === '--save') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('--save 뒤에 저장 파일 경로가 필요합니다.');
      result.file = resolve(value);
    } else throw new Error(`알 수 없는 옵션: ${argument}`);
  }
  return result;
}

function demoGame() {
  const game = createGame();
  game.levels = [8, 5, 4, 2, 1];
  game.dust = 12840;
  game.lifetimeDust = 42800;
  game.runDust = 22000;
  game.prestigeCount = 1;
  game.autoBuy = true;
  tick(game, .01);
  return game;
}

function run(config) {
  if (config.help) { process.stdout.write(HELP); return; }
  if (config.snapshot) {
    const game = config.demo ? demoGame() : createGame();
    process.stdout.write(renderGame(game, { time: 2.6, demo: config.demo, logs: [], effects: [] }, 110, 38).plain() + '\n');
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.TERM === 'dumb') {
    process.stderr.write('별빛 공방은 대화형 터미널에서 실행해 주세요.\n화면 미리보기: npm run classic -- --snapshot\n');
    process.exitCode = 1;
    return;
  }

  const store = new SaveStore(config.file);
  const loaded = config.demo ? { game: demoGame(), offlineEarned: 0, offlineSeconds: 0 } : store.load();
  const game = loaded.game;
  const ui = { time: 0, paused: false, demo: config.demo, effects: [], logs: [], help: false, confirmPrestige: false, saveError: loaded.warning ?? '' };
  const log = text => { ui.logs.unshift(text); ui.logs = ui.logs.slice(0, 8); };
  if (loaded.offlineEarned > 0) log(`다시 오셨군요! ${Math.floor(loaded.offlineSeconds / 60)}분 동안 별가루 +${number(loaded.offlineEarned)} ✦`);
  else log(config.demo ? '데모 모드 · 모든 설비 가동 중 · 저장 파일에 영향을 주지 않습니다.' : '공방 가동 시작 · [1]로 첫 채집 드론을 구매해 보세요.');
  if (loaded.warning) log(loaded.warning);

  let previous = null;
  let lastTime = performance.now();
  let lastSave = lastTime;
  let interval;
  let closed = false;
  let suspended = false;
  let dirty = false;
  let saveError = loaded.warning ?? '';
  let blockedOutput = false;
  const originalRaw = process.stdin.isRaw;
  const save = () => {
    if (config.demo) return { ok: true, message: '데모 종료 · 저장하지 않았습니다.' };
    const result = store.save(game);
    if (!result.ok && saveError !== result.message) log(result.message);
    saveError = result.ok ? '' : result.message;
    ui.saveError = saveError;
    return result;
  };
  const restore = () => {
    if (process.stdin.isTTY) process.stdin.setRawMode(Boolean(originalRaw));
    process.stdin.pause();
    process.stdout.write('\x1b[0m\x1b[?25h\x1b[?7h\x1b[?1049l');
  };
  const cleanup = (code = 0, error) => {
    if (closed) return;
    closed = true;
    clearInterval(interval);
    process.stdin.removeListener('keypress', keypress);
    process.stdout.removeListener('resize', resize);
    process.removeListener('SIGINT', sigint);
    process.removeListener('SIGTERM', sigterm);
    process.removeListener('SIGHUP', sighup);
    process.removeListener('SIGTSTP', suspend);
    process.removeListener('SIGCONT', resume);
    const result = save();
    restore();
    if (error) process.stderr.write(`게임을 종료했습니다: ${error.message}\n`);
    process.stdout.write(config.demo ? '✦ 별빛 공방 데모를 종료했습니다.\n' : result.ok ? `✦ 공방을 저장했습니다. 다음에 만나요!\n${store.file}\n` : `저장하지 못했습니다: ${result.message}\n`);
    process.exitCode = error || !result.ok ? 1 : code;
  };

  function resize() { previous = null; dirty = true; }
  function sigint() { cleanup(); }
  function sigterm() { cleanup(143); }
  function sighup() { cleanup(129); }
  function suspend() {
    if (process.platform === 'win32' || suspended || closed) return;
    suspended = true;
    save();
    // Keep the timer referenced so Node can dispatch SIGCONT after stdin pauses.
    restore();
    process.kill(process.pid, 'SIGSTOP');
  }
  function resume() {
    if (closed || !suspended) return;
    suspended = false;
    if (!ui.paused) tick(game, Math.max(0, (performance.now() - lastTime) / 1000)).events.forEach(log);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write('\x1b[?1049h\x1b[2J\x1b[?25l\x1b[?7l');
    previous = null;
    lastTime = performance.now();
  }
  function effect(kind, label) { ui.effects.push({ kind, label, time: ui.time }); }
  function keypress(text, key = {}) {
    try {
      const name = (key.name ?? text ?? '').toLowerCase();
      if ((key.ctrl && name === 'c') || name === 'q') { cleanup(); return; }
      if (key.ctrl && name === 'z') { suspend(); return; }
      if (ui.confirmPrestige) {
        if (name === 'y') {
          const result = prestige(game);
          log(result.message);
          if (result.ok) { effect('purchase', '✦ 새로운 별의 탄생 ✦'); save(); }
          ui.confirmPrestige = false;
        } else if (name === 'n' || name === 'escape') ui.confirmPrestige = false;
        dirty = true;
        return;
      }
      if (name === 'escape') { ui.help = false; dirty = true; return; }
      if (text === '?' || name === 'h') { ui.help = !ui.help; dirty = true; return; }
      if (ui.help) return;
      if (name === 'p') { ui.paused = !ui.paused; log(ui.paused ? '공방을 잠시 멈췄습니다. [P]로 다시 시작하세요.' : '공방이 다시 가동됩니다.'); dirty = true; return; }
      if (ui.paused) return;
      if (/^[1-5]$/.test(text ?? '')) {
        const result = buyUpgrade(game, Number(text) - 1);
        log(result.message);
        if (result.ok) effect('purchase', 'UPGRADE ✦');
      } else if (name === 'space' || text === ' ') {
        const result = pulse(game);
        if (result.ok) { effect('pulse', `+${number(result.earned)} ✦`); log(result.message); }
      } else if (name === 'a') log(toggleAutomation(game).message);
      else if (name === 'r') {
        if (canPrestige(game)) ui.confirmPrestige = true;
        else log('이번 회차에서 25,000 별가루를 모으면 승천할 수 있습니다.');
      }
      dirty = true;
    } catch (error) { cleanup(1, error); }
  }

  function frame() {
    if (closed || suspended) return;
    try {
      const now = performance.now();
      const dt = Math.max(0, (now - lastTime) / 1000);
      lastTime = now;
      if (!ui.paused) {
        ui.time += Math.min(dt, .25);
        const update = tick(game, dt);
        update.events.forEach(log);
        if (update.events.some(event => event.startsWith('자동 구매'))) effect('purchase', 'AUTO ✦');
        ui.effects = ui.effects.filter(item => ui.time - item.time <= 1.3);
      }
      if (now - lastSave >= 10_000) { save(); lastSave = now; }
      if (blockedOutput || (ui.paused && previous && !dirty)) return;
      const screen = renderGame(game, ui, process.stdout.columns || 110, process.stdout.rows || 38);
      const output = (previous ? '' : '\x1b[2J') + screen.render(previous, { color: config.color });
      if (output) blockedOutput = !process.stdout.write(output);
      previous = screen;
      dirty = false;
    } catch (error) { cleanup(1, error); }
  }

  process.stdout.on('drain', () => { blockedOutput = false; });
  process.stdout.on('error', error => cleanup(1, error));
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('keypress', keypress);
  process.stdout.on('resize', resize);
  process.on('SIGINT', sigint);
  process.on('SIGTERM', sigterm);
  process.on('SIGHUP', sighup);
  process.on('SIGTSTP', suspend);
  process.on('SIGCONT', resume);
  process.stdout.write('\x1b[?1049h\x1b[2J\x1b[?25l\x1b[?7l');
  interval = setInterval(frame, 1000 / config.fps);
  frame();
}

try { run(options(process.argv.slice(2))); }
catch (error) { process.stderr.write(`${error.message}\n도움말: node src/classic.mjs --help\n`); process.exitCode = 1; }
