/**
 * 숫자 표현과 정밀도 (05 채택기록 v1 §4).
 *
 * 검증 항목:
 *   - 금액 연산의 정수성과 안전 범위
 *   - 만족도의 작은 변화가 반올림으로 사라지지 않음
 *   - 방문 수요 누적값의 나머지 보존
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, MONEY_SCALE, gold, milli } from '../src/config/economy.js';
import { ARRIVAL_DEN, arrivalNumerator, stepArrivals } from '../src/engine/demand.js';
import { perMinuteUnits } from '../src/engine/costs.js';
import { divRem } from '../src/engine/fixed.js';
import { SAT_K_DEN, SAT_K_NUM, stepSatisfaction } from '../src/engine/satisfaction.js';
import { createInitialState } from '../src/engine/state.js';
import { tablePriceGold } from '../src/engine/derive.js';
import { labState, run } from './helpers.js';

describe('화폐 단위 — 1G = 60 units', () => {
  it('MONEY_SCALE이 60이어야 분당 비용 항등식이 성립한다', () => {
    expect(MONEY_SCALE).toBe(60);
  });

  it('시간당 비용 G가 그대로 분당 units가 된다', () => {
    // 05 §4-1의 핵심 항등식
    expect(perMinuteUnits(80)).toBe(80); // 일반 딜러 급여
    expect(perMinuteUnits(110)).toBe(110); // 숙련 딜러
    expect(perMinuteUnits(100)).toBe(100); // 대회 전문 딜러
    expect(perMinuteUnits(60)).toBe(60); // 서비스 직원
    expect(perMinuteUnits(30)).toBe(30); // 테이블 시설비
    expect(perMinuteUnits(40)).toBe(40); // 매장 운영비
  });

  it('설정의 모든 시간당 비용이 이 항등식을 만족한다', () => {
    const c = DEFAULT_CONFIG;
    const rates = [
      ...Object.values(c.staff).map((s) => s.wagePerHourGold),
      c.table.facilityCostPerHourGold,
      c.venue.baseCostPerHourGold,
    ];
    for (const rate of rates) {
      expect(() => perMinuteUnits(rate)).not.toThrow();
    }
  });

  it('세션 매출이 정수 units로 떨어진다', () => {
    expect(gold(200)).toBe(12_000);
  });

  it('비정수 금액은 즉시 예외를 던진다', () => {
    expect(() => gold(0.001)).toThrow();
  });

  it('가장 비싼 항목도 안전 정수 범위 안에 있다', () => {
    // Progression §3 공식: ceil(16000 x 1.3^(n-7) / 100) x 100
    expect(tablePriceGold(8, DEFAULT_CONFIG)).toBe(20_800);
    expect(tablePriceGold(18, DEFAULT_CONFIG)).toBe(286_800);
    const maxUnits = gold(tablePriceGold(18, DEFAULT_CONFIG));
    expect(maxUnits).toBe(17_208_000);
    expect(Number.isSafeInteger(maxUnits)).toBe(true);
    // 안전 정수 대비 여유 배수
    expect(Number.MAX_SAFE_INTEGER / maxUnits).toBeGreaterThan(1e8);
  });

  it('표에 있는 1~7번째 가격이 Progression §3과 일치한다', () => {
    const expected = [0, 0, 1200, 2400, 4200, 7000, 11000, 16000];
    for (let i = 2; i <= 7; i += 1) {
      expect(tablePriceGold(i, DEFAULT_CONFIG)).toBe(expected[i]);
    }
  });
});

describe('방문 수요 — 정수 분수와 나머지 보존 (05 §4-3)', () => {
  it('초기 수요가 정확히 4.025명/게임시간이다', () => {
    const state = createInitialState();
    const num = arrivalNumerator(state, DEFAULT_CONFIG);
    expect(num).toBe(3500 * 10000 * 230000); // 8.05e12
    // 시간당 = 분당 x 60
    expect((num * 60) / ARRIVAL_DEN).toBeCloseTo(4.025, 10);
  });

  it('분모가 문서의 유도와 같다', () => {
    expect(ARRIVAL_DEN).toBe(1.2e14);
  });

  it('나머지가 항상 [0, DEN) 이고 quotient*DEN+rem === total 이다', () => {
    const state = createInitialState();
    let carry = 0;
    for (let i = 0; i < 1000; i += 1) {
      state.time.arrivalCarry = carry;
      const num = arrivalNumerator(state, DEFAULT_CONFIG);
      const total = num + carry;
      const step = stepArrivals(state, DEFAULT_CONFIG);
      expect(step.carry).toBeGreaterThanOrEqual(0);
      expect(step.carry).toBeLessThan(ARRIVAL_DEN);
      expect(step.newGuests * ARRIVAL_DEN + step.carry).toBe(total);
      carry = step.carry;
    }
  });

  it('첫 손님이 정확히 15분째에 도착한다', () => {
    // 1.2e14 / 8.05e12 = 14.907 -> 15
    const state = createInitialState();
    let firstArrival = -1;
    for (let m = 1; m <= 30; m += 1) {
      const step = stepArrivals(state, DEFAULT_CONFIG);
      state.time.arrivalCarry = step.carry;
      state.time.minute = m;
      if (step.newGuests > 0 && firstArrival === -1) firstArrival = m;
    }
    expect(firstArrival).toBe(15);
  });

  it('누적값이 보존되므로 분할 계산과 연속 계산이 같다', () => {
    const state = createInitialState();
    let carry = 0;
    let total = 0;
    for (let i = 0; i < 600; i += 1) {
      state.time.arrivalCarry = carry;
      const step = stepArrivals(state, DEFAULT_CONFIG);
      carry = step.carry;
      total += step.newGuests;
    }
    // 600분 = 10게임시간, 4.025명/시간 -> 40.25명 -> 정수부 40명
    expect(total).toBe(40);
    // 남은 0.25명분이 carry에 살아 있다
    expect(carry).toBeGreaterThan(0);
  });
});

describe('만족도 — 반올림으로 버리지 않는다 (05 §4-2)', () => {
  it('감쇠 상수가 1 - exp(-1/360)과 1e-9 자리까지 일치한다', () => {
    const exact = 1 - Math.exp(-1 / 360);
    expect(SAT_K_NUM / SAT_K_DEN).toBeCloseTo(exact, 9);
  });

  it('한 분의 변화량이 1 milli 미만이어도 나머지에 누적된다', () => {
    // 목표와 1 milli 차이 -> 한 분 변화량 = 0.0000027 milli. 몫은 0이 된다.
    const config = DEFAULT_CONFIG;
    const state = labState({ tables: 1, dealers: 1 }, config);
    state.venue.satisfactionMilli = milli(80);
    state.venue.satisfactionRemainder = 0;

    const step = stepSatisfaction(state, config);
    // 목표가 80.000이면 차이 0이므로 변화도 0
    expect(step.satisfactionMilli).toBe(milli(80));

    // 인위적으로 목표와 벌린 뒤, 몫이 0이어도 나머지가 쌓이는지 확인한다
    state.venue.satisfactionMilli = milli(80) - 1; // 79.999
    const s2 = stepSatisfaction(state, config);
    expect(s2.satisfactionMilli - state.venue.satisfactionMilli).toBe(0); // 몫 0
    expect(s2.remainder).toBeGreaterThan(0); // 그러나 버리지 않았다
  });

  it('작은 변화가 누적되어 결국 만족도를 움직인다', () => {
    const config = DEFAULT_CONFIG;
    const state = labState({ tables: 1, dealers: 1 }, config);
    state.venue.satisfactionMilli = milli(80) - 1;
    state.venue.satisfactionRemainder = 0;

    // 몫이 0인 상태로 반복해도 나머지가 쌓여 언젠가 1 milli가 움직인다
    let moved = false;
    let cur = state.venue.satisfactionMilli;
    for (let i = 0; i < 1000; i += 1) {
      const s = stepSatisfaction(state, config);
      state.venue.satisfactionRemainder = s.remainder;
      if (s.satisfactionMilli !== cur) {
        moved = true;
        break;
      }
      cur = s.satisfactionMilli;
      state.venue.satisfactionMilli = s.satisfactionMilli;
    }
    expect(moved).toBe(true);
  });

  it('반올림으로 버렸다면 도달하지 못할 값까지 수렴한다', () => {
    // 나머지를 버리는 구현이면 목표 근처에서 멈춰 68.000에 닿지 못한다.
    const config = { ...DEFAULT_CONFIG, fixedDemandMilliPerHour: milli(20) };
    const end = run(labState({ tables: 5, dealers: 5 }, config), 48 * 60, config);
    // 48게임시간 = 8 시상수. 80 -> 68 로 e^-8 만큼 남는다.
    expect(end.venue.satisfactionMilli).toBeGreaterThanOrEqual(68_000);
    expect(end.venue.satisfactionMilli).toBeLessThanOrEqual(68_010);
  });

  it('나머지는 항상 [0, SAT_K_DEN) 이다 — 음수 변화에서도', () => {
    const { quotient, remainder } = divRem(-12_000 * SAT_K_NUM, SAT_K_DEN);
    expect(remainder).toBeGreaterThanOrEqual(0);
    expect(remainder).toBeLessThan(SAT_K_DEN);
    expect(quotient * SAT_K_DEN + remainder).toBe(-12_000 * SAT_K_NUM);
  });
});
