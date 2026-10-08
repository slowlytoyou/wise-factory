import { Canvas, displayWidth, fitText } from './terminal.mjs';
import { WORLD_WIDTH, WORLD_HEIGHT, MAX_RADAR_LEVEL, ITEMS, BUILDINGS, RECIPES, tileAt, buildingAt, upgradeCost, factoryStats, buildingUnlocked, shopOffers, prestigeInfo } from './factory.mjs';
import { SKINS, getSkin, skinText } from './skins.mjs';

const C = {
  bg: [8, 16, 21], panel: [12, 24, 29], ground: [14, 29, 31],
  edge: [37, 66, 70], dim: [99, 131, 139], text: [200, 219, 214],
  white: [238, 246, 221], mint: [119, 234, 185], gold: [247, 195, 100],
  orange: [251, 142, 97], blue: [123, 187, 222], purple: [189, 169, 225],
};
const ARROWS = ['↑', '→', '↓', '←'];
const TYPE_ORDER = ['miner', 'belt', 'smelter', 'assembler', 'transmitter'];
const TYPE_COLORS = { miner: C.blue, belt: C.gold, smelter: C.orange, assembler: C.mint, transmitter: C.purple };
const TERRAIN_ITEMS = { iron: 'iron_ore', copper: 'copper_ore', coal: 'coal', stone: 'stone', wood: 'wood', quartz: 'quartz', gold: 'gold_ore' };
const FALLBACK_GLYPHS = { iron_ore: 'i', copper_ore: 'c', coal: '●', stone: 's', iron_plate: 'I', copper_plate: 'C', steel: 'S', gear: 'G', circuit: 'P', engine: 'E' };
const mix = (a, b, amount) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.max(0, Math.min(1, amount))));
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const hash = (x, y) => { const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return v - Math.floor(v); };
const WORK_COLORS = {
  bg: [22, 25, 30], panel: [29, 33, 39], ground: [25, 29, 35],
  edge: [63, 73, 85], dim: [139, 151, 164], text: [188, 199, 211],
  white: [222, 228, 235], mint: [157, 183, 205], gold: [185, 191, 197],
  orange: [189, 163, 147], blue: [145, 176, 204], purple: [167, 172, 199],
};
const WORK_COLOR_KEYS = new Map(Object.entries(C).map(([key, value]) => [value.join(','), WORK_COLORS[key]]));
const WORK_ITEM_GLYPHS = Object.fromEntries(Object.keys(ITEMS).map((id, index) => [id, String.fromCharCode(97 + index)]));

// Theme state belongs to the returned canvas, so rendering a preview cannot
// alter another screen's palette or the simulation's item definitions.
class SkinCanvas extends Canvas {
  constructor(width, height, skin) { super(width, height); this.skin = skin; }
  color(value) {
    if (!this.skin?.work || !Array.isArray(value)) return value;
    const mapped = WORK_COLOR_KEYS.get(value.join(','));
    if (mapped) return mapped;
    const gray = Math.round(value[0] * .21 + value[1] * .72 + value[2] * .07);
    return [gray, Math.min(255, gray + 4), Math.min(255, gray + 10)];
  }
  clear(bg) { return super.clear(this.color(bg)); }
  text(x, y, value, fg, bg, width) { return super.text(x, y, value, this.color(fg), this.color(bg), width); }
  set(x, y, value, fg, bg) { return super.set(x, y, value, this.color(fg), this.color(bg)); }
  fill(x, y, width, height, value, fg, bg) { return super.fill(x, y, width, height, value, this.color(fg), this.color(bg)); }
}

const label = (c, text) => skinText(String(text ?? ''), c.skin.id);
const textWidth = (c, text) => displayWidth(label(c, text));
const cargoGlyph = (c, id) => c.skin.work ? WORK_ITEM_GLYPHS[id] ?? '?' : itemGlyph(id);
const directionGlyph = (c, direction) => (c.skin.work ? ['^', '>', 'v', '<'] : ARROWS)[direction] ?? (c.skin.work ? '>' : '→');

