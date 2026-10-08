import test from 'node:test';
import assert from 'node:assert/strict';
import { SKINS, getSkin, skinText, WORK_ITEM_NAMES } from '../src/skins.mjs';
import { ITEMS, BUILDINGS, RECIPES, SHOP_ITEMS } from '../src/factory.mjs';

test('three skins have stable IDs and non-developer skins preserve vocabulary', () => {
  assert.deepEqual(SKINS.map(skin => skin.id), ['original', 'work', 'work-dev']);
  assert.equal(getSkin('unknown').id, 'original');
  assert.ok(Object.isFrozen(SKINS));
  assert.ok(SKINS.every(Object.isFrozen));
  for (const value of ['채굴기 · 철광석 · OH 코어', '논문 판매가 ₵6,000', '환생 · 월간 판매액']) {
    assert.equal(skinText(value, 'original'), value);
    assert.equal(skinText(value, 'work'), value);
  }
});

test('developer vocabulary covers every raw material, product, building, recipe and shop offer', () => {
  for (const [id, item] of Object.entries(ITEMS)) assert.equal(skinText(item.name, 'work-dev'), WORK_ITEM_NAMES[id], id);
  for (const definition of [...Object.values(BUILDINGS), ...Object.values(RECIPES), ...SHOP_ITEMS]) {
    assert.notEqual(skinText(definition.name, 'work-dev'), definition.name);
  }
  assert.equal(skinText('논문 집필 · 실험데이터 ×2 + 종이 ×3 + 반도체 ×1', 'work-dev'),
    '기술 백서 작성 · 벤치마크 ×2 + 문서 ×3 + 컴파일러 ×1');
});

test('translations use one longest-match pass and never corrupt unrelated short words or stable IDs', () => {
  assert.equal(skinText('OH 코어 · 코어 · 판매가 · 판매', 'work-dev'), '설계 포인트 · 포인트 · 배포 보상 · 배포');
  assert.equal(skinText('돌아가기 · 되돌릴 수 없습니다 · 지금 · 비용 회수', 'work-dev'), '돌아가기 · 되돌릴 수 없습니다 · 지금 · 비용 회수');
  assert.equal(skinText('철 2 구리 3 석탄 2 돌 1 금 10', 'work-dev'), '소스 2 API 3 연산 자원 2 테스트 케이스 1 데이터 10');
  assert.equal(skinText('research_paper --skin work-dev src/main.mjs', 'work-dev'), 'research_paper --skin work-dev src/main.mjs');
  assert.equal(skinText('매월 1일 00:00 (한국 시간) 점수 초기화', 'work-dev'), '매월 1일 00:00 (한국 시간) 점수 초기화');
});
