import { Canvas, displayWidth, fitText } from './terminal.mjs';
import { UPGRADES, productionRate, upgradeCost, canPrestige, automationUnlocked } from './model.mjs';

const C = {
  bg: [7, 12, 24], panel: [11, 20, 35], edge: [37, 59, 78], dim: [85, 108, 128],
  text: [198, 217, 229], white: [235, 247, 248], cyan: [96, 232, 222],
  gold: [255, 200, 113], orange: [255, 137, 91], purple: [174, 152, 239], blue: [74, 144, 192],
};
const MACHINE_COLORS = [C.cyan, C.gold, C.orange, C.purple, C.blue];
const lerp = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.max(0, Math.min(1, t))));
const hash = n => { const v = Math.sin(n * 127.1 + 311.7) * 43758.5453; return v - Math.floor(v); };
const centered = (c, x, y, width, text, fg, bg) => c.text(x + Math.max(0, Math.floor((width - displayWidth(text)) / 2)), y, text, fg, bg, width);

export function number(value) {
  if (!Number.isFinite(value)) return 'MAX';
  if (value >= 1e12) return `${(value / 1e12).toFixed(2)}T`;
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e4) return `${(value / 1e3).toFixed(1)}K`;
  return Math.floor(value).toLocaleString('en-US');
}

function bar(c, x, y, width, progress, fg, bg = C.panel) {
  const value = Math.max(0, Math.min(1, progress)) * width;
  for (let i = 0; i < width; i++) c.set(x + i, y, i < Math.floor(value) ? '━' : '─', i < value ? fg : C.edge, bg);
}

