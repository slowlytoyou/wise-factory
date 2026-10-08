/** Portable, deterministic factory simulation. No file, network, or runtime APIs. */
export const WORLD_WIDTH = 41;
export const WORLD_HEIGHT = 29;
export const MAX_OFFLINE_SECONDS = 8 * 60 * 60;
export const MAX_RADAR_LEVEL = 5;
const MAX_NUMBER = 1e15;
const MINING_SECONDS = 4;
const BUFFER_LIMIT = 20;
const TOTAL_BUFFER_LIMIT = 60;
const PRESTIGE_REVENUE = 5000;
const MERCHANT = Object.freeze({ x: 20, y: 14 });

export const DIRECTIONS = Object.freeze([
  { name: '북', dx: 0, dy: -1, glyph: '↑' },
  { name: '동', dx: 1, dy: 0, glyph: '→' },
  { name: '남', dx: 0, dy: 1, glyph: '↓' },
  { name: '서', dx: -1, dy: 0, glyph: '←' },
]);
export const ITEMS = Object.freeze({
  iron_ore: { name: '철광석', glyph: '◆', color: [155, 188, 214], price: 2 },
  copper_ore: { name: '구리광석', glyph: '◆', color: [239, 157, 95], price: 3 },
  coal: { name: '석탄', glyph: '●', color: [128, 139, 161], price: 2 },
  stone: { name: '돌', glyph: '▪', color: [180, 183, 180], price: 1 },
  iron_plate: { name: '철판', glyph: '▬', color: [193, 220, 238], price: 8 },
  copper_plate: { name: '구리판', glyph: '▬', color: [255, 185, 112], price: 10 },
  steel: { name: '강철', glyph: '▰', color: [199, 205, 255], price: 32 },
  gear: { name: '기어', glyph: '⚙', color: [250, 218, 127], price: 25 },
  circuit: { name: '회로', glyph: '▣', color: [127, 245, 166], price: 52 },
  engine: { name: '엔진', glyph: '✦', color: [243, 143, 208], price: 190 },
  wood: { name: '원목', glyph: '▥', color: [168, 196, 105], price: 5 },
  quartz: { name: '석영', glyph: '◇', color: [147, 232, 248], price: 6 },
  gold_ore: { name: '금광석', glyph: '◆', color: [255, 212, 91], price: 10 },
  pulp: { name: '펄프', glyph: '≋', color: [207, 202, 152], price: 16 },
  paper: { name: '종이', glyph: '▤', color: [236, 231, 210], price: 42 },
  glass: { name: '유리', glyph: '◇', color: [185, 239, 245], price: 22 },
  silicon: { name: '실리콘', glyph: '▱', color: [170, 178, 226], price: 38 },
  gold_plate: { name: '금괴', glyph: '▬', color: [255, 223, 114], price: 45 },
  wire: { name: '전선', glyph: '⌁', color: [251, 175, 111], price: 24 },
  chip: { name: '반도체', glyph: '▣', color: [145, 217, 241], price: 180 },
  lens: { name: '렌즈', glyph: '◎', color: [189, 241, 255], price: 65 },
  sensor: { name: '센서', glyph: '◈', color: [143, 235, 203], price: 180 },
  research_device: { name: '연구장비', glyph: '⊞', color: [192, 161, 253], price: 900 },
  research_data: { name: '실험데이터', glyph: '▦', color: [250, 158, 213], price: 1800 },
  research_paper: { name: '논문', glyph: '▤', color: [255, 234, 143], price: 6000 },
});
export const BUILDINGS = Object.freeze({
  miner: { name: '채굴기', cost: 70, glyph: 'M', description: '광맥에서 원물을 캐서 화살표 방향으로 보냅니다.' },
  belt: { name: '컨베이어', cost: 4, glyph: '>', description: '물건을 화살표 방향으로 운반합니다. 막히면 기다립니다.' },
  smelter: { name: '용광로', cost: 90, glyph: 'F', description: '광석을 제련하여 금속, 유리, 실리콘을 만듭니다.' },
  assembler: { name: '조립기', cost: 140, glyph: 'A', description: '부품과 종이를 조합하여 연구장비와 최종 생산물 논문을 만듭니다.' },
  transmitter: { name: '전송기', cost: 0, glyph: 'T', description: '인접 설비가 보낸 물건을 상인에게 전송하여 즉시 판매합니다.' },
});
export const SHOP_ITEMS = Object.freeze([
  { id: 'smelter_blueprint', name: '용광로 설계도', cost: 200, description: '용광로 건설과 광석 제련을 해금합니다.' },
  { id: 'assembler_blueprint', name: '조립기 설계도', cost: 700, description: '용광로 설계도 필요 · 조립기와 복합 생산을 해금합니다.' },
  { id: 'radar_copper', name: '구리 탐지 레이더', cost: 350, description: '구리 광맥의 위치를 밝히고 채굴할 수 있게 합니다.' },
  { id: 'radar_coal', name: '석탄 탐지 레이더', cost: 900, description: '구리 레이더 필요 · 석탄 광맥의 위치를 밝힙니다.' },
  { id: 'transmitter', name: '판매 전송기', cost: 250, description: '원하는 칸에 설치하는 판매 지점 1개 · 회수 후 재설치 가능' },
  { id: 'radar_wood', name: '원목 탐지 레이더', cost: 1800, description: '석탄 레이더 필요 · 숲을 발견하여 펄프와 종이를 생산합니다.' },
  { id: 'radar_quartz', name: '석영 탐지 레이더', cost: 3600, description: '원목 레이더 필요 · 석영 광맥을 밝혀 유리와 실리콘을 생산합니다.' },
  { id: 'radar_gold', name: '금 탐지 레이더', cost: 7200, description: '석영 레이더 필요 · 금 광맥을 밝혀 반도체와 연구 생산을 완성합니다.' },
]);
export const RECIPES = Object.freeze({
  iron_plate: { name: '철판 제련', building: 'smelter', inputs: { iron_ore: 2 }, output: 'iron_plate', amount: 1, seconds: 4 },
  copper_plate: { name: '구리판 제련', building: 'smelter', inputs: { copper_ore: 2 }, output: 'copper_plate', amount: 1, seconds: 4 },
  steel: { name: '강철 제련', building: 'smelter', inputs: { iron_plate: 2, coal: 1 }, output: 'steel', amount: 1, seconds: 6 },
  gear: { name: '기어 조립', building: 'assembler', inputs: { iron_plate: 2 }, output: 'gear', amount: 1, seconds: 5 },
  circuit: { name: '회로 조립', building: 'assembler', inputs: { iron_plate: 1, copper_plate: 2 }, output: 'circuit', amount: 1, seconds: 7 },
  engine: { name: '엔진 조립', building: 'assembler', inputs: { steel: 2, gear: 2, circuit: 1 }, output: 'engine', amount: 1, seconds: 12 },
  pulp: { name: '펄프 가공', building: 'assembler', inputs: { wood: 2 }, output: 'pulp', amount: 1, seconds: 5 },
  paper: { name: '종이 생산', building: 'assembler', inputs: { pulp: 2 }, output: 'paper', amount: 1, seconds: 6 },
  glass: { name: '유리 제련', building: 'smelter', inputs: { quartz: 2, stone: 1 }, output: 'glass', amount: 1, seconds: 6 },
  silicon: { name: '실리콘 제련', building: 'smelter', inputs: { quartz: 2, coal: 1 }, output: 'silicon', amount: 1, seconds: 7 },
  gold_plate: { name: '금괴 제련', building: 'smelter', inputs: { gold_ore: 2 }, output: 'gold_plate', amount: 1, seconds: 8 },
  wire: { name: '전선 조립', building: 'assembler', inputs: { copper_plate: 1 }, output: 'wire', amount: 1, seconds: 4 },
  chip: { name: '반도체 조립', building: 'assembler', inputs: { silicon: 2, circuit: 1, gold_plate: 1 }, output: 'chip', amount: 1, seconds: 10 },
  lens: { name: '렌즈 가공', building: 'assembler', inputs: { glass: 2 }, output: 'lens', amount: 1, seconds: 7 },
  sensor: { name: '센서 조립', building: 'assembler', inputs: { lens: 1, wire: 2, circuit: 1 }, output: 'sensor', amount: 1, seconds: 10 },
  research_device: { name: '연구장비 조립', building: 'assembler', inputs: { engine: 1, chip: 2, sensor: 1 }, output: 'research_device', amount: 1, seconds: 16 },
  research_data: { name: '실험데이터 생성', building: 'assembler', inputs: { research_device: 1, chip: 1, paper: 2 }, output: 'research_data', amount: 1, seconds: 20 },
  research_paper: { name: '논문 집필', building: 'assembler', inputs: { research_data: 2, paper: 3, chip: 1 }, output: 'research_paper', amount: 1, seconds: 30 },
});
const ITEM_KEYS = Object.keys(ITEMS);
const ITEM_CODES = Object.fromEntries(ITEM_KEYS.map((item, index) => [item, String.fromCharCode(65 + index)]));
const ORE_ITEM = { iron: 'iron_ore', copper: 'copper_ore', coal: 'coal', stone: 'stone', wood: 'wood', quartz: 'quartz', gold: 'gold_ore' };
const RADAR_TIERS = { radar_copper: 1, radar_coal: 2, radar_wood: 3, radar_quartz: 4, radar_gold: 5 };
const RADAR_PREREQUISITES = ['', '', '구리', '석탄', '원목', '석영'];
const has = (object, key) => Object.hasOwn(object, key);
const coord = (x, y) => Number.isInteger(x) && Number.isInteger(y) && x > 0 && y > 0 && x < WORLD_WIDTH - 1 && y < WORLD_HEIGHT - 1;
const safe = (value, fallback = 0, max = MAX_NUMBER) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(max, value)) : fallback;
const integer = (value, fallback = 0, max = MAX_NUMBER) => Math.floor(safe(value, fallback, max));
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const defaultRecipe = type => type === 'smelter' ? 'iron_plate' : type === 'assembler' ? 'gear' : '';
const validRecipe = (type, recipe) => typeof recipe === 'string' && has(RECIPES, recipe) && RECIPES[recipe].building === type;
const mineralAt = (game, building) => ORE_ITEM[tileAt(game, building.x, building.y)];
const localNickname = value => {
  if (typeof value !== 'string') return '공장장';
  const name = value.normalize('NFKC').trim().replace(/ +/g, ' ');
  return /^[\p{L}\p{N}_ -]{2,20}$/u.test(name) ? name : '공장장';
};

