/** Presentation preferences only; IDs and economic state never change with a skin. */
export const SKINS = Object.freeze([
  Object.freeze({ id: 'original', name: 'Original Skin', description: '기존 공장 화면 · 풍부한 색상과 애니메이션', work: false, developer: false }),
  Object.freeze({ id: 'work', name: 'Work Skin', description: '차분한 업무 화면 · 게임 용어 유지', work: true, developer: false }),
  Object.freeze({ id: 'work-dev', name: 'Work Skin · Dev', description: '차분한 업무 화면 · 프로그래밍 용어', work: true, developer: true }),
]);

export function getSkin(id) { return SKINS.find(skin => skin.id === id) ?? SKINS[0]; }

export const WORK_ITEM_NAMES = Object.freeze({
  iron_ore: '소스코드', copper_ore: 'API 명세', coal: '연산 자원', stone: '테스트 케이스',
  iron_plate: '모듈', copper_plate: '인터페이스', steel: '라이브러리', gear: '함수', circuit: '서비스', engine: '런타임',
  wood: '원시 텍스트', quartz: '스키마', gold_ore: '원시 데이터', pulp: '토큰', paper: '문서', glass: '타입 정의',
  silicon: '중간 표현', gold_plate: '데이터셋', wire: '엔드포인트', chip: '컴파일러', lens: '검증기', sensor: '모니터',
  research_device: '테스트 환경', research_data: '벤치마크', research_paper: '기술 백서',
});

