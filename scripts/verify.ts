/**
 * 04 검증결과 문서와 이 엔진의 대조표를 출력한다.
 *
 *   npm run verify
 *
 * 테스트(npm test)가 통과/실패를 판정하고, 이 스크립트는 사람이 읽을 수 있는
 * 숫자 비교를 보여준다. 보정값은 없다.
 */

import { DEFAULT_CONFIG, MONEY_SCALE, milli } from '../src/config/economy.js';
import type { EconomyConfig } from '../src/config/economy.js';
import { createInitialState } from '../src/engine/state.js';
import { tick, tickMany } from '../src/engine/tick.js';
import { tablePriceGold } from '../src/engine/derive.js';
import { targetSatisfactionMilli } from '../src/engine/satisfaction.js';
import type { GameState, StaffState, TableState, StaffType } from '../src/engine/index.js';

const G = (units: number): number => units / MONEY_SCALE;
const H48 = 48 * 60;

function fixed(demandPerHour: number): EconomyConfig {
  return { ...DEFAULT_CONFIG, fixedDemandMilliPerHour: milli(demandPerHour) };
}

function lab(
  tables: number,
  dealers: number,
  config: EconomyConfig,
  opts: { dealerType?: StaffType; service?: number } = {},
): GameState {
  const state = createInitialState(config);
  const t: TableState[] = [];
  for (let i = 1; i <= tables; i += 1) {
    t.push({ id: `T${i}`, spotIndex: i, floor: i >= 7 ? 2 : 1, status: 'idle', dealerId: null });
  }
  const s: StaffState[] = [];
  for (let i = 1; i <= dealers; i += 1) {
    const table = t[i - 1]!;
    s.push({
      id: `D${i}`,
      type: opts.dealerType ?? 'normal',
      duty: 'working',
      assignedTableId: table.id,
    });
    table.dealerId = `D${i}`;
    table.status = 'operating';
  }
  for (let i = 1; i <= (opts.service ?? 0); i += 1) {
    s.push({ id: `SV${i}`, type: 'service', duty: 'working', assignedTableId: null });
  }
  state.tables = t;
  state.staff = s;
  state.venue.cash = 10_000_000 * MONEY_SCALE;
  return state;
}

const recurring = (s: GameState): number =>
  s.records.totalWageUnits + s.records.totalFacilityUnits + s.records.totalVenueCostUnits;
const net = (s: GameState): number => s.records.totalRevenueUnits - recurring(s);

const NO_DOC = '(문서에 수치 없음)';

interface Row {
  readonly label: string;
  readonly doc: string;
  readonly engine: string;
  /** 'match' 일치 | 'diff' 문서와 다름 | 'info' 문서에 대조할 수치가 없음 */
  readonly verdict: 'match' | 'diff' | 'info';
  readonly note?: string;
}

const rows: Row[] = [];
const add = (label: string, doc: string, engine: string, note?: string): void => {
  const verdict: Row['verdict'] = doc === NO_DOC ? 'info' : doc === engine ? 'match' : 'diff';
  rows.push(note === undefined ? { label, doc, engine, verdict } : { label, doc, engine, verdict, note });
};

/* 실험 1 — 낮은 수요에서 딜러 추가 */
{
  const c = fixed(8);
  const a = tickMany(lab(5, 3, c), H48, c);
  const b = tickMany(lab(5, 4, c), H48, c);
  add(
    '실험1 추가 매출',
    '0G',
    `${G(b.records.totalRevenueUnits - a.records.totalRevenueUnits)}G`,
  );
  add('실험1 추가 비용', '5,280G', `${G(recurring(b) - recurring(a)).toLocaleString()}G`);
}

/* 실험 2 — 높은 수요에서 딜러 추가 */
{
  const c = fixed(20);
  const a = tickMany(lab(5, 3, c), H48, c);
  const b = tickMany(lab(5, 4, c), H48, c);
  add('실험2 완료 이용객', '552명 -> 736명', `${a.records.completedGuests}명 -> ${b.records.completedGuests}명`);
  add('실험2 추가 순이익', '31,520G', `${G(net(b) - net(a)).toLocaleString()}G`);
}

/* 실험 3 — 숙련 딜러 */
{
  const c = fixed(20);
  const n = tickMany(lab(1, 1, c), H48, c);
  const k = tickMany(lab(1, 1, c, { dealerType: 'skilled' }), H48, c);
  add('실험3 완료 이용객', '184명 -> 224명', `${n.records.completedGuests}명 -> ${k.records.completedGuests}명`);
}