const newProgression = (unlocked = false) => ({
  schema: 1, unlocks: { smelter: unlocked, assembler: unlocked }, radarLevel: unlocked ? 2 : 0,
  transmitters: 0, prestigeCount: 0, cores: 0, runRevenue: 0,
});

export function buildingUnlocked(game, type) {
  if (typeof type !== 'string' || !has(BUILDINGS, type)) return false;
  return type !== 'smelter' && type !== 'assembler' || game.progression?.unlocks?.[type] === true;
}

export function shopOffers(game) {
  const progression = game.progression;
  return SHOP_ITEMS.map(item => {
    const radarTier = RADAR_TIERS[item.id];
    const owned = item.id === 'smelter_blueprint' ? progression.unlocks.smelter
      : item.id === 'assembler_blueprint' ? progression.unlocks.assembler
        : radarTier ? progression.radarLevel >= radarTier : false;
    const prerequisite = item.id === 'assembler_blueprint' && !progression.unlocks.smelter ? '용광로 설계도가 필요합니다.'
      : radarTier && progression.radarLevel < radarTier - 1 ? `${RADAR_PREREQUISITES[radarTier]} 탐지 레이더가 필요합니다.` : '';
    const reason = owned ? '이미 구매했습니다.' : prerequisite || (game.coins < item.cost ? '코인이 부족합니다.' : '');
    return { ...item, owned, available: !reason, reason };
  });
}