// Longest match wins in one pass: replacements cannot translate themselves.
// Use this on program-owned copy, never on user names, drafts, paths, or IDs.
const terms = {
  'WISE FACTORY': 'WISE WORKSPACE',
  'FIELD MANUAL': 'WORKSPACE GUIDE', 'PRODUCTION ATLAS': 'BUILD TARGETS',
  'MERCHANT EXCHANGE': 'PACKAGE CATALOG', 'MERCHANT GUILD': 'DELIVERY REPORT',
  'OH CORE': 'DESIGN POINTS', 'LOCAL RECORD': 'LOCAL REPORT', 'DEMO RECORD': 'SANDBOX REPORT',
  'LOCAL PLAY': 'LOCAL SESSION', 'CLOUD PLAY': 'CLOUD SESSION', 'MARKET': 'METRICS',
  'RECIPE': 'TARGET', 'DEMO': 'SANDBOX',
  '초당 평균 골드 생산량': '초당 평균 크레딧 처리량',
  '생산 반영 시간': '빌드 반영 시간',
  '월간 교역 리더보드': '월간 배포 리포트', '공식 순위': '공유 순위', '리더보드': '성과 보드',
  '월간 판매액': '월간 배포량', '누적 판매액': '누적 배포량', '이번 회차 판매액': '현재 주기 배포량',
  '누적 판매': '누적 배포', '판매한 물품': '배포한 패키지', '판매 금액': '배포 크레딧',
  '판매 수량': '배포 수량', '판매 수익': '배포 보상', '판매 배율': '크레딧 배율',
  '판매 전송기': '배포 훅', '중앙의 M 상인에게': '중앙 R 저장소에', '중앙의 M 상인': '중앙 R 저장소', 'M 중앙 상인': 'R 패키지 저장소', '중앙 M 상인': '중앙 R 저장소', '중앙 상인': '패키지 저장소',
  '판매 지점': '배포 지점', '시작 자금': '초기 예산',
  '용광로 설계도': '빌드 워커 명세', '조립기 설계도': '통합 워커 명세',
  '구리 탐지 레이더': 'API 탐색 인덱스', '석탄 탐지 레이더': '연산 탐색 인덱스',
  '원목 탐지 레이더': '텍스트 탐색 인덱스', '석영 탐지 레이더': '스키마 탐색 인덱스',
  '금 탐지 레이더': '데이터 탐색 인덱스',
  '채굴 장비': '수집 워커', '채굴기': '수집기', '컨베이어 벨트': '파이프라인', '컨베이어': '파이프라인',
  '생산 모듈': '빌드 모듈', '생산 설비': '빌드 워커', '가공 설비': '빌드 워커',
  '용광로': '빌드 워커', '조립기': '통합 워커', '전송기': '배포 훅',
  '철판 제련': '모듈 빌드', '구리판 제련': '인터페이스 빌드', '강철 제련': '라이브러리 빌드',
  '기어 조립': '함수 구현', '회로 조립': '서비스 통합', '엔진 조립': '런타임 빌드',
  '펄프 가공': '텍스트 토큰화', '종이 생산': '문서 생성', '유리 제련': '타입 생성',
  '실리콘 제련': '중간 표현 생성', '금괴 제련': '데이터 정제', '전선 조립': '엔드포인트 구성',
  '반도체 조립': '컴파일러 빌드', '렌즈 가공': '검증기 구현', '센서 조립': '모니터 구성',
  '연구장비 조립': '테스트 환경 구성', '실험데이터 생성': '벤치마크 실행', '논문 집필': '기술 백서 작성',
  '철광석': WORK_ITEM_NAMES.iron_ore, '구리광석': WORK_ITEM_NAMES.copper_ore,
  '철판': WORK_ITEM_NAMES.iron_plate, '구리판': WORK_ITEM_NAMES.copper_plate,
  '강철': WORK_ITEM_NAMES.steel, '기어': WORK_ITEM_NAMES.gear, '회로': WORK_ITEM_NAMES.circuit, '엔진': WORK_ITEM_NAMES.engine,
  '원목': WORK_ITEM_NAMES.wood, '석영': WORK_ITEM_NAMES.quartz, '금광석': WORK_ITEM_NAMES.gold_ore,
  '펄프': WORK_ITEM_NAMES.pulp, '종이': WORK_ITEM_NAMES.paper, '유리': WORK_ITEM_NAMES.glass,
  '실리콘': WORK_ITEM_NAMES.silicon, '금괴': WORK_ITEM_NAMES.gold_plate, '전선': WORK_ITEM_NAMES.wire,
  '반도체': WORK_ITEM_NAMES.chip, '렌즈': WORK_ITEM_NAMES.lens, '센서': WORK_ITEM_NAMES.sensor,
  '연구장비': WORK_ITEM_NAMES.research_device, '실험데이터': WORK_ITEM_NAMES.research_data,
  '논문': WORK_ITEM_NAMES.research_paper, '석탄': WORK_ITEM_NAMES.coal,
  'OH 코어': '설계 포인트', '코어': '포인트', '환생': '리팩터링',
  '공장으로': '프로젝트로', '공장을': '프로젝트를', '공장은': '프로젝트는', '공장이': '프로젝트가', '공장과': '프로젝트와',
  '공장장': '개발자', '공장주': '개발자', '공장': '프로젝트', '플레이어': '사용자',
  '게임': '작업 공간', '플레이': '세션', '지도': '구성도', '맵': '구성도',
  '빈 대지': '빈 슬롯', '광맥': '소스 영역', '광산': '소스 풀', '광석': '소스', '원물': '원본', '광물': '소스',
  '채굴': '수집', '운반': '전달', '가공': '빌드', '제련': '컴파일', '조립': '통합',
  '생산물': '산출물', '생산': '빌드', '완성품': '아티팩트', '제품': '아티팩트', '물품': '패키지', '물건': '패키지',
  '상인': '저장소', '상점': '카탈로그', '매입': '수신', '구매': '등록', '판매가': '배포 보상', '판매': '배포',
  '골드': '크레딧', '코인': '크레딧', '자금': '예산', '재화': '예산', '수익': '처리량',
  '설계도': '명세', '레이더': '인덱스', '탐지': '탐색', '해금': '활성화',
  '벨트': '파이프', '설비': '워커', '제작법': '빌드 규칙', '레시피': '빌드 규칙',
  '도감': '명세 목록', '제작': '빌드', '건설': '배치', '강화': '최적화', '철거': '제거',
  '회차': '주기', '데모': '샌드박스',
  '₵': 'C',
};

const shortTerms = { '철': '소스', '구리': 'API', '금': '데이터', '돌': WORK_ITEM_NAMES.stone };
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const matches = Object.keys(terms).sort((a, b) => b.length - a.length).map(escape);
for (const key of Object.keys(shortTerms)) matches.push(`(?<![\\p{L}\\p{N}_])${escape(key)}(?![\\p{L}\\p{N}_])`);
const pattern = new RegExp(matches.join('|'), 'gu');

export function skinText(text, skin = 'original') {
  const value = String(text ?? '');
  if (!getSkin(typeof skin === 'string' ? skin : skin?.id).developer) return value;
  return value.replace(pattern, token => terms[token] ?? shortTerms[token] ?? token);
}
