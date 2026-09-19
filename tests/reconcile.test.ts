/**
 * 04 검증결과 문서와의 대조.
 *
 * 04 §1의 결과는 **비교 자료**다. 숫자를 맞추기 위한 보정값을 넣지 않는다.
 * 차이가 나면 테스트가 실패하고, 원인을 분류해 보고한다.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, gold } from '../src/config/economy.js';
import { createInitialState } from '../src/engine/state.js';
import { tick } from '../src/engine/tick.js';
import { seatedGuests } from '../src/engine/derive.js';
import {
  abandonRateMilli,
  qualityMilli,
  targetSatisfactionMilli,
} from '../src/engine/satisfaction.js';
import { G, fixedDemandConfig, labState, operatingNetUnits, recurringUnits, run } from './helpers.js';

const H48 = 48 * 60;

describe('04 §1 실험 1 — 낮은 수요에서 딜러 추가', () => {
  // 고정 수요 8명/시간, 5테이블, 딜러 3명 대 4명, 48게임시간
  const config = fixedDemandConfig(8);

  it('추가 매출이 0G이다', () => {
    const three = run(labState({ tables: 5, dealers: 3 }, config), H48, config);
    const four = run(labState({ tables: 5, dealers: 4 }, config), H48, config);
    expect(four.records.totalRevenueUnits - three.records.totalRevenueUnits).toBe(0);
  });

  it('추가 비용이 정확히 5,280G이다', () => {
    const three = run(labState({ tables: 5, dealers: 3 }, config), H48, config);
    const four = run(labState({ tables: 5, dealers: 4 }, config), H48, config);
    const delta = recurringUnits(four) - recurringUnits(three);
    // 급여 80G/h x 48h = 3,840G + 4번째 테이블 시설비 30G/h x 48h = 1,440G
    expect(G(delta)).toBe(5280);
  });

  it('수요가 능력보다 낮으므로 완료 이용객이 같다', () => {
    const three = run(labState({ tables: 5, dealers: 3 }, config), H48, config);
    const four = run(labState({ tables: 5, dealers: 4 }, config), H48, config);
    expect(four.records.completedGuests).toBe(three.records.completedGuests);
  });
});

describe('04 §1 실험 2 — 높은 수요에서 딜러 추가', () => {
  // 고정 수요 20명/시간, 5테이블, 딜러 3명 대 4명, 48게임시간
  const config = fixedDemandConfig(20);

  it('완료 이용객이 552명 -> 736명이다', () => {
    const three = run(labState({ tables: 5, dealers: 3 }, config), H48, config);
    const four = run(labState({ tables: 5, dealers: 4 }, config), H48, config);
    expect(three.records.completedGuests).toBe(552);
    expect(four.records.completedGuests).toBe(736);
  });

  it('추가 순이익이 정확히 31,520G이다', () => {
    const three = run(labState({ tables: 5, dealers: 3 }, config), H48, config);
    const four = run(labState({ tables: 5, dealers: 4 }, config), H48, config);
    const delta = operatingNetUnits(four) - operatingNetUnits(three);
    // (736-552) x 200G - 3,840G - 1,440G
    expect(G(delta)).toBe(31_520);
  });
});

describe('04 §1 실험 3 — 숙련 딜러 효과', () => {
  // 1테이블, 고정 수요 20명/시간, 48게임시간, 속도 1.0 대 1.2
  const config = fixedDemandConfig(20);

  it('완료 이용객이 184명 -> 224명이다', () => {
    const normal = run(labState({ tables: 1, dealers: 1, dealerType: 'normal' }, config), H48, config);
    const skilled = run(
      labState({ tables: 1, dealers: 1, dealerType: 'skilled' }, config),
      H48,
      config,
    );
    expect(normal.records.completedGuests).toBe(184);
    expect(skilled.records.completedGuests).toBe(224);
  });

  it('처리량 실험이며 급여를 포함한 경제성 비교가 아니다 — 급여 차이를 확인해 둔다', () => {
    const normal = run(labState({ tables: 1, dealers: 1, dealerType: 'normal' }, config), H48, config);
    const skilled = run(
      labState({ tables: 1, dealers: 1, dealerType: 'skilled' }, config),
      H48,
      config,
    );
    // 04 §1이 명시한 한계: 숙련 딜러 실험은 처리량만 검증했다.
    expect(G(skilled.records.totalWageUnits - normal.records.totalWageUnits)).toBe(30 * 48);
  });
});

describe('04 §1 실험 4 — 서비스 직원 효과', () => {
  // 5테이블·5딜러, 고정 수요 20명/시간, 48게임시간
  const config = fixedDemandConfig(20);

  it('목표 만족도 T가 정확히 68.000 / 74.000이다', () => {
    // 문서와 대조할 핵심은 공식이 만드는 목표값이다.
    const none = run(labState({ tables: 5, dealers: 5, serviceStaff: 0 }, config), H48, config);
    const one = run(labState({ tables: 5, dealers: 5, serviceStaff: 1 }, config), H48, config);

    expect(targetSatisfactionMilli(none, config)).toBe(68_000);
    expect(targetSatisfactionMilli(one, config)).toBe(74_000);

    // 중간 항도 문서와 일치하는지 확인한다.
    expect(seatedGuests(none)).toBe(40); // O = 만석
    expect(qualityMilli(none, config)).toBe(20_000); // Q = 100 x 8/40 = 20
    expect(qualityMilli(one, config)).toBe(60_000); // Q = 100 x 24/40 = 60
    expect(abandonRateMilli(none)).toBe(0); // 수요 20 = 능력 20, 이탈 없음
  });

  it('충분히 진행하면 정확히 68.000 / 74.000으로 수렴한다', () => {
    const none = run(labState({ tables: 5, dealers: 5, serviceStaff: 0 }, config), 96 * 60, config);
    const one = run(labState({ tables: 5, dealers: 5, serviceStaff: 1 }, config), 96 * 60, config);
    expect(none.venue.satisfactionMilli).toBe(68_000);
    expect(one.venue.satisfactionMilli).toBe(74_000);
  });

  it('48게임시간 시점의 값은 수렴 잔차가 남는다 — 문서와의 차이를 고정해 둔다', () => {
    // 문서는 48게임시간 시점을 "68.00 / 74.00"으로 적었다.
    // 이 엔진의 같은 시점 값은 68.005 / 74.003이다.
    //
    // 원인: 공식 차이가 아니라 감쇠의 수렴 잔차다.
    //   - 목표 T는 위 테스트대로 정확히 68.000 / 74.000이다.
    //   - 초기 120분 동안 좌석이 차는 램프 구간에서는 O < 40이라 T가 68보다 높다.
    //     그만큼 수렴이 늦어져 48시간 시점에 5 milli(0.005)가 남는다.
    //   - 96게임시간이면 정확히 68.000에 닿는다.
    //
    // 따라서 이 차이는 구현 오류가 아니라 표시 자릿수·수렴 잔차의 차이다.
    // 보정값을 넣어 68.000을 만들지 않는다.
    const none = run(labState({ tables: 5, dealers: 5, serviceStaff: 0 }, config), H48, config);
    const one = run(labState({ tables: 5, dealers: 5, serviceStaff: 1 }, config), H48, config);

    expect(none.venue.satisfactionMilli).toBe(68_005);
    expect(one.venue.satisfactionMilli).toBe(74_003);

    // 문서 값과의 차이가 0.01 미만임을 명시적으로 확인한다.
    expect(Math.abs(none.venue.satisfactionMilli - 68_000)).toBeLessThan(10);
    expect(Math.abs(one.venue.satisfactionMilli - 74_000)).toBeLessThan(10);
  });

  it('서비스 직원은 처리량이 아니라 만족도만 바꾼다', () => {
    const none = run(labState({ tables: 5, dealers: 5, serviceStaff: 0 }, config), H48, config);
    const one = run(labState({ tables: 5, dealers: 5, serviceStaff: 1 }, config), H48, config);
    expect(one.records.completedGuests).toBe(none.records.completedGuests);
    expect(none.records.completedGuests).toBe(920);
  });
});

describe('04 §1 실험 5 — 시간 분할 일관성', () => {
  const config = fixedDemandConfig(20);

  it('1,440분 1회와 60분씩 24회의 상태 전체가 같다', () => {
    const a = run(labState({ tables: 5, dealers: 4 }, config), 1440, config);

    let b = labState({ tables: 5, dealers: 4 }, config);
    for (let i = 0; i < 24; i += 1) b = run(b, 60, config);

    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('기본 설정(수요 피드백 있음)에서도 같다', () => {
    const c = DEFAULT_CONFIG;
    const a = run(createInitialState(c), 1440, c);

    let b = createInitialState(c);
    for (let i = 0; i < 24; i += 1) b = run(b, 60, c);

    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

describe('04 §1 실험 6 — 초기 영업의 자금 유지', () => {
  const config = DEFAULT_CONFIG;

  it('최소 잔액이 정확히 265G이고, 분 134에 나타난다', () => {
    // 근사치 비교가 아니라 처리 순서로 검증한다 (05 §8).
    let state = createInitialState(config);
    let minCash = state.venue.cash;
    let minMinute = 0;

    for (let m = 1; m <= 48 * 60; m += 1) {
      state = tick(state, config).state;
      if (state.venue.cash < minCash) {
        minCash = state.venue.cash;
        minMinute = state.time.minute;
      }
    }

    expect(G(minCash)).toBe(265);
    expect(minMinute).toBe(134);
  });

  it('분 134와 분 135의 값이 처리 순서에서 유도된다', () => {
    let state = createInitialState(config);
    const perMinuteCost = 80 + 30 + 40; // 급여 + 시설비 + 매장비 = 150 units/분

    state = run(state, 134, config);
    expect(G(state.venue.cash)).toBe(600 - (perMinuteCost * 134) / 60);
    expect(G(state.venue.cash)).toBe(265);
    expect(state.records.completedGuests).toBe(0); // 아직 첫 정산 전

    state = tick(state, config).state; // 분 135
    expect(state.records.completedGuests).toBe(1);
    // 4단계에서 +200G 정산 후 8단계에서 -2.5G 차감
    expect(G(state.venue.cash)).toBe(265 + 200 - 150 / 60);
    expect(G(state.venue.cash)).toBe(462.5);
  });

  it('48게임시간 동안 음수 잔액이 없다', () => {
    let state = createInitialState(config);
    for (let m = 1; m <= 48 * 60; m += 1) {
      state = tick(state, config).state;
      expect(state.venue.cash).toBeGreaterThanOrEqual(0);
    }
  });

  it('첫 세션은 분 15에 착석해 분 135에 완료된다', () => {
    let state = createInitialState(config);
    state = run(state, 15, config);
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]?.startedAtMinute).toBe(15);
    expect(state.sessions[0]?.endsAtMinute).toBe(135);
    expect(state.sessions[0]?.revenueUnits).toBe(gold(200));
  });
});