export function prestigeInfo(game) {
  const { runRevenue, cores } = game.progression;
  const gain = Math.floor(Math.sqrt(runRevenue / PRESTIGE_REVENUE));
  return { available: runRevenue >= PRESTIGE_REVENUE, gain, requiredRevenue: PRESTIGE_REVENUE,
    runRevenue, cores, multiplier: 1 + cores * 0.25, nextMultiplier: 1 + (cores + gain) * 0.25 };
}

export function tileAt(game, x, y) {
  if (Math.abs(x - MERCHANT.x) <= 1 && Math.abs(y - MERCHANT.y) <= 1) return 'merchant';
  if ((x >= 9 && x <= 12 && y >= 9 && y <= 15) || (x >= 9 && x <= 12 && y >= 19 && y <= 23)) return 'iron';
  if (x >= 27 && x <= 30 && y >= 8 && y <= 13 && game.progression?.radarLevel >= 1) return 'copper';
  if (((x >= 18 && x <= 21 && y >= 3 && y <= 5) || (x >= 27 && x <= 30 && y >= 19 && y <= 22)) && game.progression?.radarLevel >= 2) return 'coal';
  if (x >= 5 && x <= 8 && y >= 22 && y <= 25) return 'stone';
  if (x >= 3 && x <= 6 && y >= 5 && y <= 8 && game.progression?.radarLevel >= 3) return 'wood';
  if (x >= 33 && x <= 36 && y >= 4 && y <= 7 && game.progression?.radarLevel >= 4) return 'quartz';
  if (x >= 33 && x <= 36 && y >= 22 && y <= 25 && game.progression?.radarLevel >= 5) return 'gold';
  return 'ground';
}

export function buildingAt(game, x, y) {
  return game.buildings.find(building => building.x === x && building.y === y) ?? null;
}

function makeBuilding(game, type, x, y, dir = 1, recipe = defaultRecipe(type), level = 1) {
  return { id: `b${game.nextId++}`, type, x, y, dir, level, recipe, progress: 0, buffer: {}, item: null };
}

