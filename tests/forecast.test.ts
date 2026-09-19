/**
 * 투자 전후 예상치 (Economy §9).
 *
 * 사용자 지정 확인 항목:
 *   - 수요가 낮을 때와 높을 때 추가 딜러의 투자 효과가 달라짐
 *   - 예상치는 원본을 변경하지 않고 같은 경제 엔진을 사용함
 *   - 미구현 상태를 만나면 명시적인 미지원 결과를 반환함
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, gold, milli } from '../src/config/economy.js';
import { applyCommand, validateCommand } from '../src/engine/commands.js';
import { DEFAULT_HORIZON_MINUTES, forecast } from '../src/engine/forecast.js';
import { createInitialState, serialize } from '../src/engine/state.js';
import { tick } from '../src/engine/tick.js';
import { G, fixedDemandConfig, labState, run } from './helpers.js';

/** 대기 딜러를 1명 붙여, buyTable이 곧 "테이블+딜러 추가"가 되게 한다 */
function withSpareDealer(state: ReturnType<typeof labState>) {
  state.staff.push({ id: 'SPARE', type: 'normal', duty: 'standby', assignedTableId: null });
  return state;
}

describe('원본 상태를 변경하지 않는다', () => {
  const config = DEFAULT_CONFIG;

  it('forecast 호출 전후로 원본이 완전히 같다', () => {
    const state = run(createInitialState(config), 500, config);
    const before = serialize(state);

    const result = forecast(state, { type: 'hireDealer' }, config);
    expect(result.supported).toBe(true);
    expect(serialize(state)).toBe(before);
  });

  it('거절되는 명령에 대해서도 원본이 같다', () => {
    const state = createInitialState(config);
    const before = serialize(state);
    const result = forecast(state, { type: 'buyTable' }, config);
    expect(result.supported).toBe(false);
    expect(serialize(state)).toBe(before);
  });

  it('예상치를 두 번 계산해도 같은 결과가 나온다', () => {
    const state = run(createInitialState(config), 500, config);
    const a = forecast(state, { type: 'hireDealer' }, config);
    const b = forecast(state, { type: 'hireDealer' }, config);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('예측과 실제가 같은 엔진을 쓴다 (GDD §5, §10)', () => {
  const config = DEFAULT_CONFIG;

  it("'투자 안 함' 예측이 실제 진행 결과와 정확히 일치한다", () => {
    const state = run(createInitialState(config), 500, config);
    const result = forecast(state, { type: 'hireDealer' }, config);
    if (!result.supported) throw new Error('지원되는 상태여야 한다');

    // 같은 상태를 실제로 24게임시간 진행해 본다
    const actual = run(state, DEFAULT_HORIZON_MINUTES, config);
    const actualRevenue = actual.records.totalRevenueUnits - state.records.totalRevenueUnits;
    const actualGuests = actual.records.completedGuests - state.records.completedGuests;

    expect(result.baseline.revenueUnits).toBe(actualRevenue);
    expect(result.baseline.completedGuests).toBe(actualGuests);
    expect(result.baseline.endCashUnits).toBe(actual.venue.cash);
  });

  it("'투자함' 예측도 실제 진행 결과와 일치한다", () => {
    const state = run(createInitialState(config), 500, config);
    const result = forecast(state, { type: 'hireDealer' }, config);
    if (!result.supported) throw new Error('지원되는 상태여야 한다');

    let actual = tick(state, config, [{ type: 'hireDealer' }]).state;
    actual = run(actual, DEFAULT_HORIZON_MINUTES - 1, config);

    expect(result.invested.endCashUnits).toBe(actual.venue.cash);
    expect(result.invested.completedGuests).toBe(
      actual.records.completedGuests - state.records.completedGuests,
    );
  });
});

describe('수요가 낮을 때 — P04', () => {
  // 고정 수요 8명/시간, 3테이블·3딜러(능력 12명/시간). 테이블 1개가 놀고 있다.
  const config = fixedDemandConfig(8);

  it('추가 딜러 투자는 매출을 늘리지 못하고 비용만 는다', () => {
    const state = withSpareDealer(labState({ tables: 4, dealers: 3, cashGold: 50_000 }, config));
    const result = forecast(
      state,
      { type: 'assignDealer', tableId: 'T4', staffId: 'SPARE' },
      config,
    );
    if (!result.supported) throw new Error('지원되는 상태여야 한다');

    expect(result.deltaRevenueUnits).toBe(0);
    expect(result.deltaCompletedGuests).toBe(0);
    expect(result.deltaRecurringCostUnits).toBeGreaterThan(0);
    expect(result.deltaOperatingNetUnits).toBeLessThan(0);
  });

  it('추가 순이익이 음수이므로 회수 시간을 지어내지 않는다', () => {
    const state = withSpareDealer(labState({ tables: 4, dealers: 3, cashGold: 50_000 }, config));
    const result = forecast(
      state,
      { type: 'assignDealer', tableId: 'T4', staffId: 'SPARE' },
      config,
    );
    if (!result.supported) throw new Error('지원되는 상태여야 한다');
    expect(result.paybackMinutes).toBe(null);
  });

  it('24게임시간 추가 비용이 급여+시설비와 맞는다', () => {
    const state = withSpareDealer(labState({ tables: 4, dealers: 3, cashGold: 50_000 }, config));
    const result = forecast(
      state,
      { type: 'assignDealer', tableId: 'T4', staffId: 'SPARE' },
      config,
    );
    if (!result.supported) throw new Error('지원되는 상태여야 한다');
    // (80 + 30) G/시간 x 24시간 = 2,640G
    expect(G(result.deltaRecurringCostUnits)).toBe(2640);
  });
});

describe('수요가 높을 때 — P03', () => {
  // 고정 수요 20명/시간, 3테이블·3딜러(능력 12명/시간). 수요가 능력을 넘는다.
  const config = fixedDemandConfig(20);

  it('추가 딜러 투자가 완료 이용객과 순이익을 늘린다', () => {
    const state = withSpareDealer(labState({ tables: 4, dealers: 3, cashGold: 50_000 }, config));
    const result = forecast(
      state,
      { type: 'assignDealer', tableId: 'T4', staffId: 'SPARE' },
      config,
    );
    if (!result.supported) throw new Error('지원되는 상태여야 한다');

    expect(result.deltaCompletedGuests).toBeGreaterThan(0);
    expect(result.deltaRevenueUnits).toBeGreaterThan(0);
    expect(result.deltaOperatingNetUnits).toBeGreaterThan(0);
  });

  it('같은 투자가 수요에 따라 정반대 결론을 낸다', () => {
    const low = fixedDemandConfig(8);
    const high = fixedDemandConfig(20);
    const cmd = { type: 'assignDealer', tableId: 'T4', staffId: 'SPARE' } as const;

    const lowResult = forecast(
      withSpareDealer(labState({ tables: 4, dealers: 3, cashGold: 50_000 }, low)),
      cmd,
      low,
    );
    const highResult = forecast(
      withSpareDealer(labState({ tables: 4, dealers: 3, cashGold: 50_000 }, high)),
      cmd,
      high,
    );
    if (!lowResult.supported || !highResult.supported) throw new Error('지원되는 상태여야 한다');

    expect(lowResult.deltaOperatingNetUnits).toBeLessThan(0);
    expect(highResult.deltaOperatingNetUnits).toBeGreaterThan(0);
  });

  it('즉시 바뀌는 운영 테이블과 이론 처리 능력을 보고한다', () => {
    const state = withSpareDealer(labState({ tables: 4, dealers: 3, cashGold: 50_000 }, config));
    const result = forecast(
      state,
      { type: 'assignDealer', tableId: 'T4', staffId: 'SPARE' },
      config,
    );
    if (!result.supported) throw new Error('지원되는 상태여야 한다');

    expect(result.immediateBefore.operatingTables).toBe(3);
    expect(result.immediateAfter.operatingTables).toBe(4);
    expect(result.immediateBefore.theoreticalCapacityMilli).toBe(milli(12));
    expect(result.immediateAfter.theoreticalCapacityMilli).toBe(milli(16));
  });
});

describe('일회성 투자 비용과 반복 비용을 구분한다 (Economy §9)', () => {
  const config = fixedDemandConfig(20);

  it('테이블 구매 비용은 investmentCostUnits로, 급여는 반복 비용으로 잡힌다', () => {
    const state = withSpareDealer(labState({ tables: 1, dealers: 1, cashGold: 50_000 }, config));
    const result = forecast(state, { type: 'buyTable' }, config);
    if (!result.supported) throw new Error('지원되는 상태여야 한다');

    // 2번째 테이블 = 1,200G (Progression §3)
    expect(G(result.investmentCostUnits)).toBe(1200);
    // 추가 반복 비용은 급여 80 + 시설비 30 = 110G/시간 x 24시간
    expect(G(result.deltaRecurringCostUnits)).toBe(110 * 24);
    // 추가 순이익에는 구매 비용이 들어가지 않는다
    expect(result.deltaOperatingNetUnits).toBe(
      result.deltaRevenueUnits - result.deltaRecurringCostUnits,
    );
  });

  it('투자 후 현금이 구매 비용만큼 줄어든 값으로 보고된다', () => {
    const state = withSpareDealer(labState({ tables: 1, dealers: 1, cashGold: 50_000 }, config));
    const result = forecast(state, { type: 'buyTable' }, config);
    if (!result.supported) throw new Error('지원되는 상태여야 한다');

    // 투자 직후에는 1분치 운영비가 아직 차감되지 않아야 한다.
    const spent = result.immediateBefore.cashUnits - result.immediateAfter.cashUnits;
    expect(spent).toBe(gold(1200));
  });

  it('회수 시간은 추가 순이익이 양수일 때만 나온다', () => {
    const state = withSpareDealer(labState({ tables: 1, dealers: 1, cashGold: 50_000 }, config));
    const result = forecast(state, { type: 'buyTable' }, config);
    if (!result.supported) throw new Error('지원되는 상태여야 한다');
    expect(result.deltaOperatingNetUnits).toBeGreaterThan(0);
    expect(result.paybackMinutes).not.toBe(null);
    expect(result.paybackMinutes!).toBeGreaterThan(0);
  });
});

describe('효과 발생 지연 이유를 보고한다 (Economy §9)', () => {
  const config = fixedDemandConfig(20);

  it('딜러 없는 테이블이 생기면 그 사실을 알린다', () => {
    // 대기 딜러가 없는 상태에서 테이블을 사면 미운영 상태가 된다
    const state = labState({ tables: 1, dealers: 1, cashGold: 50_000 }, config);
    const result = forecast(state, { type: 'buyTable' }, config);
    if (!result.supported) throw new Error('지원되는 상태여야 한다');

    expect(result.delays).toContain('TABLE_WITHOUT_DEALER');
    // 허위 처리 능력 증가가 없다 (P02)
    expect(result.immediateAfter.theoreticalCapacityMilli).toBe(
      result.immediateBefore.theoreticalCapacityMilli,
    );
    expect(result.deltaRevenueUnits).toBe(0);
  });

  it('딜러 교체가 예약되면 지연 이유로 보고한다', () => {
    const state = labState({ tables: 1, dealers: 1, cashGold: 50_000 }, config);
    state.staff.push({ id: 'SK', type: 'skilled', duty: 'standby', assignedTableId: null });
    // 진행 중 세션을 만든다
    const seeded = run(state, 30, config);

    const result = forecast(seeded, { type: 'assignDealer', tableId: 'T1', staffId: 'SK' }, config);
    if (!result.supported) throw new Error('지원되는 상태여야 한다');
    expect(result.delays).toContain('DEALER_CHANGE_PENDING');
  });
});

describe('미구현 상태는 명시적 미지원으로 돌려준다 (사용자 요구 7)', () => {
  const config = DEFAULT_CONFIG;

  it('대회 상태를 만나면 완성된 24시간 예측을 만들지 않는다', () => {
    const state = run(createInitialState(config), 300, config);
    (state as { tournament: unknown }).tournament = { id: 'TN1' };

    const result = forecast(state, { type: 'hireDealer' }, config);
    expect(result.supported).toBe(false);
    if (result.supported) throw new Error('unreachable');
    expect(result.code).toBe('TOURNAMENT_NOT_IMPLEMENTED');
    expect(result.detail).toMatch(/작업 B/);
  });

  it('리모델링 상태도 마찬가지다', () => {
    const state = run(createInitialState(config), 300, config);
    (state as { remodel: unknown }).remodel = { id: 'RM1' };
    const result = forecast(state, { type: 'hireDealer' }, config);
    expect(result.supported).toBe(false);
    if (result.supported) throw new Error('unreachable');
    expect(result.code).toBe('REMODEL_NOT_IMPLEMENTED');
  });

  it('예측 기간에 현금이 음수가 되면 긴급 운영 미구현을 알린다', () => {
    // 수요 0 + 직원 다수 = 비용만 나가는 구성
    const broke = fixedDemandConfig(0);
    // 고용 자체는 가능하지만(400G <= 500G) 이후 비용으로 현금이 마른다
    const state = labState({ tables: 5, dealers: 5, cashGold: 500 }, broke);

    const result = forecast(state, { type: 'hireDealer' }, broke);
    expect(result.supported).toBe(false);
    if (result.supported) throw new Error('unreachable');
    expect(result.code).toBe('CASH_WENT_NEGATIVE');
    expect(result.detail).toMatch(/긴급 축소 운영/);
  });

  it('명령 자체가 거절되면 사유를 함께 돌려준다', () => {
    const state = createInitialState(config);
    const result = forecast(state, { type: 'upgradeAmenity' }, config);
    expect(result.supported).toBe(false);
    if (result.supported) throw new Error('unreachable');
    expect(result.code).toBe('COMMAND_REJECTED');
    expect(result.reason).toBe('AMENITY_LOCKED');
  });
});


describe('투자 예상치 경계 시점과 첫 1분 안전성 회귀 검증', () => {
  const config = fixedDemandConfig(20);

  it('투자 직후 현금은 구매 비용만 차감하며 아직 1분 영업 결과를 포함하지 않는다', () => {
    const state = withSpareDealer(labState({ tables: 1, dealers: 1, cashGold: 50_000 }, config));
    const before = serialize(state);
    const command = { type: 'buyTable' } as const;
    const result = forecast(state, command, config, 2);
    if (!result.supported) throw new Error('지원되는 상태여야 한다');

    expect(result.immediateBefore.cashUnits).toBe(state.venue.cash);
    expect(result.immediateAfter.cashUnits).toBe(state.venue.cash - gold(1200));
    expect(result.immediateAfter.availableCashUnits).toBe(state.venue.cash - gold(1200));
    expect(result.immediateAfter.operatingTables).toBe(2);

    const afterOneMinute = tick(state, config, [command]).state;
    expect(afterOneMinute.venue.cash).toBeLessThan(result.immediateAfter.cashUnits);
    expect(serialize(state)).toBe(before);
  });

  it('첫 틱에서만 잔액이 음수이고 다음 틱에 매출로 회복되어도 예측을 거부한다', () => {
    // 고정 수요 20: 최초 방문이 분 3, 최초 세션 완료가 분 123이다.
    // 분 121 시점에 테이블 구매비만 남겨 분 122에 일시적으로 적자가 나게 한다.
    let state = run(labState({ tables: 1, dealers: 1, cashGold: 50_000 }, config), 121, config);
    state = withSpareDealer(state);
    state.venue.cash = gold(1200);

    const command = { type: 'buyTable' } as const;
    const first = tick(state, config, [command]);
    expect(first.events.some((event) => event.type === 'cashNegative')).toBe(true);
    const second = tick(first.state, config);
    expect(second.state.venue.cash).toBeGreaterThanOrEqual(0);

    const result = forecast(state, command, config, 2);
    expect(result.supported).toBe(false);
    if (result.supported) throw new Error('현금 부족 시 예측을 지원하면 안 된다');
    expect(result.code).toBe('CASH_WENT_NEGATIVE');
  });

  it('0분 또는 소수 분 지평으로 예상치를 생성하지 않는다', () => {
    const state = labState({ tables: 1, dealers: 1, cashGold: 50_000 }, config);
    expect(() => forecast(state, { type: 'hireDealer' }, config, 0)).toThrow(RangeError);
    expect(() => forecast(state, { type: 'hireDealer' }, config, 1.5)).toThrow(RangeError);
  });
});

describe('대회 예약 명령의 예상치는 지어내지 않는다 (B-1 회귀)', () => {
  const config = fixedDemandConfig(20);

  /** 소규모 대회를 예약할 수 있는 최소 조건을 갖춘 상태 */
  function reservable(cashGold = 50_000) {
    const state = labState({ tables: 4, dealers: 4, cashGold }, config);
    state.venue.awarenessMilli = milli(10); // 해금 문턱
    return run(state, 1, config); // 해금 기록을 엔진이 부여하게 한다
  }

  const RESERVE = { type: 'reserveSmallTournament', tableIds: ['T1', 'T2'] } as const;

  it('1. 유효한 예약 명령은 supported: true를 돌려주지 않는다', () => {
    const state = reservable();
    // 명령 자체는 유효하다 — 거절이 아니라 미지원이어야 한다는 점이 핵심이다
    expect(validateCommand(state, RESERVE, config).ok).toBe(true);

    const result = forecast(state, RESERVE, config);
    expect(result.supported).toBe(false);
    if (result.supported) throw new Error('unreachable');
    expect(result.code).toBe('TOURNAMENT_NOT_IMPLEMENTED');
    expect(result.detail).toMatch(/B-2/);
  });

  it('2. 유효하지 않은 예약 명령은 여전히 COMMAND_REJECTED다', () => {
    // 해금 전
    const locked = labState({ tables: 4, dealers: 4, cashGold: 50_000 }, config);
    const lockedResult = forecast(locked, RESERVE, config);
    expect(lockedResult.supported).toBe(false);
    if (lockedResult.supported) throw new Error('unreachable');
    expect(lockedResult.code).toBe('COMMAND_REJECTED');
    expect(lockedResult.reason).toBe('TOURNAMENT_LOCKED');

    // 테이블 ID 중복
    const dup = forecast(
      reservable(),
      { type: 'reserveSmallTournament', tableIds: ['T1', 'T1'] },
      config,
    );
    expect(dup.supported).toBe(false);
    if (dup.supported) throw new Error('unreachable');
    expect(dup.code).toBe('COMMAND_REJECTED');
    expect(dup.reason).toBe('TOURNAMENT_TABLE_DUPLICATE');

    // 준비비 부족
    const poor = forecast(reservable(100), RESERVE, config);
    expect(poor.supported).toBe(false);
    if (poor.supported) throw new Error('unreachable');
    expect(poor.code).toBe('COMMAND_REJECTED');
    expect(poor.reason).toBe('INSUFFICIENT_CASH');
  });

  it('3. 두 경우 모두 원본 직렬화 상태를 그대로 둔다', () => {
    const valid = reservable();
    const validBefore = serialize(valid);
    forecast(valid, RESERVE, config);
    expect(serialize(valid)).toBe(validBefore);

    const invalid = reservable(100);
    const invalidBefore = serialize(invalid);
    forecast(invalid, RESERVE, config);
    expect(serialize(invalid)).toBe(invalidBefore);
  });

  it('예약이 적용된 뒤의 24시간을 계산해 버리지 않는다', () => {
    // 같은 상태에서 실제로 예약을 적용하면 예약 테이블이 신규 손님을 받지 않는다.
    // 그 상태로 24시간을 돌린 "성공한 예측"을 내놓으면 안 된다는 것이 이 결함의 핵심이다.
    const state = reservable();
    const applied = cloneStateViaSerialize(state);
    applyCommand(applied, RESERVE, config, []);
    expect(applied.tournament).not.toBeNull();

    // 예약 전 상태에 대한 예약 명령 예측
    expect(forecast(state, RESERVE, config).supported).toBe(false);
    // 예약 후 상태에 대한 임의 명령 예측
    expect(forecast(applied, { type: 'hireDealer' }, config).supported).toBe(false);
  });

  it('4. 대회가 없는 평범한 투자 예상치는 계속 supported: true다', () => {
    const state = withSpareDealer(labState({ tables: 4, dealers: 3, cashGold: 50_000 }, config));
    const result = forecast(
      state,
      { type: 'assignDealer', tableId: 'T4', staffId: 'SPARE' },
      config,
    );
    expect(result.supported).toBe(true);
    if (!result.supported) throw new Error('unreachable');
    expect(result.deltaCompletedGuests).toBeGreaterThan(0);

    // 해금·현금이 충분해 예약도 가능한 상태에서조차, 예약이 아닌 명령은 정상 동작한다
    const reservableState = reservable();
    expect(validateCommand(reservableState, RESERVE, config).ok).toBe(true);
    expect(forecast(reservableState, { type: 'hireDealer' }, config).supported).toBe(true);
  });
});

/** 직렬화 왕복으로 깊은 복제를 만든다 (테스트 편의) */
function cloneStateViaSerialize(state: ReturnType<typeof labState>) {
  return JSON.parse(serialize(state)) as ReturnType<typeof labState>;
}