function scene(c, x, y, w, h, game, ui) {
  c.box(x, y, w, h, { fg: C.edge, bg: C.bg });
  c.text(x + 2, y, ' ORBITAL WORKSHOP ', C.cyan, C.bg);
  const t = ui.time;
  const ground = y + h - 7;
  const skyHeight = Math.max(4, ground - y - 2);
  const totalLevels = game.levels.reduce((a, b) => a + b, 0);

  // A deep star field: each star has its own brightness phase and tiny orbit.
  for (let i = 0; i < Math.floor(w * skyHeight / 21); i++) {
    const sx = x + 2 + Math.floor(hash(i * 3 + 1) * (w - 4));
    const sy = y + 2 + Math.floor(hash(i * 3 + 2) * Math.max(1, skyHeight - 1));
    const glow = .25 + .75 * (.5 + .5 * Math.sin(t * (.5 + hash(i)) + i * 2));
    c.set(sx, sy, glow > .92 ? '+' : i % 4 === 0 ? '·' : '.', lerp([20, 35, 58], [156, 204, 220], glow));
  }

  // Shaded crescent, using the terminal's rectangular pixel aspect ratio.
  const moonX = x + w - 14, moonY = y + 5;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -5; dx <= 5; dx++) {
    const r = (dx / 5) ** 2 + (dy / 2.7) ** 2;
    if (r <= 1) c.set(moonX + dx, moonY + dy, ' ', C.blue,
      lerp([17, 35, 57], [83, 129, 156], Math.max(0, (-dx / 5 + .2) * .75) * (1 - .25 * r)));
  }
  c.text(moonX - 6, moonY + 4, 'LUNA · 07', C.dim);

  // Falling meteors leave fading tails before they dissolve above the factory.
  for (let i = 0; i < 3; i++) {
    const phase = (t * (.11 + i * .017) + i * .33) % 1;
    const mx = x + 4 + Math.floor((w - 16) * (1 - phase) * (.72 + i * .08));
    const my = y + 2 + Math.floor(phase * Math.max(3, skyHeight - 2));
    for (let k = 3; k >= 0; k--) {
      if (my - k > y + 1 && mx + k * 2 < x + w - 2)
        c.set(mx + k * 2, my - k, k === 0 ? '◆' : '·', lerp(C.bg, i % 2 ? C.gold : C.cyan, 1 - k * .24));
    }
  }

  const coreX = x + Math.floor(w * .45);
  const bob = Math.sin(t * 1.35) > .45 ? -1 : 0;
  const coreY = Math.max(y + 6, ground - 10) + bob;
  // Crystalline asteroid floating on a layered, fractured island.
  const rock = [
    '        /\\        ',
    '     /\\/  \\       ',
    '    /  / /\\\\ /\\   ',
    '   /__/ /  \\/  \\  ',
    '  ▄████████████▄  ',
    '   ▀██▓████▓██▀   ',
    '     ▀██▓██▀      ',
    '       ▀█▀        ',
  ];
  for (let row = 0; row < rock.length; row++) {
    const tone = row < 4 ? lerp(C.blue, C.cyan, .5 + Math.sin(t * 2 + row) * .28) : lerp([25, 45, 68], C.blue, (8 - row) * .09);
    c.text(coreX - 9, coreY + row - 3, rock[row], tone, undefined, Math.min(19, x + w - coreX + 8));
  }
  c.set(coreX, coreY - 2, '◆', C.white);
  c.set(coreX - 2, coreY - 1, '╱', C.gold);

  // Drones swing on independent paths and draw moving mining beams.
  const drones = Math.min(4, 1 + Math.ceil(game.levels[0] / 3));
  for (let i = 0; i < drones; i++) {
    const phase = t * (.65 + i * .06) + i * 2.2;
    const dx = coreX + Math.round(Math.cos(phase) * Math.min(18, w * .27));
    const dy = Math.max(y + 3, coreY - 2 + Math.round(Math.sin(phase) * 2));
    const beam = Math.sin(t * 3 + i) > -.4;
    if (beam && game.levels[0] > 0) {
      for (let k = 1; k <= 6; k++) {
        const px = Math.round(dx + (coreX - dx) * k / 7);
        const py = Math.round(dy + (coreY - dy) * k / 7);
        c.set(px, py, (k + Math.floor(t * 12)) % 2 ? '·' : '⋅', lerp(C.bg, C.cyan, .55));
      }
    }
    c.text(dx - 2, dy, Math.floor(t * 10) % 2 ? '─[◆]─' : '╶[◇]╴', i % 2 ? C.gold : C.cyan);
    c.set(dx, dy + 1, Math.floor(t * 8) % 2 ? '˙' : '·', C.orange);
  }

  // Ambient motes stream out of the crystal and into the workshop.
  for (let i = 0; i < Math.min(26, 6 + totalLevels); i++) {
    const p = (t * (.25 + hash(i + 40) * .2) + hash(i + 22)) % 1;
    const px = coreX + Math.round(Math.sin(i * 4 + p * 3) * (4 + p * 13));
    const py = coreY + 3 + Math.floor(p * Math.max(2, ground - coreY - 2));
    if (py < ground && px > x + 1 && px < x + w - 2) c.set(px, py, i % 3 === 0 ? '✦' : '·', lerp(C.cyan, C.gold, p));
  }

  // Conveyor and five distinct production buildings.
  const machineWidth = Math.floor((w - 6) / 5);
  const machines = [
    ['  ╥╥  ', ' ┌██┐ ', ' │◆◆│ ', ' ╘══╛ '],
    ['  ╷   ', ' ╔═╗  ', ' ║▒║  ', '╚╧═╧╝ '],
    ['  ░   ', ' ┏┷┓  ', ' ▐█▌  ', '╘═══╛ '],
    [' ╲│╱  ', ' ─◆─  ', ' ╱│╲  ', ' ╘╧╛  '],
    ['  ╭╮  ', ' ╭┤├╮ ', ' │◎◎│ ', ' ╰══╯ '],
  ];
  for (let i = 0; i < 5; i++) {
    const mx = x + 3 + i * machineWidth + Math.max(0, Math.floor((machineWidth - 6) / 2));
    const active = game.levels[i] > 0;
    const color = active ? MACHINE_COLORS[i] : C.edge;
    if (active) {
      const sy = ground - 5 - Math.floor((t * 2 + i) % 3);
      c.set(mx + 2 + Math.round(Math.sin(t * 2 + i)), sy, '░', lerp(C.bg, color, .35));
      c.set(mx + 3, ground - 5, Math.floor(t * 7 + i) % 2 ? '·' : '˙', color);
    }
    for (let row = 0; row < 4; row++) c.text(mx, ground - 4 + row, machines[i][row], color);
    if (i === 2 && active) c.set(mx + 2, ground - 2, ['▓', '█', '▒'][Math.floor(t * 10) % 3], C.gold);
    if (i === 3 && active) c.set(mx + 2, ground - 3, ['╳', '+', '×', '◆'][Math.floor(t * 8) % 4], C.white);
    c.text(mx, ground + 2, `${i + 1}·${String(game.levels[i]).padStart(2, '0')}`, active ? color : C.dim);
  }
  for (let i = 2; i < w - 2; i++) {
    c.set(x + i, ground, '═', C.edge);
    c.set(x + i, ground + 1, (i + Math.floor(t * 7)) % 5 === 0 ? '◆' : '─', (i + Math.floor(t * 7)) % 5 === 0 ? C.gold : C.edge);
  }
  c.set(x + 1, ground, '╞', C.edge);
  c.set(x + w - 2, ground, '╡', C.edge);
  const pulseProgress = 1 - Math.min(1, game.pulseCooldown / 1.5);
  const ready = game.pulseCooldown <= 0;
  c.text(x + 3, y + h - 3, ready ? '[SPACE] 별빛 수집' : '[SPACE] 충전 중', ready ? C.cyan : C.dim);
  const gaugeX = x + 23;
  bar(c, gaugeX, y + h - 3, Math.max(2, w - 29), pulseProgress, C.cyan, C.bg);

  // Manual collections and purchases add short-lived radial particles.
  for (const effect of ui.effects ?? []) {
    const age = t - effect.time;
    if (age < 0 || age > 1.3) continue;
    const col = effect.kind === 'purchase' ? C.gold : C.cyan;
    for (let i = 0; i < 18; i++) {
      const theta = i / 18 * Math.PI * 2;
      const px = Math.round(coreX + Math.cos(theta) * age * 18);
      const py = Math.round(coreY + Math.sin(theta) * age * 7);
      if (px > x + 1 && px < x + w - 2 && py > y + 1 && py < ground)
        c.set(px, py, age < .25 ? '✦' : '·', lerp(C.bg, col, 1 - age / 1.3));
    }
    if (effect.label) centered(c, x + 2, Math.max(y + 2, coreY - 5 - Math.floor(age * 2)), w - 4, effect.label, col);
  }
}