export function createFactory(now = Date.now(), { demo = false } = {}) {
  const game = {
    version: 3, contentVersion: 2, coins: demo ? 1500 : 300, lifetimeRevenue: 0, soldCount: 0,
    nickname: '공장장',
    elapsed: 0, stepRemainder: 0, savedAt: safe(now), nextId: 1,
    player: { x: 17, y: 16 }, merchant: { ...MERCHANT }, buildings: [],
    stats: { sold: {}, crafted: {} },
    progression: newProgression(demo),
  };
  const add = (type, x, y, dir = 1, recipe = defaultRecipe(type), level = 1) => game.buildings.push(makeBuilding(game, type, x, y, dir, recipe, level));
  const horizontal = (from, to, y, dir, level = 1) => {
    for (let x = Math.min(from, to); x <= Math.max(from, to); x++) add('belt', x, y, dir, '', level);
  };
  add('miner', 12, 14, 1, '', demo ? 2 : 1);
  if (!demo) horizontal(13, 18, 14, 1);
  else {
    // Left chain: ore → plates → gears → merchant.
    add('belt', 13, 14, 1);
    add('smelter', 14, 14, 1, 'iron_plate', 2);
    add('belt', 15, 14, 1);
    add('assembler', 16, 14, 1, 'gear', 2);
    horizontal(17, 18, 14, 1);
    // Upper chain: independent iron and copper lines combine into circuits.
    add('miner', 12, 10, 1, '', 2);
    horizontal(13, 15, 10, 1, 2);
    add('smelter', 16, 10, 1, 'iron_plate', 2);
    horizontal(17, 19, 10, 1, 2);
    add('miner', 27, 10, 3, '', 3);
    add('belt', 26, 10, 3, '', 2);
    add('smelter', 25, 10, 3, 'copper_plate', 2);
    horizontal(21, 24, 10, 3, 2);
    add('assembler', 20, 10, 2, 'circuit', 2);
    add('belt', 20, 11, 2); add('belt', 20, 12, 2);
    // Lower chain: iron plates and coal combine into steel.
    add('miner', 12, 20, 1, '', 3);
    add('belt', 13, 20, 1, '', 2);
    add('smelter', 14, 20, 1, 'iron_plate', 2);
    horizontal(15, 19, 20, 1, 2);
    add('miner', 27, 20, 3, '', 1);
    horizontal(21, 26, 20, 3, 2);
    add('smelter', 20, 20, 0, 'steel', 2);
    for (let y = 16; y <= 19; y++) add('belt', 20, y, 0);
  }
  return game;
}

function upgradePrice(type, level) {
  return Math.ceil(BUILDINGS[type].cost * 0.65 * level ** 1.55);
}
export function upgradeCost(building) {
  return building && has(BUILDINGS, building.type) && building.type !== 'transmitter' && Number.isInteger(building.level) && building.level >= 1 && building.level < 5
    ? upgradePrice(building.type, building.level) : Infinity;
}

