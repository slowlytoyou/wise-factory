/** Deterministic, dependency-free economy for 별빛 공방. */
export const UPGRADES = Object.freeze([
  { id: 'drone', key: '1', name: '채집 드론', description: '별가루를 모으는 작은 동료', baseCost: 15, rate: 0.8 },
  { id: 'garden', key: '2', name: '별빛 정원', description: '별의 씨앗이 자라는 정원', baseCost: 90, rate: 4 },
  { id: 'refinery', key: '3', name: '달빛 정제소', description: '달빛을 순수한 별가루로', baseCost: 450, rate: 20 },
  { id: 'observatory', key: '4', name: '성운 관측소', description: '먼 성운에서 빛을 끌어와요', baseCost: 1800, rate: 90 },
  { id: 'portal', key: '5', name: '은하 관문', description: '새 은하로 통하는 문', baseCost: 7500, rate: 400 },
].map(Object.freeze));

export const PRESTIGE_THRESHOLD = 25_000;
export const MAX_OFFLINE_SECONDS = 8 * 60 * 60;
const SAVE_VERSION = 1;
const STARTING_DUST = 25;
const STARTER_RATE = 0.35;
const COST_GROWTH = 1.18;
const PULSE_COOLDOWN = 1.5;
const AUTO_INTERVAL = 5;
const MAX_MONEY = 1e15;
const MAX_LEVEL = 1000;
const MAX_PRESTIGE = 10_000;
const MAX_ELAPSED = 1e12;

const ACHIEVEMENTS = [
  ['첫 번째 설비', game => game.levels.some(level => level > 0)],
  ['별가루 수집가', game => game.lifetimeDust >= 100],
  ['빛나는 공방', game => game.lifetimeDust >= 1000],
  ['성운의 부자', game => game.lifetimeDust >= 10_000],
  ['은하의 손길', game => game.lifetimeDust >= 100_000],
  ['분주한 공방', game => game.levels.reduce((sum, level) => sum + level, 0) >= 25],
  ['새로운 별의 탄생', game => game.prestigeCount > 0],
];
const ACHIEVEMENT_NAMES = new Set(ACHIEVEMENTS.map(([name]) => name));

function boundedNumber(value, fallback, maximum, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
  const result = Math.min(value, maximum);
  return integer ? Math.floor(result) : result;
}

function safeNow(now) {
  return boundedNumber(now, Date.now(), 8.64e15);
}

function unlockAchievements(game) {
  const events = [];
  for (const [name, condition] of ACHIEVEMENTS) {
    if (!game.achievements.includes(name) && condition(game)) {
      game.achievements.push(name);
      events.push(`업적 달성 · ${name}`);
    }
  }
  return events;
}

/** Starting currency is a gift; lifetime/run counters count only earned dust. */
export function createGame(now = Date.now()) {
  return {
    version: SAVE_VERSION,
    dust: STARTING_DUST,
    lifetimeDust: 0,
    runDust: 0,
    levels: Array(UPGRADES.length).fill(0),
    prestigeCount: 0,
    pulseCooldown: 0,
    elapsed: 0,
    autoBuy: false,
    autoElapsed: 0,
    achievements: [],
    savedAt: safeNow(now),
  };
}

export function productionRate(game) {
  const base = game.levels.reduce((rate, level, index) => rate + level * UPGRADES[index].rate, STARTER_RATE);
  return base * (1 + game.prestigeCount * 0.5);
}

export function upgradeCost(game, index) {
  if (!Number.isInteger(index) || index < 0 || index >= UPGRADES.length) return Infinity;
  if (game.levels[index] >= MAX_LEVEL) return Infinity;
  return Math.ceil(UPGRADES[index].baseCost * COST_GROWTH ** game.levels[index]);
}

export function buyUpgrade(game, index) {
  if (!Number.isInteger(index) || index < 0 || index >= UPGRADES.length) {
    return { ok: false, message: '존재하지 않는 설비예요.' };
  }
  const cost = upgradeCost(game, index);
  if (!Number.isFinite(cost)) return { ok: false, message: '이 설비는 최고 단계예요.' };
  if (game.dust < cost) return { ok: false, message: '별가루가 조금 더 필요해요.' };
  game.dust -= cost;
  game.levels[index] += 1;
  unlockAchievements(game);
  return { ok: true, message: `${UPGRADES[index].name} Lv.${game.levels[index]} · 생산량 증가!` };
}

function earn(game, amount) {
  const earned = Math.min(Math.max(0, amount), MAX_MONEY - game.dust);
  game.dust += earned;
  game.lifetimeDust = Math.min(MAX_MONEY, game.lifetimeDust + earned);
  game.runDust = Math.min(MAX_MONEY, game.runDust + earned);
  return earned;
}

export function automationUnlocked(game) {
  return game.lifetimeDust >= 500;
}

export function toggleAutomation(game) {
  if (!automationUnlocked(game)) return { ok: false, message: '누적 별가루 500개를 모으면 자동 구매가 열려요.' };
  game.autoBuy = !game.autoBuy;
  game.autoElapsed = 0;
  return { ok: true, message: game.autoBuy ? '자동 구매 켜짐 · 5초마다 효율적인 설비를 구매해요.' : '자동 구매 꺼짐' };
}

function autoPurchase(game) {
  let bestIndex = -1;
  let bestEfficiency = -Infinity;
  for (let index = 0; index < UPGRADES.length; index += 1) {
    const cost = upgradeCost(game, index);
    const efficiency = UPGRADES[index].rate / cost;
    if (cost <= game.dust && efficiency > bestEfficiency) {
      bestIndex = index;
      bestEfficiency = efficiency;
    }
  }
  return bestIndex >= 0 ? buyUpgrade(game, bestIndex) : null;
}