function upgrades(c, x, y, w, h, game, ui) {
  c.box(x, y, w, h, { fg: C.edge, bg: C.panel });
  c.text(x + 2, y, ' WORKSHOP / 설비 ', C.gold, C.panel);
  const roomy = h >= 32;
  const compact = h < 26;
  const step = roomy ? 5 : compact ? 3 : 4;
  for (let i = 0; i < 5; i++) {
    const row = y + (compact ? 1 : 2) + i * step;
    const upgrade = UPGRADES[i];
    const cost = upgradeCost(game, i);
    const affordable = game.dust >= cost;
    const color = affordable ? MACHINE_COLORS[i] : C.dim;
    c.text(x + 2, row, `[${i + 1}] ${upgrade.name}`, color, C.panel, w - 11);
    c.text(x + w - 9, row, `Lv.${String(game.levels[i]).padStart(2, '0')}`, C.text, C.panel, 7);
    const rate = upgrade.rate * (1 + game.prestigeCount * .5);
    c.text(x + 3, row + 1, `${number(cost)} ✦  ·  +${rate < 10 ? rate.toFixed(1) : number(rate)}/s`, affordable ? C.text : C.dim, C.panel, w - 6);
    if (roomy) c.text(x + 3, row + 2, upgrade.description, C.dim, C.panel, w - 6);
    if (!compact) bar(c, x + 3, row + (roomy ? 3 : 2), w - 6, game.dust / cost, color);
  }
  const statusY = y + h - 4;
  c.text(x + 2, statusY, automationUnlocked(game) ? `[A] 자동 구매  ${game.autoBuy ? 'ON ●' : 'OFF ○'}` : w < 37 ? '[A] 자동 · 누적 500에 해금' : '[A] 자동 구매 · 누적 500에 해금', game.autoBuy ? C.cyan : C.dim, C.panel, w - 4);
  c.text(x + 2, statusY + 1, canPrestige(game) ? '[R] 별자리 승천 가능 ✦' : `[R] 승천  ${number(game.runDust)} / 25K`, canPrestige(game) ? C.gold : C.dim, C.panel, w - 4);
}