export function applyAction(game, action) {
  const fail = message => ({ ok: false, message });
  const success = message => ({ ok: true, message });
  if (!isObject(action)) return fail('올바르지 않은 명령입니다.');
  if (action.type === 'purchase') {
    const offer = shopOffers(game).find(item => item.id === action.item);
    if (!offer) return fail('알 수 없는 상점 품목입니다.');
    if (!offer.available) return fail(offer.reason);
    game.coins -= offer.cost;
    if (offer.id === 'smelter_blueprint') game.progression.unlocks.smelter = true;
    else if (offer.id === 'assembler_blueprint') game.progression.unlocks.assembler = true;
    else if (RADAR_TIERS[offer.id]) game.progression.radarLevel = RADAR_TIERS[offer.id];
    else game.progression.transmitters++;
    return success(`${offer.name} 구매`);
  }
  if (action.type === 'prestige') {
    const info = prestigeInfo(game);
    if (!info.available) return fail(`이번 회차 판매 수익 ${PRESTIGE_REVENUE}코인이 필요합니다.`);
    const previous = game.progression, lifetimeRevenue = game.lifetimeRevenue, soldCount = game.soldCount;
    const fresh = createFactory(game.savedAt);
    fresh.nickname = localNickname(game.nickname);
    fresh.progression.cores = previous.cores + info.gain;
    fresh.progression.prestigeCount = previous.prestigeCount + 1;
    fresh.lifetimeRevenue = lifetimeRevenue; fresh.soldCount = soldCount;
    Object.assign(game, fresh);
    return success(`환생 완료 · 코어 +${info.gain} · 판매가 ×${prestigeInfo(game).multiplier}`);
  }
  if (action.type === 'move') {
    if (!Number.isInteger(action.dx) || !Number.isInteger(action.dy) || Math.abs(action.dx) + Math.abs(action.dy) !== 1) return fail('한 번에 한 칸만 이동할 수 있습니다.');
    const x = game.player.x + action.dx, y = game.player.y + action.dy;
    if (!coord(x, y)) return fail('맵 가장자리입니다.');
    game.player = { x, y }; return success('이동');
  }
  if (!['build', 'rotate', 'upgrade', 'remove', 'recipe'].includes(action.type)) return fail('지원하지 않는 명령입니다.');
  if (!coord(action.x, action.y)) return fail('건설할 수 없는 좌표입니다.');
  const building = buildingAt(game, action.x, action.y);
  if (action.type === 'build') {
    if (typeof action.building !== 'string' || !has(BUILDINGS, action.building)) return fail('알 수 없는 설비입니다.');
    if (!Number.isInteger(action.dir) || action.dir < 0 || action.dir > 3) return fail('방향은 0~3이어야 합니다.');
    if (building) return fail('이미 설비가 있습니다.');
    if (tileAt(game, action.x, action.y) === 'merchant') return fail('상인 구역에는 건설할 수 없습니다.');
    const type = action.building, recipe = action.recipe ?? defaultRecipe(type);
    if (!buildingUnlocked(game, type)) return fail('상인에게서 설계도를 먼저 구매하세요.');
    if ((type === 'smelter' || type === 'assembler') && !validRecipe(type, recipe)) return fail('이 설비에서 만들 수 없는 조합법입니다.');
    if (type === 'miner' && !ORE_ITEM[tileAt(game, action.x, action.y)]) return fail('채굴기는 광맥 위에 설치하세요.');
    if (type === 'transmitter') {
      if (game.progression.transmitters < 1) return fail('상인에게서 판매 전송기를 구매하세요.');
      game.progression.transmitters--;
    } else {
      if (game.coins < BUILDINGS[type].cost) return fail('코인이 부족합니다.');
      game.coins -= BUILDINGS[type].cost;
    }
    game.buildings.push(makeBuilding(game, type, action.x, action.y, action.dir, type === 'smelter' || type === 'assembler' ? recipe : ''));
    return success(`${BUILDINGS[type].name} 설치`);
  }
  if (!building) return fail('이곳에는 설비가 없습니다.');
  if (action.type === 'rotate') {
    if (building.type === 'transmitter') return fail('전송기는 모든 방향에서 물건을 받습니다.');
    building.dir = (building.dir + 1) % 4; return success('출력 방향 회전');
  }
  if (action.type === 'upgrade') {
    const cost = upgradeCost(building);
    if (!Number.isFinite(cost)) return fail(building.type === 'transmitter' ? '전송기는 업그레이드가 필요 없습니다.' : '최대 레벨입니다.');
    if (game.coins < cost) return fail('코인이 부족합니다.');
    game.coins -= cost; building.level++; return success(`${BUILDINGS[building.type].name} Lv.${building.level}`);
  }
  if (action.type === 'recipe') {
    if (!validRecipe(building.type, action.recipe)) return fail('이 설비에서 만들 수 없는 조합법입니다.');
    if (building.recipe === action.recipe) return success('이미 선택한 조합법입니다.');
    building.recipe = action.recipe; building.progress = 0;
    return success('조합법 변경 · 저장된 재료와 완성품 유지');
  }
  if (building.type === 'transmitter') {
    game.progression.transmitters++;
    game.buildings.splice(game.buildings.indexOf(building), 1);
    return success('판매 전송기 회수 · 재고 +1');
  }
  let investment = BUILDINGS[building.type].cost;
  for (let level = 1; level < building.level; level++) investment += upgradePrice(building.type, level);
  const refund = Math.floor(investment / 2);
  game.coins += refund;
  game.buildings.splice(game.buildings.indexOf(building), 1);
  return success(`설비 회수 +${refund}코인 · 내부 재료 폐기`);
}

function addEvent(events, event) {
  events.push(event);
  if (events.length > 128) events.splice(0, 64);
}

function produceSubstep(game, ordered, events) {
  for (const building of ordered) {
    if (building.item !== null || building.type === 'belt' || building.type === 'transmitter') continue;
    if (building.type === 'miner') {
      const item = mineralAt(game, building);
      if (!item) continue;
      building.progress = (Math.round(building.progress * 5) + building.level) / 5;
      if (building.progress >= MINING_SECONDS) {
        building.progress = Math.round((building.progress - MINING_SECONDS) * 5) / 5;
        building.item = item;
        addEvent(events, { type: 'mine', x: building.x, y: building.y, item, amount: 1 });
      }
    } else {
      const recipe = RECIPES[building.recipe];
      if (!recipe || !Object.entries(recipe.inputs).every(([item, count]) => (building.buffer[item] ?? 0) >= count)) {
        building.progress = 0; continue;
      }
      building.progress = (Math.round(building.progress * 5) + building.level) / 5;
      if (building.progress >= recipe.seconds) {
        building.progress = Math.round((building.progress - recipe.seconds) * 5) / 5;
        for (const [item, count] of Object.entries(recipe.inputs)) {
          building.buffer[item] -= count;
          if (!building.buffer[item]) delete building.buffer[item];
        }
        building.item = recipe.output;
        game.stats.crafted[recipe.output] = (game.stats.crafted[recipe.output] ?? 0) + recipe.amount;
        addEvent(events, { type: 'craft', x: building.x, y: building.y, item: recipe.output, amount: recipe.amount });
      }
    }
  }
}