/**
 * Advance simulation time, splitting at automation boundaries so frame rate
 * cannot change earnings. A single delta is limited to the offline cap.
 */
export function tick(game, dtSeconds) {
  const delta = boundedNumber(dtSeconds, 0, MAX_OFFLINE_SECONDS);
  if (delta === 0) return { earned: 0, events: [] };
  game.elapsed = Math.min(MAX_ELAPSED, game.elapsed + delta);
  game.pulseCooldown = Math.max(0, game.pulseCooldown - delta);
  let remaining = delta;
  let earned = 0;
  const events = [];
  if (game.autoBuy && automationUnlocked(game)) {
    while (remaining > 0) {
      const step = Math.min(remaining, Math.max(0, AUTO_INTERVAL - game.autoElapsed));
      earned += earn(game, productionRate(game) * step);
      remaining = Math.max(0, remaining - step);
      game.autoElapsed += step;
      if (game.autoElapsed >= AUTO_INTERVAL - 1e-9) {
        game.autoElapsed = 0;
        const purchase = autoPurchase(game);
        if (purchase?.ok) events.push(`자동 구매 · ${purchase.message}`);
      } else {
        break;
      }
    }
  } else {
    earned = earn(game, productionRate(game) * remaining);
    game.autoElapsed = 0;
  }
  events.push(...unlockAchievements(game));
  return { earned, events };
}

export function pulse(game) {
  if (game.pulseCooldown > 1e-9) {
    return { ok: false, earned: 0, message: '별빛을 충전하고 있어요.' };
  }
  const earned = earn(game, Math.max(4, productionRate(game) * 2));
  game.pulseCooldown = PULSE_COOLDOWN;
  unlockAchievements(game);
  return { ok: true, earned, message: '별빛 파동! 별가루를 수확했어요.' };
}

export function canPrestige(game) {
  return game.runDust >= PRESTIGE_THRESHOLD && game.prestigeCount < MAX_PRESTIGE;
}

export function prestige(game) {
  if (!canPrestige(game)) return { ok: false, message: '이번 은하에서 별가루 25,000개를 모으면 승천할 수 있어요.' };
  game.prestigeCount += 1;
  game.dust = STARTING_DUST;
  game.runDust = 0;
  game.levels = Array(UPGRADES.length).fill(0);
  game.pulseCooldown = 0;
  game.autoBuy = false;
  game.autoElapsed = 0;
  unlockAchievements(game);
  const bonus = game.prestigeCount * 50;
  return { ok: true, message: `새로운 은하로 승천! 영구 생산량 +${bonus}%` };
}

/** Return explicitly selected save fields, never transient UI data. */
export function serializeGame(game, now = Date.now()) {
  return {
    version: SAVE_VERSION,
    dust: game.dust,
    lifetimeDust: game.lifetimeDust,
    runDust: game.runDust,
    levels: [...game.levels],
    prestigeCount: game.prestigeCount,
    pulseCooldown: game.pulseCooldown,
    elapsed: game.elapsed,
    autoBuy: game.autoBuy,
    autoElapsed: game.autoElapsed,
    achievements: [...game.achievements],
    savedAt: safeNow(now),
  };
}

/** Invalid/unknown saves start fresh; individual invalid fields use defaults. */
export function hydrateGame(raw, now = Date.now()) {
  const currentTime = safeNow(now);
  const game = createGame(currentTime);
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { raw = null; }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== SAVE_VERSION) {
    return { game, offlineEarned: 0, offlineSeconds: 0 };
  }
  game.dust = boundedNumber(raw.dust, STARTING_DUST, MAX_MONEY);
  game.lifetimeDust = boundedNumber(raw.lifetimeDust, 0, MAX_MONEY);
  game.runDust = Math.min(game.lifetimeDust, boundedNumber(raw.runDust, 0, MAX_MONEY));
  if (Array.isArray(raw.levels)) {
    game.levels = UPGRADES.map((_, index) => boundedNumber(raw.levels[index], 0, MAX_LEVEL, true));
  }
  game.prestigeCount = boundedNumber(raw.prestigeCount, 0, MAX_PRESTIGE, true);
  game.pulseCooldown = boundedNumber(raw.pulseCooldown, 0, PULSE_COOLDOWN);
  game.elapsed = boundedNumber(raw.elapsed, 0, MAX_ELAPSED);
  game.autoBuy = raw.autoBuy === true && automationUnlocked(game);
  game.autoElapsed = boundedNumber(raw.autoElapsed, 0, AUTO_INTERVAL) % AUTO_INTERVAL;
  if (Array.isArray(raw.achievements)) {
    game.achievements = [...new Set(raw.achievements.filter(name => ACHIEVEMENT_NAMES.has(name)))];
  }
  const savedAt = boundedNumber(raw.savedAt, currentTime, 8.64e15);
  const offlineSeconds = Math.min(MAX_OFFLINE_SECONDS, Math.max(0, (currentTime - savedAt) / 1000));
  // Offline rewards use the saved production rate and never spend player funds.
  const autoBuy = game.autoBuy;
  const autoElapsed = game.autoElapsed;
  game.autoBuy = false;
  const { earned: offlineEarned } = tick(game, offlineSeconds);
  game.autoBuy = autoBuy;
  game.autoElapsed = autoElapsed;
  game.savedAt = currentTime;
  unlockAchievements(game);
  return { game, offlineEarned, offlineSeconds };
}