export function formatNumber(value) {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${(value / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${(value / 1e3).toFixed(1)}K`;
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function dimensions(width, height) {
  return {
    width: clamp(Number.isFinite(width) ? Math.floor(width) : 120, 0, 220),
    height: clamp(Number.isFinite(height) ? Math.floor(height) : 40, 0, 80),
  };
}

/** Camera coordinates are in world tiles; map pixels occupy two terminal columns. */
export function factoryViewport(game, width = 120, height = 40) {
  const size = dimensions(width, height);
  const columns = clamp(Math.floor((size.width - 38) / 2), 1, WORLD_WIDTH);
  const rows = clamp(size.height - 10, 1, WORLD_HEIGHT);
  const left = clamp(Math.floor(game.player.x) - Math.floor(columns / 2), 0, WORLD_WIDTH - columns);
  const top = clamp(Math.floor(game.player.y) - Math.floor(rows / 2), 0, WORLD_HEIGHT - rows);
  const sidebarX = columns * 2 + 4;
  return { x: 2, y: 5, columns, rows, left, top, sidebarX, sidebarWidth: size.width - sidebarX - 2 };
}

function itemGlyph(id) {
  const glyph = ITEMS[id]?.glyph;
  return glyph && displayWidth(glyph) === 1 ? glyph : FALLBACK_GLYPHS[id] ?? '·';
}

function itemName(id) { return ITEMS[id]?.name ?? id; }
function itemColor(id) { return ITEMS[id]?.color ?? C.text; }
function salePrice(game, id) { return (ITEMS[id]?.price ?? 0) * prestigeInfo(game).multiplier; }
function ingredients(recipe, { symbols = false } = {}) {
  return Object.entries(recipe?.inputs ?? {}).map(([id, count]) => `${symbols ? itemGlyph(id) : itemName(id)} ×${count}`).join(' + ');
}

function write(c, x, y, text, fg = C.text, width = c.width - x - 2, bg) {
  return rawWrite(c, x, y, label(c, text), fg, width, bg);
}

function rawWrite(c, x, y, text, fg = C.text, width = c.width - x - 2, bg) {
  return c.text(x, y, text, fg, bg, Math.max(0, width));
}

function mixedWrite(c, x, y, parts, fg = C.text, width = c.width - x - 2, bg) {
  const text = parts.map(part => typeof part === 'string' ? label(c, part) : String(part.raw ?? '')).join('');
  return rawWrite(c, x, y, text, fg, width, bg);
}

function gauge(c, x, y, width, ratio, color = C.mint) {
  const filled = Math.round(clamp(ratio || 0, 0, 1) * width);
  c.text(x, y, '━'.repeat(filled), color);
  c.text(x + filled, y, '─'.repeat(width - filled), C.edge);
}

function drawTerrain(c, game, view, time) {
  for (let dy = 0; dy < view.rows; dy++) for (let dx = 0; dx < view.columns; dx++) {
    const wx = dx + view.left, wy = dy + view.top;
    const x = view.x + dx * 2, y = view.y + dy;
    const terrain = tileAt(game, wx, wy);
    const ore = TERRAIN_ITEMS[terrain];
    if (c.skin.work) {
      const bg = (wx + wy) % 2 ? C.ground : C.bg;
      c.text(x, y, ore ? `${cargoGlyph(c, ore)} ` : wx % 5 === 0 && wy % 5 === 0 ? '+ ' : '. ', ore ? C.blue : C.edge, bg);
      continue;
    }
    const grain = hash(wx, wy);
    const road = Math.abs(wx - game.merchant.x) <= 1 || Math.abs(wy - game.merchant.y) <= 1;
    const bg = road ? [20, 34, 34] : mix(C.ground, [22, 43, 39], grain * .55);
    c.text(x, y, '  ', C.edge, bg);
    if (ore) {
      const color = itemColor(ore);
      const pulse = .46 + .14 * Math.sin(time * 1.2 + wx * .5 + wy);
      c.text(x, y, grain > .45 ? '▪·' : '·▪', mix(C.ground, color, pulse + .18), mix(bg, color, .13));
    } else if (terrain !== 'merchant') {
      const boundary = wx === 0 || wy === 0 || wx === WORLD_WIDTH - 1 || wy === WORLD_HEIGHT - 1;
      if (boundary) c.text(x, y, wy === 0 || wy === WORLD_HEIGHT - 1 ? '··' : '┆ ', [38, 64, 60], bg);
      else if (grain > .92) c.text(x, y, "˙'", [39, 63, 55], bg);
      else if (grain < .12) c.text(x, y, '· ', [31, 52, 48], bg);
      else if (road && (wx + wy) % 4 === 0) c.text(x, y, '· ', [45, 60, 54], bg);
    }
  }
}

function screenAt(view, wx, wy) {
  if (wx < view.left || wx >= view.left + view.columns || wy < view.top || wy >= view.top + view.rows) return null;
  return { x: view.x + (wx - view.left) * 2, y: view.y + wy - view.top };
}

function drawMerchant(c, game, view, time) {
  const lines = c.skin.work ? ['+----+', c.skin.developer ? '| R$ |' : '| M$ |', '+----+'] : ['╔════╗', '║ M$ ║', '╚════╝'];
  const pulse = .65 + .2 * Math.sin(time * 2);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const point = screenAt(view, game.merchant.x + dx, game.merchant.y + dy);
    if (!point) continue;
    const glyph = lines[dy + 1].slice((dx + 1) * 2, (dx + 1) * 2 + 2);
    c.text(point.x, point.y, glyph, c.skin.work ? C.white : mix(C.gold, C.white, pulse * .4), c.skin.work ? C.panel : [57, 45, 28]);
  }
}

function drawMachines(c, game, view, time) {
  for (const building of game.buildings) {
    const point = screenAt(view, building.x, building.y);
    if (!point) continue;
    const frame = Math.floor(time * (4 + building.level * 2) + building.x * .7 + building.y) % 4;
    const direction = ((building.dir ?? 1) % 4 + 4) % 4;
    const arrow = ARROWS[direction];
    const color = TYPE_COLORS[building.type] ?? C.text;
    const bg = mix(C.bg, color, .18);
    if (c.skin.work) {
      const arrow = directionGlyph(c, direction);
      const cargo = building.item && ITEMS[building.item] ? cargoGlyph(c, building.item) : '.';
      const glyph = building.type === 'belt' ? direction === 3 ? `${cargo}${arrow}` : `${arrow}${cargo}`
        : building.type === 'transmitter' ? c.skin.developer ? 'H$' : 'T$'
        : `${(c.skin.developer ? { miner: 'S', smelter: 'B', assembler: 'I' } : { miner: 'M', smelter: 'F', assembler: 'A' })[building.type] ?? '?'}${building.item ? cargo : arrow}`;
      c.text(point.x, point.y, glyph, color, C.panel);
      continue;
    }
    if (building.type === 'transmitter') {
      c.text(point.x, point.y, `${['◌', '◉', '◎', '◉'][frame]}$`, mix(color, C.white, frame * .12), bg);
      continue;
    }
    if (building.type === 'belt') {
      // A cargo belongs to this tile until the simulation transfers it. Keep it
      // at the output end so a blocked line reads as a stationary queue.
      const right = direction !== 3;
      if (building.item && ITEMS[building.item]) {
        c.text(point.x, point.y, right ? `${arrow}${itemGlyph(building.item)}` : `${itemGlyph(building.item)}${arrow}`, C.edge, bg);
        c.set(point.x + Number(right), point.y, itemGlyph(building.item), itemColor(building.item));
      } else {
        c.text(point.x, point.y, right ? `${arrow}·` : `·${arrow}`, mix(C.edge, C.gold, .5 + frame * .1), bg);
      }
      continue;
    }
    const active = building.type === 'miner' || building.progress > 0 || Boolean(building.item);
    const glyphs = building.type === 'miner' ? ['▼', '▽', '▼', '▾'] : building.type === 'smelter' ? ['▥', '▤', '▥', '▦'] : ['✣', '✥', '✣', '✢'];
    c.text(point.x, point.y, `${glyphs[active ? frame : 0]}${arrow}`, active ? mix(color, C.white, frame * .12) : mix(C.dim, color, .35), bg);
    if (building.item && ITEMS[building.item]) c.set(point.x + 1, point.y, itemGlyph(building.item), itemColor(building.item));
  }
}

function drawAtmosphere(c, game, view, time, effects) {
  if (c.skin.work) return;
  const occupied = new Set(game.buildings.map(building => `${building.x},${building.y}`));
  const empty = (x, y) => !occupied.has(`${x},${y}`) && tileAt(game, x, y) !== 'merchant' && !(game.player.x === x && game.player.y === y);
  for (const building of game.buildings) {
    if (building.type === 'belt') continue;
    if (building.type !== 'miner' && building.type !== 'transmitter' && !(building.progress > 0 || building.item)) continue;
    const phase = (time * 1.4 + hash(building.x, building.y) * 3) % 3;
    const wx = building.x + (phase > 1.6 ? 1 : 0), wy = building.y - 1 - Math.floor(phase / 1.5);
    const point = screenAt(view, wx, wy);
    if (point && empty(wx, wy)) {
      const color = TYPE_COLORS[building.type] ?? C.mint;
      c.set(point.x + (Math.floor(time * 2 + building.x) % 2), point.y, phase < .7 ? '✧' : phase < 1.8 ? '░' : '·', mix(C.ground, color, .45 - phase * .1));
    }
  }
  for (const effect of effects ?? []) {
    const age = time - effect.time;
    if (!(age >= 0 && age < .85) || !Number.isFinite(effect.x) || !Number.isFinite(effect.y)) continue;
    for (let i = 0; i < 4; i++) {
      const wx = effect.x + (i === 1 ? 1 : i === 3 ? -1 : 0), wy = effect.y + (i === 2 ? 1 : i === 0 ? -1 : 0);
      const point = screenAt(view, wx, wy);
      if (point && empty(wx, wy)) c.set(point.x + (i % 2), point.y, age < .35 ? '+' : '·', mix(C.ground, C.gold, 1 - age / .85));
    }
  }
}

function drawCursor(c, game, view, ui) {
  const point = screenAt(view, game.player.x, game.player.y);
  if (!point) return;
  const building = buildingAt(game, game.player.x, game.player.y);
  const selected = BUILDINGS[ui.selected] ? ui.selected : 'belt';
  const terrain = tileAt(game, game.player.x, game.player.y);
  const funded = selected === 'transmitter' ? game.progression.transmitters > 0 : game.coins >= BUILDINGS[selected].cost;
  const canBuild = !building && terrain !== 'merchant' && buildingUnlocked(game, selected) && (selected !== 'miner' || TERRAIN_ITEMS[terrain]) && funded;
  const direction = building ? building.dir : ui.direction;
  c.text(point.x, point.y, `@${directionGlyph(c, direction)}`, C.white, c.skin.work ? C.edge : canBuild || building ? [41, 112, 86] : [112, 66, 44]);
}

function inspector(c, game, ui, view) {
  const x = view.sidebarX, width = view.sidebarWidth;
  const compact = c.height < 39;
  const text = (y, value, color = C.text) => write(c, x, y, value, color, width);
  const selected = BUILDINGS[ui.selected] ? ui.selected : 'belt';
  const hovered = buildingAt(game, game.player.x, game.player.y);
  const terrain = tileAt(game, game.player.x, game.player.y);
  const chosenRecipe = RECIPES[hovered?.recipe] ?? RECIPES[ui.recipe];
  c.fill(x - 2, 5, 1, c.height - 10, '│', C.edge);
  text(4, 'BUILD / 생산 설비', C.mint);
  TYPE_ORDER.forEach((type, i) => {
    const definition = BUILDINGS[type];
    const prefix = selected === type ? '›' : ' ';
    const unlocked = buildingUnlocked(game, type);
    const cost = type === 'transmitter' ? `재고 ${game.progression.transmitters}` : unlocked ? `₵${formatNumber(definition.cost)}` : '잠김';
    write(c, x, 6 + i, `${prefix} ${i + 1} ${definition.name}`, selected === type ? TYPE_COLORS[type] : C.dim, width - textWidth(c, cost) - 1);
    write(c, x + width - textWidth(c, cost), 6 + i, cost, unlocked && game.coins >= definition.cost ? C.gold : C.dim, textWidth(c, cost));
  });
  text(11, `설치 ${ARROWS[ui.direction] ?? '→'}  [E]  ·  (${game.player.x},${game.player.y})`, C.mint);
  const terrainName = terrain === 'merchant' ? 'M 중앙 상인 · 모든 물품 매입' : TERRAIN_ITEMS[terrain] ? `${itemName(TERRAIN_ITEMS[terrain])} 광맥` : '빈 대지 · 설비를 건설하세요';
  text(12, hovered ? `${BUILDINGS[hovered.type]?.name ?? hovered.type}  Lv.${hovered.level}` : terrainName, hovered ? TYPE_COLORS[hovered.type] : C.white);
  if (hovered) {
    const cost = upgradeCost(hovered);
    text(13, hovered.type === 'transmitter' ? '모든 방향 자동 매입 · [X] 회수' : `[U] ${Number.isFinite(cost) ? `강화 ₵${formatNumber(cost)}` : '최대 레벨'}  [X] 철거`, C.dim);
    const stock = Object.entries(hovered.buffer ?? {}).filter(([, count]) => count > 0).map(([id, count]) => `${cargoGlyph(c, id)}×${formatNumber(count)}`).join(' ');
    text(14, hovered.type === 'belt'
      ? `적재 ${hovered.item ? `${cargoGlyph(c, hovered.item)} ${itemName(hovered.item)} 1/1` : '0/1 · 비어 있음'}`
      : `보관 ${stock || '비어 있음'}${hovered.item ? `  출구 ${cargoGlyph(c, hovered.item)}` : ''}`, C.text);
  } else {
    text(13, !buildingUnlocked(game, selected) && selected !== 'transmitter' ? '[B] 상인에게 설계도 구매' : selected === 'transmitter' ? '벨트 연결 시 이 칸에서 판매' : terrain === 'merchant' ? '벨트가 상인에 닿으면 자동 판매' : selected === 'miner' ? '광맥 위 설치 · 화살표로 배출' : selected === 'belt' ? '뒤·옆에서 입력 · 화살표로 배출' : '입력은 모든 방향 · 화살표로 배출', C.dim);
    text(14, selected === 'transmitter' ? `[B] 상인 구매 · 보유 ${game.progression.transmitters}개` : '[R] 배출 방향   [E/SPACE] 설치', C.dim);
  }

  const recipeY = compact ? 16 : 17;
  text(recipeY, 'RECIPE / [F] 제작법', C.orange);
  if (chosenRecipe) {
    text(recipeY + 1, chosenRecipe.name, C.white);
    text(recipeY + 2, ingredients(chosenRecipe), C.dim);
    const output = ITEMS[chosenRecipe.output];
    text(recipeY + 3, `→ ${output?.name ?? chosenRecipe.output} ×${chosenRecipe.amount ?? 1}  ₵${formatNumber(salePrice(game, chosenRecipe.output))}`, itemColor(chosenRecipe.output));
    if (!compact) text(recipeY + 4, `${BUILDINGS[chosenRecipe.building]?.name ?? chosenRecipe.building} · 기본 ${chosenRecipe.seconds}s / 회`, C.dim);
  } else {
    text(recipeY + 1, '[3/4] 가공 설비를 선택하세요', C.dim);
    text(recipeY + 2, '[C] 전체 제작법과 판매가', C.dim);
  }

  if (compact) {
    text(21, `탐지 단계 ${game.progression.radarLevel}/${MAX_RADAR_LEVEL} · [B] 상점`, C.gold);
    text(22, `판매 ${formatNumber(game.soldCount ?? 0)}개 · 설비 ${game.buildings.length}개`, C.dim);
    const cloud = cloudLabel(ui.cloud, ui.demo, ui.saveError);
    text(23, cloud.text, cloud.color);
    modeDetailLine(c, x, 24, width, ui);
  } else {
    text(23, 'MARKET / 개당 판매가', C.gold);
    if (c.skin.developer) {
      const prices = ids => ids.map(id => `${cargoGlyph(c, id)} ${itemName(id)} ${formatNumber(salePrice(game, id))}`).join('  ');
      text(24, prices(['iron_ore', 'copper_ore']), C.dim);
      text(28, prices(['coal', 'stone']), C.dim);
    } else text(24, `철 ${formatNumber(salePrice(game, 'iron_ore'))}  구리 ${formatNumber(salePrice(game, 'copper_ore'))}  석탄 ${formatNumber(salePrice(game, 'coal'))}  돌 ${formatNumber(salePrice(game, 'stone'))}`, C.dim);
    const pairs = [['iron_plate', 'copper_plate'], ['steel', 'gear'], ['circuit', 'engine']];
    pairs.forEach((ids, row) => {
      let cursor = x;
      for (const id of ids) {
        if (!ITEMS[id]) continue;
        const label = `${cargoGlyph(c, id)} ${itemName(id)} ${formatNumber(salePrice(game, id))}  `;
        cursor += write(c, cursor, 25 + row, label, itemColor(id), x + width - cursor);
      }
    });
    const prestige = prestigeInfo(game);
    text(29, `[T] 환생  ₵${formatNumber(prestige.runRevenue)} / ${formatNumber(prestige.requiredRevenue)}`, C.dim);
    gauge(c, x, 30, width, prestige.runRevenue / prestige.requiredRevenue, C.purple);
    const cloud = cloudLabel(ui.cloud, ui.demo, ui.saveError);
    text(32, cloud.text, cloud.color);
    modeDetailLine(c, x, 33, width, ui);
  }
}

function isCloudMode(ui) {
  return !ui.demo && ['online', 'connecting', 'offline', 'error', 'rate_limited'].includes(ui.cloud?.status);
}

function nickname(game, ui) {
  return (isCloudMode(ui) ? ui.cloud?.nickname : game.nickname) || '공장장';
}

function modeDetail(ui) {
  if (ui.demo) return '체험용 공장 · 저장하지 않음';
  if (!isCloudMode(ui)) return '개인 플레이 · 계정 없이 이용';
  return ui.cloud?.message || ui.cloud?.nickname || '서버 저장 · 공식 순위 참여';
}

function modeDetailLine(c, x, y, width, ui) {
  if (isCloudMode(ui) && !ui.cloud?.message && ui.cloud?.nickname) rawWrite(c, x, y, ui.cloud.nickname, C.dim, width);
  else writeMessage(c, x, y, modeDetail(ui), C.dim, width);
}

function writeMessage(c, x, y, message, color, width = c.width - x - 2, bg) {
  const nameLog = /^(닉네임 저장 완료 · |데모 닉네임 · )(.*)$/u.exec(String(message));
  if (nameLog) return mixedWrite(c, x, y, [nameLog[1], { raw: nameLog[2] }], color, width, bg);
  // Paths and URLs in errors are user data, not localization keys.
  const parts = String(message).split(/((?:https?:\/\/|(?:\/[\p{L}\p{N}_.~-]+){2,})[^\s]*)/u);
  return mixedWrite(c, x, y, parts.map((part, index) => index % 2 ? { raw: part } : part), color, width, bg);
}

function cloudLabel(cloud = {}, demo = false, saveError = '') {
  if (demo) return { text: 'DEMO · 진행 상황 저장 안 함', color: C.gold };
  if (cloud.status === 'online') return { text: '● CLOUD · 서버 저장 연결됨', color: C.mint };
  if (cloud.status === 'connecting') return { text: '◌ CLOUD · 연결 중', color: C.gold };
  if (cloud.status === 'offline') return { text: '○ CLOUD · 연결 대기', color: C.orange };
  if (cloud.status === 'rate_limited') return { text: '◌ CLOUD · 잠시 후 자동 재시도', color: C.gold };
  if (cloud.status === 'error') return { text: '! CLOUD · 연결 확인 필요', color: C.orange };
  return saveError ? { text: '! LOCAL · 저장 오류', color: C.orange } : { text: '● LOCAL · 기기에 자동 저장', color: C.dim };
}

function playStatus(ui) {
  if (ui.demo) return { text: 'DEMO · 저장 안 함', color: C.gold };
  const mode = isCloudMode(ui) ? 'CLOUD PLAY' : 'LOCAL PLAY';
  if (ui.saveError) return { text: `! ${mode} · 저장 오류`, color: C.orange };
  if (ui.paused) return { text: `Ⅱ ${mode} · 일시 정지`, color: C.gold };
  if (!isCloudMode(ui)) return { text: '● LOCAL PLAY · 개인 플레이', color: C.dim };
  const { text, color } = cloudLabel(ui.cloud);
  return { text: text.replace('CLOUD', 'CLOUD PLAY'), color };
}

function modal(c, title, subtitle, height, width = 80) {
  width = Math.min(width, c.width - 8);
  height = Math.min(height, c.height - 4);
  const x = Math.floor((c.width - width) / 2), y = Math.floor((c.height - height) / 2);
  c.fill(x + 1, y + 1, width, height, ' ', C.text, [3, 9, 12]);
  c.box(x, y, width, height, { fg: C.edge, bg: C.panel });
  write(c, x + 3, y + 1, title, C.mint, width - 6, C.panel);
  write(c, x + 3, y + 3, subtitle, C.dim, width - 6, C.panel);
  return { x: x + 3, y, width: width - 6, bottom: y + height - 2 };
}

function helpModal(c, ui) {
  const lines = [
    'WASD       지도 이동 · @ 커서 위치에 건설합니다.',
    '1 / 2      채굴기 / 컨베이어 벨트 선택',
    '3 / 4 / 5  용광로 / 조립기 / 판매 전송기 선택',
    'E / SPACE  선택한 설비 건설',
    'R          배출 방향 회전 · 설비 위에서는 기존 설비 회전',
    'U / X      커서 아래 설비 강화 / 철거 후 일부 비용 회수',
    'F          제작법 전환 · 가공 설비 위에서는 제작법 변경',
    `C / L      생산 도감 / ${isCloudMode(ui) ? '클라우드 리더보드' : ui.demo ? '데모 기록' : '내 기록'}`,
    'B          중앙 상인 근처에서 상점 열기',
    'T          환생 보상 확인 · E 다음 Y로 확정',
    'N          닉네임 설정 · Enter 저장 · Esc 취소',
    'K          스킨 설정 · Original / Work / Work Dev',
    'P / Q      일시 정지 / 저장하고 종료',
    '',
    '상인에게 설계도와 레이더를 사서 새 설비·광맥을 여세요.',
    '광맥 → 가공 설비 → 벨트 → 중앙 M 상인 / 전송기',
    '화살표 방향 배출 · 벨트는 뒤·옆 입력 · 가공 설비는 모든 방향 입력',
    ui.demo ? '데모에서는 진행 상황을 저장하지 않습니다.' : isCloudMode(ui) ? '클라우드에서는 P를 눌러도 서버의 생산 시간은 흐릅니다.' : '개인 플레이 · 자동 저장 · 종료 후 최대 8시간 생산 반영',
  ];
  const box = modal(c, 'FIELD MANUAL / 공장 운영 안내', '작은 채굴 라인을 거대한 무인 공장으로 키워 보세요.', lines.length + 8, 88);
  lines.forEach((line, index) => write(c, box.x, box.y + 5 + index, line, index >= 11 ? C.dim : C.text, box.width, C.panel));
  write(c, box.x, box.bottom, '[ESC / ?] 돌아가기', C.gold, box.width, C.panel);
}

export function catalogPageSize(height = 40, kind = 'recipes') {
  const rows = dimensions(120, height).height;
  return Math.max(1, kind === 'shop'
    ? Math.floor((Math.min(24, rows - 4) - 13) / 2)
    : Math.floor((rows - 13) / 3));
}

function recipesModal(c, game, ui) {
  const recipes = Object.entries(RECIPES);
  const hovered = buildingAt(game, game.player.x, game.player.y);
  const selected = clamp(Number.isInteger(ui.recipeIndex) ? ui.recipeIndex : Math.max(0, recipes.findIndex(([id]) => id === (hovered?.recipe || ui.recipe))), 0, recipes.length - 1);
  const pageSize = catalogPageSize(c.height);
  const page = Math.floor(selected / pageSize);
  const pages = Math.ceil(recipes.length / pageSize);
  const box = modal(c, 'PRODUCTION ATLAS / 생산 도감', `제작법 ${selected + 1}/${recipes.length}  ·  ${page + 1}/${pages} 페이지  ·  최상위 생산물: 논문`, c.height - 4, 94);
  recipes.slice(page * pageSize, (page + 1) * pageSize).forEach(([id, recipe], index) => {
    const y = box.y + 5 + index * 3;
    const chosen = page * pageSize + index === selected;
    const title = `${chosen ? '›' : ' '} ${recipe.name}  ·  ${BUILDINGS[recipe.building]?.name ?? recipe.building}  ·  ${recipe.seconds}s`;
    write(c, box.x, y, title, chosen ? C.mint : C.white, box.width, C.panel);
    write(c, box.x + 2, y + 1, ingredients(recipe), C.dim, box.width - 2, C.panel);
    write(c, box.x + 2, y + 2, `→ ${itemName(recipe.output)} ×${recipe.amount ?? 1}  / 판매가 ₵${formatNumber(salePrice(game, recipe.output))}`, itemColor(recipe.output), box.width - 2, C.panel);
  });
  write(c, box.x, box.bottom - 1, '[W/S ↑↓] 선택  [A/D ←→] 페이지  [ENTER] 제작법 지정', C.gold, box.width, C.panel);
  write(c, box.x, box.bottom, '[ESC / C] 돌아가기 · 판매가는 완성품 1개 기준', C.dim, box.width, C.panel);
}

function shopModal(c, game, ui) {
  const offers = shopOffers(game);
  const selected = clamp(Math.floor(ui.shopIndex) || 0, 0, offers.length - 1);
  const pageSize = catalogPageSize(c.height, 'shop');
  const page = Math.floor(selected / pageSize);
  const box = modal(c, 'MERCHANT EXCHANGE / 중앙 상인', `설계도 · 탐지 레이더 · 판매 전송기  ·  ${page + 1}/${Math.ceil(offers.length / pageSize)} 페이지`, 24, 88);
  write(c, box.x, box.y + 5, `보유 자금 ₵${formatNumber(game.coins)}   ·   전송기 ${game.progression.transmitters}개`, C.gold, box.width, C.panel);
  offers.slice(page * pageSize, (page + 1) * pageSize).forEach((offer, row) => {
    const index = page * pageSize + row;
    const y = box.y + 7 + row * 2;
    const status = offer.owned ? '구매 완료' : offer.available ? '구매 가능' : offer.reason.includes('부족') ? '자금 부족' : '잠김';
    const label = `${offer.owned ? '' : `₵${formatNumber(offer.cost)}  `}${status}`;
    const statusWidth = textWidth(c, label);
    write(c, box.x, y, `${index === selected ? '›' : ' '} ${index + 1} ${offer.name}`, index === selected ? C.mint : C.white, box.width - statusWidth - 2, C.panel);
    write(c, box.x + box.width - statusWidth, y, label, offer.owned ? C.dim : offer.available && game.coins >= offer.cost ? C.gold : C.orange, statusWidth, C.panel);
    write(c, box.x + 4, y + 1, offer.reason || offer.description, C.dim, box.width - 4, C.panel);
  });
  write(c, box.x, box.bottom - 2, '전송기는 [5] 선택 후 [E] 설치 · 벨트 연결 시 자동 판매', C.purple, box.width, C.panel);
  write(c, box.x, box.bottom - 1, '[W/S ↑↓] 선택  [A/D ←→] 페이지  [1–9] 번호 선택', C.gold, box.width, C.panel);
  write(c, box.x, box.bottom, '[E/ENTER] 구매  [ESC/B] 닫기', C.gold, box.width, C.panel);
}

function multiplier(value) { return `×${Number(value).toFixed(2)}`; }

function nicknameModal(c, game, ui) {
  const draft = String(ui.nicknameDraft ?? '');
  const pending = ui.nicknameSaving;
  const status = ui.nicknameError || (pending ? '닉네임을 서버에 저장하고 있습니다…' : '');
  if (c.width < 64 || c.height < 23) {
    c.clear(C.bg);
    write(c, 2, 1, 'NICKNAME / 닉네임 설정', C.mint);
    rawWrite(c, 2, 3, `> ${draft}▏`, C.white);
    writeMessage(c, 2, 5, status || '터미널을 넓히면 전체 안내를 볼 수 있습니다.', ui.nicknameError ? C.orange : C.dim);
    write(c, 2, Math.max(0, c.height - 2), pending ? '[ENTER] 변경 예약 [ESC] 닫기' : '[ENTER] 저장 [ESC] 취소', C.gold);
    return;
  }
  const privacy = ui.demo ? '데모 닉네임 · 진행 상황과 함께 저장되지 않습니다.' : isCloudMode(ui) ? '클라우드 닉네임 · 리더보드에 공개됩니다.' : '개인 닉네임 · 이 기기에 저장되며 공개되지 않습니다.';
  const box = modal(c, 'NICKNAME / 닉네임 설정', privacy, 19, 80);
  mixedWrite(c, box.x, box.y + 5, ['현재 이름  ', { raw: nickname(game, ui) }], C.dim, box.width, C.panel);
  write(c, box.x, box.y + 7, '새 닉네임', C.text, box.width, C.panel);
  c.fill(box.x, box.y + 8, box.width, 1, ' ', C.white, C.bg);
  write(c, box.x, box.y + 8, '> ', C.mint, 2, C.bg);
  const inputWidth = box.width - 3;
  rawWrite(c, box.x + 2, box.y + 8, draft, C.white, inputWidth, C.bg);
  c.set(box.x + 2 + Math.min(displayWidth(draft), inputWidth), box.y + 8, '▏', C.mint, C.bg);
  write(c, box.x, box.y + 10, '2–20자 · 한글/영문/숫자/공백/_/- 사용 가능', C.dim, box.width, C.panel);
  write(c, box.x, box.y + 12, '[BACKSPACE] 한 글자 지우기  [CTRL+U] 모두 지우기', C.dim, box.width, C.panel);
  writeMessage(c, box.x, box.y + 14, status, ui.nicknameError ? C.orange : C.mint, box.width, C.panel);
  write(c, box.x, box.bottom, pending ? '[ENTER] 변경 예약  [ESC] 닫기' : '[ENTER] 닉네임 저장  [ESC] 취소', C.gold, box.width, C.panel);
}

function prestigeModal(c, game, ui) {
  const prestige = prestigeInfo(game);
  const box = modal(c, 'OH CORE / 환생', ui.prestigeConfirm ? '환생을 확정하면 현재 공장이 새 회차로 바뀝니다.' : '공장을 다시 시작하고, 모든 물품의 판매가를 영구 강화하세요.', 24, 88);
  write(c, box.x, box.y + 5, `이번 회차 판매 ₵${formatNumber(prestige.runRevenue)}  /  필요 ₵${formatNumber(prestige.requiredRevenue)}`, C.gold, box.width, C.panel);
  gauge(c, box.x, box.y + 6, box.width, prestige.runRevenue / prestige.requiredRevenue, C.purple);
  write(c, box.x, box.y + 8, `OH 코어  ${formatNumber(prestige.cores)} → ${formatNumber(prestige.cores + prestige.gain)}  (+${formatNumber(prestige.gain)})`, C.purple, box.width, C.panel);
  write(c, box.x, box.y + 9, `판매 배율  ${multiplier(prestige.multiplier)} → ${multiplier(prestige.nextMultiplier)}`, C.mint, box.width, C.panel);
  write(c, box.x, box.y + 11, '코어 1개당 모든 판매가 +25%', C.purple, box.width, C.panel);
  write(c, box.x, box.y + 12, '보유만 하면 자동 적용 · 소모되지 않음', C.text, box.width, C.panel);
  write(c, box.x, box.y + 13, '상인·전송기 모두 적용 · 예: 코어 4개 = 판매가 2배', C.dim, box.width, C.panel);
  write(c, box.x, box.y + 15, '초기화  현재 공장 · 자금 · 회차 판매액', C.orange, box.width, C.panel);
  write(c, box.x, box.y + 16, '        설계도 · 레이더 · 보유/설치한 전송기', C.orange, box.width, C.panel);
  write(c, box.x, box.y + 18, '유지    OH 코어 · 환생 횟수 · 누적 판매액', C.mint, box.width, C.panel);
  write(c, box.x, box.bottom - 2, ui.prestigeConfirm ? '현재 공장으로 되돌릴 수 없습니다. [Y]로 확정하세요.' : prestige.available ? '새 회차는 기본 채굴 라인과 시작 자금으로 출발합니다.' : `환생까지 ₵${formatNumber(Math.max(0, prestige.requiredRevenue - prestige.runRevenue))} 더 판매하세요.`, ui.prestigeConfirm ? C.orange : C.dim, box.width, C.panel);
  write(c, box.x, box.bottom, ui.prestigeConfirm ? '[Y] 환생 확정  [ESC] 취소' : prestige.available ? '[E/ENTER] 환생 확인  [ESC/T] 돌아가기' : '[ESC/T] 돌아가기', C.gold, box.width, C.panel);
}

function localRecordsModal(c, game, ui) {
  const prestige = prestigeInfo(game);
  const box = modal(c, ui.demo ? 'DEMO RECORD / 데모 공장 기록' : 'LOCAL RECORD / 내 공장 기록', ui.demo ? '데모 기록 · 실제 진행 상황에는 반영되지 않습니다.' : '개인 플레이 · 계정 없이 이 기기에서 즐기는 공장', 24, 84);
  const rows = [
    [`누적 판매액  ₵${formatNumber(game.lifetimeRevenue)}`, C.gold],
    [`이번 회차 판매액  ₵${formatNumber(prestige.runRevenue)}`, C.text],
    [`판매한 물품  ${formatNumber(game.soldCount)}개`, C.text],
    [`현재 설비  ${formatNumber(game.buildings.length)}개`, C.text],
    [`환생  ${formatNumber(game.progression.prestigeCount)}회`, C.purple],
    [`OH 코어  ${formatNumber(prestige.cores)}개  ·  판매 배율 ${multiplier(prestige.multiplier)}`, C.mint],
  ];
  rows.forEach(([text, color], index) => write(c, box.x, box.y + 5 + index * 2, text, color, box.width, C.panel));
  write(c, box.x, box.y + 17, '코어 1개당 판매가 +25% · 자동 적용 · 소모되지 않음', C.dim, box.width, C.panel);
  const saveStatus = ui.demo ? '데모 · 진행 상황 저장 안 함' : ui.saveError ? `저장 오류 · ${ui.saveError}` : '이 기기에 자동 저장 · 종료 후 최대 8시간 생산 반영';
  if (ui.saveError) rawWrite(c, box.x, box.y + 18, saveStatus, C.orange, box.width, C.panel);
  else write(c, box.x, box.y + 18, saveStatus, C.dim, box.width, C.panel);
  write(c, box.x, box.bottom, '[N] 닉네임 설정  [ESC / L] 돌아가기', C.gold, box.width, C.panel);
}

function safeAmount(value) { return Number.isFinite(value) && value >= 0 ? value : 0; }

export function formatGoldRate(value) { return formatNumber(safeAmount(value)); }

function leaderboardModal(c, ui) {
  const entries = Array.isArray(ui.leaders) ? ui.leaders : [];
  const month = /^\d{4}-\d{2}$/.test(ui.leaderboardMonth ?? '') ? `${ui.leaderboardMonth} · ` : '';
  const box = modal(c, 'MERCHANT GUILD / 월간 교역 리더보드', `${month}서버가 검증한 이번 달 판매액 순위`, 26, 94);
  write(c, box.x, box.y + 4, '매월 1일 00:00 (한국 시간) 점수 초기화', C.gold, box.width, C.panel);
  write(c, box.x, box.y + 5, '초당 평균 골드 생산량 = 월간 판매액 ÷ 생산 반영 시간', C.dim, box.width, C.panel);
  const scoreX = box.x + box.width - 28;
  const rateX = box.x + box.width - 12;
  write(c, box.x, box.y + 7, '순위   공장주', C.dim, box.width - 30, C.panel);
  write(c, scoreX, box.y + 7, '월간 판매액', C.dim, 14, C.panel);
  write(c, rateX, box.y + 7, '골드/초', C.dim, 12, C.panel);
  if (entries.length) {
    entries.slice(0, 10).forEach((entry, index) => {
      const rank = String(entry.rank ?? index + 1).padStart(2, ' ');
      const y = box.y + 8 + index;
      mixedWrite(c, box.x, y, [rank + '   ', entry.nickname ? { raw: entry.nickname } : '이름 없는 공장'], index < 3 ? C.gold : C.text, box.width - 30, C.panel);
      write(c, scoreX, y, `₵${formatNumber(safeAmount(entry.score))}`, C.mint, 14, C.panel);
      write(c, rateX, y, formatGoldRate(entry.goldPerSecond), C.mint, 12, C.panel);
    });
  } else {
    write(c, box.x, box.y + 9, ui.leaderboardLoading || ui.cloud?.status === 'connecting' ? '리더보드를 불러오고 있습니다…' : ui.cloud?.status === 'online' ? '아직 순위 기록이 없습니다. 첫 판매를 시작하세요.' : '서버에 연결되면 공식 순위를 불러올 수 있습니다.', C.text, box.width, C.panel);
    writeMessage(c, box.x, box.y + 11, ui.cloud?.message || (ui.cloud?.status === 'online' ? '이번 달 서버에서 확인한 판매액으로 집계합니다.' : '[G] 서버 연결 다시 시도'), C.dim, box.width, C.panel);
  }
  const me = ui.myRank;
  if (me) mixedWrite(c, box.x, box.bottom - 4, typeof me === 'object'
    ? [`내 공장 #${me.rank}  `, { raw: fitText(me.nickname ?? '', 20) }, ` ₵${formatNumber(safeAmount(me.score))} · ${formatGoldRate(me.goldPerSecond)} 골드/초`]
    : [`내 공장 #${me}`], C.mint, box.width, C.panel);
  write(c, box.x, box.bottom - 2, '최대 8시간 오프라인 생산 포함 · 공장과 OH 코어는 유지', C.dim, box.width, C.panel);
  write(c, box.x, box.bottom, '[N] 닉네임 설정  [ESC / L] 돌아가기', C.gold, box.width, C.panel);
}

function skinModal(c, ui) {
  const selected = clamp(Number.isInteger(ui.skinIndex) ? ui.skinIndex : SKINS.findIndex(skin => skin.id === c.skin.id), 0, SKINS.length - 1);
  if (c.width < 88 || c.height < 30) {
    c.clear(C.bg);
    write(c, 2, 1, 'APPEARANCE / 스킨 설정', C.mint);
    SKINS.forEach((skin, index) => rawWrite(c, 2, 3 + index * 2,
      `${index === selected ? '>' : ' '} ${index + 1} ${skin.name}${skin.id === c.skin.id ? ' *' : ''}`, index === selected ? C.white : C.dim));
    if (ui.skinError) rawWrite(c, 2, Math.max(0, c.height - 5), ui.skinError, C.orange);
    write(c, 2, Math.max(0, c.height - 3), '[1–3 / W/S] 선택 [ENTER/E] 적용', C.gold);
    write(c, 2, Math.max(0, c.height - 2), '[ESC/K] 닫기', C.dim);
    return;
  }
  const box = modal(c, 'APPEARANCE / 스킨 설정', '화면 표시만 변경하며 진행 상황과 저장 방식은 유지됩니다.', 22, 88);
  SKINS.forEach((skin, index) => {
    const y = box.y + 5 + index * 4;
    const active = skin.id === c.skin.id;
    rawWrite(c, box.x, y, `${index === selected ? '>' : ' '} ${index + 1}  ${skin.name}${active ? '  [ACTIVE]' : ''}`, index === selected ? C.white : C.dim, box.width, C.panel);
    // These descriptions compare vocabularies, so show the actual mode names.
    rawWrite(c, box.x + 4, y + 1, skin.description, C.dim, box.width - 4, C.panel);
  });
  if (ui.skinError) rawWrite(c, box.x, box.bottom - 3, ui.skinError, C.orange, box.width, C.panel);
  write(c, box.x, box.bottom - 1, '[W/S ↑↓ / 1–3] 선택  [E/ENTER] 적용', C.gold, box.width, C.panel);
  write(c, box.x, box.bottom, ui.demo ? '[ESC/K] 닫기 · 데모에서는 이번 실행에만 적용' : '[ESC/K] 닫기 · 이 기기의 개인 설정으로 저장', C.dim, box.width, C.panel);
}

export function renderFactory(game, inputUi = {}, width = 120, height = 40) {
  const size = dimensions(width, height);
  const ui = { time: 0, selected: 'belt', direction: 1, recipe: 'iron_plate', ...inputUi };
  const c = new SkinCanvas(size.width, size.height, getSkin(ui.skin)).clear(C.bg);
  ui.time = Number.isFinite(ui.time) ? ui.time : 0;
  if (c.width < 88 || c.height < 30) {
    if (ui.nicknameEditor) { nicknameModal(c, game, ui); return c; }
    if (ui.skinPicker) { skinModal(c, ui); return c; }
    write(c, 2, 1, c.skin.work ? 'WISE FACTORY / workspace' : '✦ WISE FACTORY', C.mint);
    write(c, 2, 3, '터미널을 88열 × 30행 이상으로 넓혀 주세요.', C.text);
    write(c, 2, 5, `자금 ₵${formatNumber(game.coins)} · 누적 판매 ₵${formatNumber(game.lifetimeRevenue)}`, C.gold);
    write(c, 2, 7, ui.paused ? '[P] 계속 · [Q] 저장 후 종료' : '공장은 계속 가동 중 · [Q] 저장 후 종료', C.dim);
    return c;
  }
  const view = factoryViewport(game, c.width, c.height);
  const stats = factoryStats(game);
  const prestige = prestigeInfo(game);
  if (c.skin.work) {
    c.fill(0, 0, c.width, 1, ' ', C.dim, C.panel);
    rawWrite(c, 2, 0, `workspace  /  map.grid       inspector       ${c.skin.name}`, C.dim, c.width - 4, C.panel);
  }
  write(c, 2, 1, c.skin.work ? 'WISE FACTORY / workspace' : '✦ WISE FACTORY', C.mint);
  const status = playStatus(ui);
  write(c, c.width - textWidth(c, status.text) - 2, 1, status.text, status.color);
  write(c, 2, 2, `회차 ₵${formatNumber(prestige.runRevenue)}  ·  환생 ${game.progression.prestigeCount}회  ·  OH 코어 ${formatNumber(prestige.cores)}  ·  판매 ${multiplier(prestige.multiplier)}`, C.purple);
  write(c, 2, 3, `자금  ₵${formatNumber(game.coins)}`, C.gold, 24);
  write(c, 29, 3, `누적 판매  ₵${formatNumber(game.lifetimeRevenue)}`, C.text, 27);
  const rate = stats.rate < 1000 ? Math.max(0, stats.rate).toFixed(1) : formatNumber(stats.rate);
  write(c, 60, 3, `${stats.rateLabel ?? '추정 수익'}  ₵${rate}/s`, C.mint);
  rawWrite(c, view.x, 4, `[N] ${nickname(game, ui)}`, C.dim, view.columns * 2 - 18);
  write(c, view.x + view.columns * 2 - 16, 4, c.skin.developer ? 'R 중앙 상인' : 'M 중앙 상인', C.gold, 16);
  drawTerrain(c, game, view, ui.time);
  drawMerchant(c, game, view, ui.time);
  drawMachines(c, game, view, ui.time);
  drawAtmosphere(c, game, view, ui.time, ui.effects);
  drawCursor(c, game, view, ui);
  if (c.skin.work) for (let row = 0; row < view.rows; row++) rawWrite(c, 0, view.y + row, String(view.top + row).padStart(2, '0'), C.dim, 2);
  inspector(c, game, ui, view);
  const facing = ARROWS[buildingAt(game, game.player.x, game.player.y)?.dir ?? ui.direction] ?? '→';
  write(c, 2, c.height - 5, `@ ${game.player.x},${game.player.y}  배출 ${facing}  ·  VIEW ${view.left}–${view.left + view.columns - 1} / ${view.top}–${view.top + view.rows - 1}`, C.dim, view.columns * 2);
  if (ui.saveError) rawWrite(c, 2, c.height - 4, `› ${ui.saveError}`, C.orange);
  else {
    rawWrite(c, 2, c.height - 4, c.skin.work ? '> ' : '› ', C.dim, 2);
    writeMessage(c, 4, c.height - 4, ui.logs?.[0] || '광맥을 찾아 채굴하고, 벨트를 중앙의 M 상인에게 연결하세요.', C.text);
  }
  write(c, 2, c.height - 3, '[WASD] 이동 [1–5] 설비 [E/SPACE] 설치 [R] 회전 [U] 강화 [X] 철거 [K] 스킨', C.dim);
  const footer = `[B] 상점 [T] 환생 [F] 제작 [C] 도감 [L] ${isCloudMode(ui) ? '순위' : ui.demo ? '기록' : '내 기록'} [N] 이름 [P] 정지 [?] 도움 [Q] 종료`;
  write(c, 2, c.height - 2, c.skin.developer && textWidth(c, footer) > c.width - 4
    ? '[B]목록 [T]리팩터 [F]빌드 [C]명세 [L]기록 [N]이름 [P]정지 [?]도움 [Q]종료'
    : footer, C.dim);
  if (ui.nicknameEditor) { nicknameModal(c, game, ui); return c; }
  if (ui.skinPicker) { skinModal(c, ui); return c; }
  if (ui.help) helpModal(c, ui);
  if (ui.recipes) recipesModal(c, game, ui);
  if (ui.leaderboard) {
    if (isCloudMode(ui)) leaderboardModal(c, ui);
    else localRecordsModal(c, game, ui);
  }
  if (ui.shop) shopModal(c, game, ui);
  if (ui.prestige) prestigeModal(c, game, ui);
  return c;
}