function simulateSecond(game, ordered, tiles, events) {
  // Five deterministic substeps make every upgrade meaningful, including Lv.5.
  // Progress is quantized to fifths of a second to avoid floating point drift.
  for (let pass = 0; pass < 5; pass++) {
    produceSubstep(game, ordered, events);
    // Each pass uses the same occupancy snapshot for every source. Items never
    // teleport through an arbitrarily long belt because of array iteration order.
    const moves = [], reservedBelts = new Set(), reservedInputs = new Map();
    for (const source of ordered) {
      if (source.type === 'transmitter' || source.item === null || (source.type === 'belt' && pass >= source.level)) continue;
      const direction = DIRECTIONS[source.dir], x = source.x + direction.dx, y = source.y + direction.dy;
      if (tileAt(game, x, y) === 'merchant') { moves.push([source, null, source.item, x, y]); continue; }
      if (!coord(x, y)) continue;
      const target = tiles[y * WORLD_WIDTH + x];
      if (!target || target.type === 'miner') continue;
      if (target.type === 'belt') {
        // The receiving belt accepts cargo from its rear or sides, never from
        // its output edge. Facing belts must jam instead of bouncing an item.
        if (target.dir === (source.dir + 2) % 4) continue;
        if (target.item !== null || reservedBelts.has(target)) continue;
        reservedBelts.add(target);
      } else if (target.type !== 'transmitter') {
        const recipe = RECIPES[target.recipe];
        if (!recipe || !has(recipe.inputs, source.item)) continue;
        const pending = reservedInputs.get(target) ?? {};
        const count = (target.buffer[source.item] ?? 0) + (pending[source.item] ?? 0);
        const total = Object.values(target.buffer).reduce((a, b) => a + b, 0) + Object.values(pending).reduce((a, b) => a + b, 0);
        if (count >= BUFFER_LIMIT || total >= TOTAL_BUFFER_LIMIT) continue;
        pending[source.item] = (pending[source.item] ?? 0) + 1;
        reservedInputs.set(target, pending);
      }
      moves.push([source, target, source.item, x, y]);
    }
    for (const [source, target, item, x, y] of moves) {
      source.item = null;
      if (!target || target.type === 'transmitter') {
        const value = ITEMS[item].price * (1 + game.progression.cores * 0.25);
        game.coins += value; game.lifetimeRevenue += value; game.progression.runRevenue += value; game.soldCount++;
        game.stats.sold[item] = (game.stats.sold[item] ?? 0) + 1;
        addEvent(events, { type: 'sale', x, y, item, amount: 1, value });
      } else if (target.type === 'belt') target.item = item;
      else target.buffer[item] = (target.buffer[item] ?? 0) + 1;
    }
  }
}

function machineSignature(ordered) {
  return ordered.map(building => building.type === 'belt' ? (ITEM_CODES[building.item] ?? '.')
    : `${building.progress}:${ITEM_CODES[building.item] ?? '.'}:${ITEM_KEYS.map(item => building.buffer[item] ?? 0).join(',')}`).join('|');
}

function transferComponents(ordered, tiles) {
  const parents = new Map(ordered.map(building => [building, building]));
  const root = building => {
    let result = building;
    while (parents.get(result) !== result) result = parents.get(result);
    while (parents.get(building) !== building) {
      const next = parents.get(building); parents.set(building, result); building = next;
    }
    return result;
  };
  for (const source of ordered) {
    if (source.type === 'transmitter') continue;
    const { dx, dy } = DIRECTIONS[source.dir];
    const target = tiles[(source.y + dy) * WORLD_WIDTH + source.x + dx];
    if (target && target.type !== 'miner') parents.set(root(source), root(target));
  }
  const groups = new Map();
  for (const building of ordered) {
    const key = root(building), group = groups.get(key) ?? [];
    group.push(building); groups.set(key, group);
  }
  return groups.values();
}