export function renderGame(game, ui, width = 110, height = 38) {
  const w = Math.max(20, Math.min(180, Math.floor(width)));
  const h = Math.max(8, Math.min(60, Math.floor(height)));
  const c = new Canvas(w, h);
  c.clear(C.bg);
  if (w < 88 || h < 32) {
    c.text(2, 1, '✦ STARFALL · 별빛 공방', C.cyan, C.bg, w - 4);
    c.text(2, 3, '터미널을 88열 × 32행 이상으로 넓혀 주세요.', C.text, C.bg, w - 4);
    c.text(2, 5, `별가루 ${number(game.dust)}  ·  ${productionRate(game).toFixed(1)}/s`, C.gold, C.bg, w - 4);
    if (h > 8) c.text(2, 7, ui.paused ? '일시 정지 · P 계속 · Q 종료' : '자동 생산 계속 진행 중 · Q 저장 후 종료', C.dim, C.bg, w - 4);
    return c;
  }

  c.text(2, 1, '✦  S T A R F A L L', C.cyan);
  c.text(25, 1, '별빛 공방', C.white);
  const status = ui.saveError ? '⚠ 저장 불가' : ui.demo ? 'DEMO · 저장 안 함' : ui.paused ? 'Ⅱ 일시 정지' : '● LIVE';
  c.text(w - displayWidth(status) - 3, 1, status, ui.saveError ? C.orange : ui.paused ? C.gold : C.cyan);
  c.text(2, 3, `별가루  ${number(game.dust)} ✦`, C.gold);
  const totalRate = productionRate(game);
  c.text(Math.floor(w * .32), 3, `생산  +${totalRate < 1 ? totalRate.toFixed(2) : totalRate < 10000 ? totalRate.toFixed(1) : number(totalRate)} /s`, C.cyan);
  c.text(Math.floor(w * .65), 3, `승천 ${game.prestigeCount}  ·  배율 ×${(1 + game.prestigeCount * .5).toFixed(1)}`, C.purple, C.bg, w - Math.floor(w * .65) - 2);

  const rightWidth = Math.max(32, Math.min(43, Math.floor(w * .34)));
  const leftWidth = w - rightWidth - 5;
  const paneHeight = h - 12;
  scene(c, 2, 5, leftWidth, paneHeight, game, ui);
  upgrades(c, leftWidth + 3, 5, rightWidth, paneHeight, game, ui);

  const logY = h - 6;
  c.text(3, logY, 'SIGNAL', C.dim);
  c.text(12, logY, fitText(ui.logs?.[0] ?? '공방에 오신 것을 환영합니다. [1]로 첫 채굴 드론을 구매하세요.', w - 15), C.text);
  c.text(12, logY + 1, fitText(ui.logs?.[1] ?? '유성의 별가루를 모아 잠들지 않는 공방을 키워 보세요.', w - 15), C.dim);
  const goal = game.lifetimeDust < 500 ? `다음 목표 · 누적 500 ✦ → 자동 구매 해금 (${number(game.lifetimeDust)}/500)` : `별자리 기록 · 업적 ${game.achievements.length}개  ·  누적 ${number(game.lifetimeDust)} ✦`;
  c.text(3, h - 3, ui.saveError ? '저장 불가 · 현재 진행이 보존되지 않습니다. 다른 --save 경로로 실행해 주세요.' : goal, ui.saveError ? C.orange : C.dim, C.bg, w - 5);
  c.text(3, h - 2, '[1–5] 설비 구매   [SPACE] 수집   [A] 자동   [P] 정지   [?] 도움말   [Q] 종료', C.text, C.bg, w - 5);
  if (ui.help) overlay(c, 'FLIGHT MANUAL / 플레이 안내', [
    '공방은 가만히 있어도 별가루를 생산합니다.',
    '1–5   설비 구매 · 같은 설비를 여러 번 강화할 수 있어요.',
    'SPACE 별빛 수집 · 1.5초마다 추가 자원을 모읍니다.',
    'A     자동 구매 · 누적 500 별가루부터 사용할 수 있어요.',
    'R     승천 · 이번 회차 25K 달성 시 영구 생산 배율 +0.5.',
    'P     일시 정지 · ? 도움말 · Q 저장하고 종료',
    '10초마다 자동 저장 · 오프라인 생산은 최대 8시간.',
    ui.demo ? '데모에서는 저장하지 않습니다.' : '게임을 종료해도 다음 접속 때 생산량을 받습니다.',
    'ESC 또는 ? 키를 누르면 돌아갑니다.',
  ]);
  if (ui.confirmPrestige) overlay(c, 'ASCENSION / 별자리 승천', [
    '현재 별가루와 설비를 새로 시작합니다.',
    `영구 생산 배율이 ×${(1 + game.prestigeCount * .5).toFixed(1)} → ×${(1.5 + game.prestigeCount * .5).toFixed(1)}로 증가합니다.`,
    '누적 기록과 업적은 유지됩니다.',
    '',
    '[Y] 승천하기     [N / ESC] 취소',
  ]);
  return c;
}

function overlay(c, title, lines) {
  const width = Math.min(c.width - 8, 72);
  const height = lines.length + 5;
  const x = Math.floor((c.width - width) / 2), y = Math.floor((c.height - height) / 2);
  c.fill(x + 1, y + 1, width, height, ' ', C.text, [3, 7, 15]);
  c.fill(x, y, width, height, ' ', C.text, C.panel);
  c.box(x, y, width, height, { fg: C.cyan, bg: C.panel });
  c.text(x + 3, y + 1, title, C.cyan, C.panel, width - 6);
  lines.forEach((line, i) => c.text(x + 3, y + 3 + i, line, i === lines.length - 1 ? C.gold : C.text, C.panel, width - 6));
}