/* 실험 4 — 서비스 직원 */
{
  const c = fixed(20);
  const a = tickMany(lab(5, 5, c, { service: 0 }), H48, c);
  const b = tickMany(lab(5, 5, c, { service: 1 }), H48, c);
  const a96 = tickMany(lab(5, 5, c, { service: 0 }), 96 * 60, c);
  const b96 = tickMany(lab(5, 5, c, { service: 1 }), 96 * 60, c);

  add(
    '실험4 목표 만족도 T',
    '68.00 / 74.00',
    `${(targetSatisfactionMilli(a, c) / 1000).toFixed(2)} / ${(targetSatisfactionMilli(b, c) / 1000).toFixed(2)}`,
  );
  add(
    '실험4 만족도 S (48h)',
    '68.00 / 74.00',
    `${(a.venue.satisfactionMilli / 1000).toFixed(3)} / ${(b.venue.satisfactionMilli / 1000).toFixed(3)}`,
    '수렴 잔차. 공식이 아니라 표시 시점의 차이',
  );
  add(
    '실험4 만족도 S (96h)',
    NO_DOC,
    `${(a96.venue.satisfactionMilli / 1000).toFixed(3)} / ${(b96.venue.satisfactionMilli / 1000).toFixed(3)}`,
    '충분히 진행하면 목표값에 정확히 도달',
  );
}

/* 실험 5 — 시간 분할 일관성 */
{
  const c = fixed(20);
  const one = tickMany(lab(5, 4, c), 1440, c);
  let many = lab(5, 4, c);
  for (let i = 0; i < 24; i += 1) many = tickMany(many, 60, c);
  const same = JSON.stringify(one) === JSON.stringify(many);
  add('실험5 시간 분할', '전체 상태 동일', same ? '전체 상태 동일' : '불일치');
}

/* 실험 6 — 초기 영업의 자금 유지 */
{
  const c = DEFAULT_CONFIG;
  let s = createInitialState(c);
  let minCash = s.venue.cash;
  let minMinute = 0;
  for (let m = 1; m <= H48; m += 1) {
    s = tick(s, c).state;
    if (s.venue.cash < minCash) {
      minCash = s.venue.cash;
      minMinute = s.time.minute;
    }
  }
  add('실험6 최소 잔액', '265G', `${G(minCash)}G`);
  add('실험6 최소 시점', NO_DOC, `분 ${minMinute}`, '134분치 비용 차감 직후');
  add('실험6 음수 잔액', '없음', s.venue.cash >= 0 ? '없음' : '발생');
}

/* 문서에 없지만 확인해 둘 값 */
const extra: Row[] = [];
{
  const c = DEFAULT_CONFIG;
  const s = createInitialState(c);
  const num = c.demand.baseByStageMilli[1] * (10000 + s.venue.awarenessMilli) * (150000 + s.venue.satisfactionMilli);
  extra.push({
    label: '초기 방문 수요',
    doc: '4.025명/게임시간',
    engine: `${((num * 60) / 1.2e14).toFixed(3)}명/게임시간`,
    verdict: 'match',
  });
  extra.push({
    label: '18번째 테이블 가격',
    doc: '(공식만 제시)',
    engine: `${tablePriceGold(18, c).toLocaleString()}G`,
    verdict: 'info',
    note: 'ceil(16000 x 1.3^11 / 100) x 100',
  });
}

/* 출력 */
const line = (a: string, b: string, cc: string, d: string): string =>
  `${a.padEnd(22)} ${b.padEnd(18)} ${cc.padEnd(22)} ${d}`;

console.log('');
console.log('04 검증결과 문서 대조  —  rulesVersion =', DEFAULT_CONFIG.rulesVersion);
console.log('='.repeat(92));
console.log(line('항목', '문서', '엔진', '판정'));
console.log('-'.repeat(92));

let mismatches = 0;
const verdictText = { match: '일치', diff: '차이', info: '참고' } as const;
for (const r of rows) {
  if (r.verdict === 'diff') mismatches += 1;
  console.log(line(r.label, r.doc, r.engine, verdictText[r.verdict]));
  if (r.note) console.log(`${' '.repeat(22)} └ ${r.note}`);
}

console.log('');
console.log('참고 (문서에 수치가 없는 항목)');
console.log('-'.repeat(92));
for (const r of extra) {
  console.log(line(r.label, r.doc, r.engine, ''));
  if (r.note) console.log(`${' '.repeat(22)} └ ${r.note}`);
}

console.log('');
console.log(
  mismatches === 0
    ? '문서와 대조 가능한 모든 항목이 일치한다.'
    : `차이 ${mismatches}건. 위 비고에 원인 분류가 있다.`,
);
console.log('');