function advanceComponent(game, ordered, tiles, steps, events) {
  // A repeated complete machine state proves a periodic production cycle.
  // Revenue and counters are additive, so skipping it is exact, not an estimate.
  const cycles = steps >= 120 ? new Map() : null;
  let step = 0, skipped = false, signatureBytes = 0;
  while (step < steps) {
    if (cycles && !skipped && cycles.size < 4096 && signatureBytes < 4_000_000) {
      const signature = machineSignature(ordered), previous = cycles.get(signature);
      if (previous) {
        const cycleLength = step - previous.step, repetitions = Math.floor((steps - step) / cycleLength);
        if (repetitions > 0) {
          game.coins += (game.coins - previous.coins) * repetitions;
          game.lifetimeRevenue += (game.lifetimeRevenue - previous.revenue) * repetitions;
          game.progression.runRevenue += (game.progression.runRevenue - previous.runRevenue) * repetitions;
          game.soldCount += (game.soldCount - previous.soldCount) * repetitions;
          for (const key of ['sold', 'crafted']) for (const item of ITEM_KEYS) {
            const difference = (game.stats[key][item] ?? 0) - (previous.stats[key][item] ?? 0);
            if (difference) game.stats[key][item] = (game.stats[key][item] ?? 0) + difference * repetitions;
          }
          step += cycleLength * repetitions; skipped = true; events.length = 0;
          continue;
        }
      } else {
        cycles.set(signature, { step, coins: game.coins, revenue: game.lifetimeRevenue, runRevenue: game.progression.runRevenue, soldCount: game.soldCount, stats: { sold: { ...game.stats.sold }, crafted: { ...game.stats.crafted } } });
        signatureBytes += signature.length * 2;
      }
    }
    simulateSecond(game, ordered, tiles, events); step++;
  }
}

/** Fixed one-second ticks preserve results across arbitrary render frame sizes. */
export function advanceFactory(game, seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return { earned: 0, events: [] };
  seconds = Math.min(seconds, MAX_OFFLINE_SECONDS);
  const total = game.stepRemainder + seconds;
  const steps = Math.floor(total + 1e-9);
  game.stepRemainder = Math.max(0, total - steps);
  game.elapsed += seconds;
  const previousCoins = game.coins, events = [];
  if (steps === 0) return { earned: 0, events };
  const ordered = [...game.buildings].sort((a, b) => a.y * WORLD_WIDTH + a.x - (b.y * WORLD_WIDTH + b.x));
  const tiles = new Array(WORLD_WIDTH * WORLD_HEIGHT);
  for (const building of ordered) tiles[building.y * WORLD_WIDTH + building.x] = building;
  // Disconnected routes cannot exchange items. Detect their periods separately;
  // unrelated conveyor loops need not wait for a huge common combined period.
  const components = steps >= 120 ? transferComponents(ordered, tiles) : [ordered];
  for (const component of components) advanceComponent(game, component, tiles, steps, events);
  return { earned: game.coins - previousCoins, events };
}

export function serializeFactory(game, now = Date.now()) {
  return {
    version: 3, contentVersion: 2, coins: game.coins, lifetimeRevenue: game.lifetimeRevenue, soldCount: game.soldCount,
    nickname: localNickname(game.nickname),
    elapsed: game.elapsed, stepRemainder: game.stepRemainder, savedAt: safe(now), nextId: game.nextId,
    player: { ...game.player }, merchant: { ...MERCHANT },
    buildings: game.buildings.map(building => ({ ...building, buffer: { ...building.buffer } })),
    stats: { sold: { ...game.stats.sold }, crafted: { ...game.stats.crafted } },
    progression: { ...game.progression, unlocks: { ...game.progression.unlocks } },
  };
}

export function hydrateFactory(raw, now = Date.now(), { offline = true } = {}) {
  now = safe(now);
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = null; } }
  if (!isObject(raw) || ![2, 3].includes(raw.version)) return { game: createFactory(now), offlineEarned: 0, offlineSeconds: 0 };
  // Only v2 saves that predate progression receive compatibility unlocks.
  // Current saves with missing or malformed fields must stay locked.
  const legacy = raw.version === 2 && !has(raw, 'progression');
  const progression = newProgression(legacy);
  if (legacy) progression.runRevenue = safe(raw.lifetimeRevenue);
  else if (isObject(raw.progression) && raw.progression.schema === 1) {
    const source = raw.progression;
    progression.unlocks.smelter = source.unlocks?.smelter === true;
    progression.unlocks.assembler = progression.unlocks.smelter && source.unlocks?.assembler === true;
    progression.radarLevel = Number.isInteger(source.radarLevel) && source.radarLevel >= 0 && source.radarLevel <= MAX_RADAR_LEVEL ? source.radarLevel : 0;
    for (const key of ['transmitters', 'prestigeCount', 'cores']) progression[key] = integer(source[key]);
    progression.runRevenue = safe(source.runRevenue);
  }
  const game = {
    version: 3, contentVersion: 2, coins: safe(raw.coins, 300), lifetimeRevenue: safe(raw.lifetimeRevenue), soldCount: integer(raw.soldCount),
    nickname: localNickname(raw.nickname),
    elapsed: safe(raw.elapsed), stepRemainder: safe(raw.stepRemainder, 0, 0.999999999),
    savedAt: now, nextId: 1, merchant: { ...MERCHANT },
    player: isObject(raw.player) && coord(raw.player.x, raw.player.y) ? { x: raw.player.x, y: raw.player.y } : { x: 17, y: 16 },
    buildings: [], stats: { sold: {}, crafted: {} },
    progression,
  };
  const occupied = new Set(), ids = new Set();
  if (Array.isArray(raw.buildings)) for (const entry of raw.buildings.slice(0, WORLD_WIDTH * WORLD_HEIGHT)) {
    if (!isObject(entry) || !coord(entry.x, entry.y) || !buildingUnlocked(game, entry.type) || tileAt(game, entry.x, entry.y) === 'merchant') continue;
    const position = entry.y * WORLD_WIDTH + entry.x;
    if (occupied.has(position) || (entry.type === 'miner' && !ORE_ITEM[tileAt(game, entry.x, entry.y)])) continue;
    occupied.add(position);
    const building = makeBuilding(game, entry.type, entry.x, entry.y,
      Number.isInteger(entry.dir) && entry.dir >= 0 && entry.dir <= 3 ? entry.dir : 1,
      validRecipe(entry.type, entry.recipe) ? entry.recipe : defaultRecipe(entry.type),
      entry.type === 'transmitter' ? 1 : Math.max(1, integer(entry.level, 1, 5)));
    if (typeof entry.id === 'string' && /^b[1-9]\d{0,8}$/.test(entry.id) && !ids.has(entry.id)) building.id = entry.id;
    while (ids.has(building.id)) building.id = `b${game.nextId++}`;
    ids.add(building.id);
    game.nextId = Math.max(game.nextId, Number(building.id.slice(1)) + 1);
    building.item = entry.type !== 'transmitter' && typeof entry.item === 'string' && has(ITEMS, entry.item) ? entry.item : null;
    const duration = entry.type === 'miner' ? MINING_SECONDS : RECIPES[building.recipe]?.seconds ?? 1;
    building.progress = entry.type === 'transmitter' ? 0 : Math.round(safe(entry.progress, 0, duration - 0.2) * 5) / 5;
    let capacity = TOTAL_BUFFER_LIMIT;
    if (entry.type !== 'transmitter' && isObject(entry.buffer)) for (const item of ITEM_KEYS) {
      const count = integer(entry.buffer[item], 0, Math.min(BUFFER_LIMIT, capacity));
      if (count) { building.buffer[item] = count; capacity -= count; }
    }
    game.buildings.push(building);
  }
  game.nextId = Math.max(game.nextId, integer(raw.nextId, 1, 1e9));
  for (const key of ['sold', 'crafted']) if (isObject(raw.stats?.[key])) for (const item of ITEM_KEYS) {
    const count = integer(raw.stats[key][item]);
    if (count) game.stats[key][item] = count;
  }
  game.lifetimeRevenue = Math.max(game.lifetimeRevenue, progression.runRevenue);
  game.soldCount = Math.max(game.soldCount, Object.values(game.stats.sold).reduce((sum, count) => sum + count, 0));
  const offlineSeconds = offline && typeof raw.savedAt === 'number' && Number.isFinite(raw.savedAt)
    ? Math.min(MAX_OFFLINE_SECONDS, Math.max(0, (now - raw.savedAt) / 1000)) : 0;
  const offlineEarned = advanceFactory(game, offlineSeconds).earned;
  return { game, offlineEarned, offlineSeconds };
}

export function factoryStats(game) {
  const inventoryItems = {};
  for (const building of game.buildings) {
    if (building.item) inventoryItems[building.item] = (inventoryItems[building.item] ?? 0) + 1;
    for (const [item, count] of Object.entries(building.buffer)) inventoryItems[item] = (inventoryItems[item] ?? 0) + count;
  }
  return {
    rate: game.elapsed > 0 ? game.progression.runRevenue / game.elapsed : 0, rateLabel: '회차 평균',
    buildings: game.buildings.length, miners: game.buildings.filter(b => b.type === 'miner').length,
    belts: game.buildings.filter(b => b.type === 'belt').length,
    processors: game.buildings.filter(b => b.type === 'smelter' || b.type === 'assembler').length,
    inventory: Object.values(inventoryItems).reduce((a, b) => a + b, 0), inventoryItems,
    soldCount: game.soldCount, lifetimeRevenue: game.lifetimeRevenue,
    runRevenue: game.progression.runRevenue,
  };
}
