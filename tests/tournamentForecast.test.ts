/**
 * 소규모 대회 경제 예상치 (작업 B-2C) 검증.
 *
 * 실제 엔진 동작을 검사한다. 기대값을 프로덕션 코드에 심어 통과시키지 않는다.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, gold, milli } from '../src/config/economy.js';
import type { EconomyConfig } from '../src/config/economy.js';
import { tournamentPrepCostUnits } from '../src/engine/cash.js';
import { applyCommand, validateCommand } from '../src/engine/commands.js';
import {
  DEFAULT_HORIZON_MINUTES,
  forecast,
  forecastSmallTournament,
} from '../src/engine/forecast.js';
import { cloneState, deserialize, serialize } from '../src/engine/state.js';
import { tick } from '../src/engine/tick.js';
import type { Command, GameState } from '../src/engine/types.js';
import { G, fixedDemandConfig, labState, run } from './helpers.js';

const SMALL = DEFAULT_CONFIG.tournament.small;
const demandConfig = fixedDemandConfig(20); // 예상 참가자 = min(16, floor(20 x 2)) = 16
const TABLES = ['T1', 'T2'] as const;
const RESERVE: Command = { type: 'reserveSmallTournament', tableIds: [...TABLES] };

function reservableState(
  config: EconomyConfig,
  opts: { tables?: number; dealers?: number; cashGold?: number } = {},
): GameState {
  const state = labState(
    {
      tables: opts.tables ?? 4,
      dealers: opts.dealers ?? 4,
      cashGold: opts.cashGold ?? 50_000,
    },
    config,
  );
  state.venue.awarenessMilli = milli(10);
  return run(state, 1, config);
}

/* ------------------------------------------------------------------ */
/* 입력 검증과 불변성                                                    */
/* ------------------------------------------------------------------ */

describe('1. 잘못된 예약은 COMMAND_REJECTED를 돌려준다', () => {
  it('해금 전이면 TOURNAMENT_LOCKED 사유가 그대로 나온다', () => {
    const state = labState({ tables: 4, dealers: 4, cashGold: 50_000 }, demandConfig);
    const r = forecastSmallTournament(state, TABLES, demandConfig);
    expect(r.supported).toBe(false);
    if (r.supported) throw new Error('unreachable');
    expect(r.code).toBe('COMMAND_REJECTED');
    expect(r.reason).toBe('TOURNAMENT_LOCKED');
  });

  it('테이블 중복·개수 오류·존재하지 않는 테이블 사유가 보존된다', () => {
    const state = reservableState(demandConfig);
    const cases: { tables: readonly string[]; reason: string }[] = [
      { tables: ['T1', 'T1'], reason: 'TOURNAMENT_TABLE_DUPLICATE' },
      { tables: ['T1'], reason: 'TOURNAMENT_TABLE_COUNT' },
      { tables: ['T1', 'T99'], reason: 'TABLE_NOT_FOUND' },
    ];
    for (const { tables, reason } of cases) {
      const r = forecastSmallTournament(state, tables, demandConfig);
      expect(r.supported).toBe(false);
      if (r.supported) throw new Error('unreachable');
      expect(r.code).toBe('COMMAND_REJECTED');
      expect(r.reason).toBe(reason);
    }
  });

  it('13. 운영 예비금이 모자라면 성공한 예측을 지어내지 않는다', () => {
    const state = reservableState(demandConfig);
    const prep = tournamentPrepCostUnits(SMALL, 16);
    state.venue.cash = prep; // 준비비는 되지만 예비금이 모자란다

    const r = forecastSmallTournament(state, TABLES, demandConfig);
    expect(r.supported).toBe(false);
    if (r.supported) throw new Error('unreachable');
    expect(r.code).toBe('COMMAND_REJECTED');
    expect(r.reason).toBe('TOURNAMENT_RESERVE_SHORTFALL');
  });

  it('0분 또는 소수 분 지평을 받지 않는다', () => {
    const state = reservableState(demandConfig);
    expect(() => forecastSmallTournament(state, TABLES, demandConfig, 0)).toThrow(RangeError);
    expect(() => forecastSmallTournament(state, TABLES, demandConfig, 1.5)).toThrow(RangeError);
  });

  it('기본 지평이 1,440게임분이다', () => {
    const state = reservableState(demandConfig);
    const r = forecastSmallTournament(state, TABLES, demandConfig);
    expect(r.supported).toBe(true);
    if (!r.supported) throw new Error('unreachable');
    expect(r.horizonMinutes).toBe(DEFAULT_HORIZON_MINUTES);
    expect(DEFAULT_HORIZON_MINUTES).toBe(1440);
  });
});

describe('2. 원본 상태를 바이트 단위로 바꾸지 않는다', () => {
  it('성공·거절 어느 경우에도 원본이 그대로다', () => {
    const ok = reservableState(demandConfig);
    const okBefore = serialize(ok);
    forecastSmallTournament(ok, TABLES, demandConfig);
    expect(serialize(ok)).toBe(okBefore);

    const bad = labState({ tables: 4, dealers: 4, cashGold: 50_000 }, demandConfig);
    const badBefore = serialize(bad);
    forecastSmallTournament(bad, TABLES, demandConfig);
    expect(serialize(bad)).toBe(badBefore);
  });

  it('같은 입력을 두 번 계산하면 같은 결과가 나온다', () => {
    const state = reservableState(demandConfig);
    const a = forecastSmallTournament(state, TABLES, demandConfig);
    const b = forecastSmallTournament(state, TABLES, demandConfig);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

/* ------------------------------------------------------------------ */
/* 두 분기의 동등성                                                      */
/* ------------------------------------------------------------------ */

describe('3 / 14. 두 분기는 실제 tick 엔진을 같은 기간만큼 돌린 것과 같다', () => {
  const horizon = 600;

  it('기준 분기가 실제 일반 영업 진행 결과와 정확히 일치한다', () => {
    const state = reservableState(demandConfig);
    const r = forecastSmallTournament(state, TABLES, demandConfig, horizon);
    if (!r.supported) throw new Error('지원되는 상태여야 한다');

    const actual = run(state, horizon, demandConfig);
    expect(r.baseline.ordinaryRevenueUnits).toBe(
      actual.records.totalRevenueUnits - state.records.totalRevenueUnits,
    );
    expect(r.baseline.completedGuests).toBe(
      actual.records.completedGuests - state.records.completedGuests,
    );
    expect(r.baseline.endCashUnits).toBe(actual.venue.cash);
    expect(r.baseline.tournamentRevenueUnits).toBe(0);
    expect(r.baseline.oneOffExpenseUnits).toBe(0);
  });

  it('5. 대회 분기가 실제 예약·준비·진행·정산 결과와 정확히 일치한다', () => {
    const state = reservableState(demandConfig);
    const r = forecastSmallTournament(state, TABLES, demandConfig, horizon);
    if (!r.supported) throw new Error('지원되는 상태여야 한다');

    // 같은 상태에 실제로 예약을 걸고 같은 분만큼 돌린다
    const actual = cloneState(state);
    applyCommand(actual, RESERVE, demandConfig, []);
    const advanced = run(actual, horizon, demandConfig);

    expect(r.tournament.endCashUnits).toBe(advanced.venue.cash);
    expect(r.tournament.ordinaryRevenueUnits).toBe(
      advanced.records.totalRevenueUnits - state.records.totalRevenueUnits,
    );
    expect(r.tournament.tournamentRevenueUnits).toBe(
      advanced.records.totalTournamentRevenueUnits - state.records.totalTournamentRevenueUnits,
    );
    expect(r.tournament.completedGuests).toBe(
      advanced.records.completedGuests - state.records.completedGuests,
    );
    expect(advanced.records.tournamentsDone).toBe(1);
    expect(r.completedAtMinute).toBe(
      advanced.records.completedTournaments[0]!.completedAtMinute,
    );
    expect(r.tournamentId).toBe(advanced.records.completedTournaments[0]!.id);
  });

  it('4. 기준 분기에는 대회가 생기지 않고 일반 영업이 계속된다', () => {
    const state = reservableState(demandConfig);
    const r = forecastSmallTournament(state, TABLES, demandConfig, horizon);
    if (!r.supported) throw new Error('지원되는 상태여야 한다');

    expect(r.baseline.ordinaryRevenueUnits).toBeGreaterThan(0);
    expect(r.baseline.endLockedCashUnits).toBe(0);
    // 대회를 연 쪽은 예약 테이블이 쉬므로 일반 매출이 더 적다 (기회비용)
    expect(r.delta.ordinaryRevenueUnits).toBeLessThan(0);
    expect(r.delta.completedGuests).toBeLessThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* 회계                                                                 */
/* ------------------------------------------------------------------ */

describe('6~10. 회계', () => {
  const horizon = 600;

  it('6. 일반 매출과 참가비 수입이 분리돼 보고된다', () => {
    const state = reservableState(demandConfig);
    const r = forecastSmallTournament(state, TABLES, demandConfig, horizon);
    if (!r.supported) throw new Error('지원되는 상태여야 한다');

    expect(r.tournament.tournamentRevenueUnits).toBe(gold(SMALL.entryFeeGold * 16));
    expect(G(r.tournament.tournamentRevenueUnits)).toBe(16 * 180);
    // 참가비가 일반 매출에 섞이지 않았다
    expect(r.tournament.ordinaryRevenueUnits).toBeLessThan(r.baseline.ordinaryRevenueUnits);
    expect(r.delta.tournamentRevenueUnits).toBe(gold(SMALL.entryFeeGold * 16));
    // 참가자 16명이 일반 완료 이용객에 더해지지 않았다
    expect(r.delta.completedGuests).toBeLessThan(0);
  });

  it('7. 준비비는 정확히 한 번만 비용으로 잡힌다', () => {
    const state = reservableState(demandConfig);
    const r = forecastSmallTournament(state, TABLES, demandConfig, horizon);
    if (!r.supported) throw new Error('지원되는 상태여야 한다');

    const prep = tournamentPrepCostUnits(SMALL, 16);
    expect(r.prepCostUnits).toBe(prep);
    expect(G(prep)).toBe(16 * 60 + 16 * 20 + 600); // 상금 + 운영비 + 개최비
    // 일회성 지출 차이가 준비비와 정확히 같다 (두 배가 아니다)
    expect(r.delta.oneOffExpenseUnits).toBe(prep);
    expect(r.baseline.oneOffExpenseUnits).toBe(0);
  });

  it('8. 급여·시설비는 양쪽에서 한 번씩만 잡히고 차이가 0이다', () => {
    const state = reservableState(demandConfig);
    const r = forecastSmallTournament(state, TABLES, demandConfig, horizon);
    if (!r.supported) throw new Error('지원되는 상태여야 한다');

    // 테이블 수·딜러 수가 같으므로 반복 비용 누계가 완전히 같다.
    // 대회 정산이 급여·시설비를 다시 빼지 않았다는 증거다.
    expect(r.delta.recurringCostUnits).toBe(0);
    expect(r.tournament.recurringCostUnits).toBe(r.baseline.recurringCostUnits);
    expect(r.baseline.recurringCostUnits).toBeGreaterThan(0);
  });

  it('9. 현금 차이가 기록된 수입·지출 차이와 맞아떨어진다', () => {
    const state = reservableState(demandConfig);
    const r = forecastSmallTournament(state, TABLES, demandConfig, horizon);
    if (!r.supported) throw new Error('지원되는 상태여야 한다');

    const reconciled =
      r.delta.ordinaryRevenueUnits +
      r.delta.tournamentRevenueUnits -
      r.delta.recurringCostUnits -
      r.delta.oneOffExpenseUnits;
    expect(reconciled).toBe(r.delta.endCashUnits);

    // 분기별로도 성립한다
    for (const b of [r.baseline, r.tournament]) {
      const branchDelta =
        b.ordinaryRevenueUnits + b.tournamentRevenueUnits - b.recurringCostUnits - b.oneOffExpenseUnits;
      expect(b.endCashUnits - state.venue.cash).toBe(branchDelta);
    }
  });

  it('10. 예약은 가용 현금만 줄이고 총현금은 그대로다', () => {
    const state = reservableState(demandConfig);
    const r = forecastSmallTournament(state, TABLES, demandConfig, horizon);
    if (!r.supported) throw new Error('지원되는 상태여야 한다');

    expect(r.cashBeforeReservation.cashUnits).toBe(state.venue.cash);
    expect(r.cashBeforeReservation.lockedCashUnits).toBe(0);

    // 총현금은 그대로, 잠금은 준비비만큼, 가용은 그만큼 감소
    expect(r.cashAfterReservation.cashUnits).toBe(r.cashBeforeReservation.cashUnits);
    expect(r.cashAfterReservation.lockedCashUnits).toBe(r.prepCostUnits);
    expect(r.cashAfterReservation.availableCashUnits).toBe(
      r.cashBeforeReservation.availableCashUnits - r.prepCostUnits,
    );

    // 완료 뒤에는 잠금이 풀리고 실제 지출로 확정됐다
    expect(r.tournament.endLockedCashUnits).toBe(0);
  });

  it('참가비만 떼어 "대회의 이득"으로 보고하지 않는다', () => {
    const state = reservableState(demandConfig);
    const r = forecastSmallTournament(state, TABLES, demandConfig, horizon);
    if (!r.supported) throw new Error('지원되는 상태여야 한다');

    // 대회 단독 손익(참가비 - 준비비)과 실제 순현금 차이는 다르다.
    const standaloneProfit = r.delta.tournamentRevenueUnits - r.delta.oneOffExpenseUnits;
    expect(G(standaloneProfit)).toBe(1000); // 2,880 - 1,880
    expect(r.delta.endCashUnits).not.toBe(standaloneProfit);
    // 차이는 정확히 일반 매출 기회비용이다
    expect(r.delta.endCashUnits).toBe(standaloneProfit + r.delta.ordinaryRevenueUnits);
  });

  it('인지도 이득을 현금과 별도로 보고한다', () => {
    const state = reservableState(demandConfig);
    const r = forecastSmallTournament(state, TABLES, demandConfig, horizon);
    if (!r.supported) throw new Error('지원되는 상태여야 한다');
    expect(r.awarenessGainedMilli).toBe(SMALL.awarenessRewardMilli);
  });

  it('회수 시간 필드를 제공하지 않는다', () => {
    const state = reservableState(demandConfig);
    const r = forecastSmallTournament(state, TABLES, demandConfig, horizon);
    if (!r.supported) throw new Error('지원되는 상태여야 한다');
    expect('paybackMinutes' in r).toBe(false);
  });

  it('11. 필요한 정보가 모두 담긴 지원 결과를 돌려준다', () => {
    const state = reservableState(demandConfig);
    const r = forecastSmallTournament(state, TABLES, demandConfig, horizon);
    expect(r.supported).toBe(true);
    if (!r.supported) throw new Error('unreachable');

    expect(r.tournamentId).toBe('TN1');
    expect(r.participants).toBe(16);
    expect(r.tableIds).toEqual(['T1', 'T2']);
    expect(r.dealerIds).toEqual(['D1', 'D2']);
    expect(r.completedAtMinute).toBeGreaterThan(state.time.minute);
    expect(r.completedAtMinute).toBeLessThanOrEqual(state.time.minute + horizon);
  });
});

/* ------------------------------------------------------------------ */
/* 미지원 경계                                                          */
/* ------------------------------------------------------------------ */

describe('12. 지평 안에 끝나지 않으면 명시적 미지원', () => {
  it('지평이 짧으면 완료된 대회 예측을 만들지 않는다', () => {
    const state = reservableState(demandConfig);
    const r = forecastSmallTournament(state, TABLES, demandConfig, 100);
    expect(r.supported).toBe(false);
    if (r.supported) throw new Error('unreachable');
    expect(r.code).toBe('TOURNAMENT_INCOMPLETE_AT_HORIZON');
    expect(r.detail).toMatch(/IN_PROGRESS|RESERVED/);
  });

  it('지평을 조용히 늘리지 않는다 — 같은 상태도 지평에 따라 결과가 갈린다', () => {
    const state = reservableState(demandConfig);
    expect(forecastSmallTournament(state, TABLES, demandConfig, 100).supported).toBe(false);
    expect(forecastSmallTournament(state, TABLES, demandConfig, 600).supported).toBe(true);
  });

  it('정리가 길어 시작조차 못 한 경우도 미지원이다', () => {
    // 좌석이 찬 뒤 예약하면 정리에만 최대 120분이 걸린다
    const state = run(reservableState(demandConfig), 150, demandConfig);
    const r = forecastSmallTournament(state, TABLES, demandConfig, 60);
    expect(r.supported).toBe(false);
    if (r.supported) throw new Error('unreachable');
    expect(r.code).toBe('TOURNAMENT_INCOMPLETE_AT_HORIZON');
  });
});

describe('이미 대회가 걸린 상태는 비교 기준을 만들 수 없다', () => {
  it('TOURNAMENT_ALREADY_ACTIVE를 돌려준다', () => {
    const state = reservableState(demandConfig, { tables: 5, dealers: 5 });
    applyCommand(state, RESERVE, demandConfig, []);

    const r = forecastSmallTournament(state, ['T3', 'T4'], demandConfig);
    expect(r.supported).toBe(false);
    if (r.supported) throw new Error('unreachable');
    expect(r.code).toBe('TOURNAMENT_ALREADY_ACTIVE');
  });
});

describe('긴급 운영이 필요한 구간은 성공 결과를 내지 않는다', () => {
  it('예측 중 잠긴 자금이 잠식되면 EMERGENCY_NOT_IMPLEMENTED를 돌려준다', () => {
    // 테이블 3개 중 딜러는 2명. T1·T2를 예약하면 영업 테이블이 0이 되어 매출이 끊긴다.
    const config = demandConfig;
    const state = reservableState(config, { tables: 3, dealers: 2 });

    // 자금이 넉넉하면 정상적으로 완료 예측이 나온다
    const rich = forecastSmallTournament(state, TABLES, config, 600);
    expect(rich.supported).toBe(true);

    // 준비비 + 예비금 4시간만 남기면 매출이 없어 그 4시간 뒤 잠긴 자금을 잠식한다
    const tight = cloneState(state);
    const hourlyUnits =
      (2 * DEFAULT_CONFIG.staff.normal.wagePerHourGold +
        2 * DEFAULT_CONFIG.table.facilityCostPerHourGold +
        DEFAULT_CONFIG.venue.baseCostPerHourGold) *
      60;
    tight.venue.cash = tournamentPrepCostUnits(SMALL, 16) + hourlyUnits * 4;

    const r = forecastSmallTournament(tight, TABLES, config, 1440);
    expect(r.supported).toBe(false);
    if (r.supported) throw new Error('unreachable');
    expect(r.code).toBe('EMERGENCY_NOT_IMPLEMENTED');
    expect(r.detail).toMatch(/B-3/);
  });

  it('매출이 끊기는 구성의 수지가 기록값과 정확히 맞는다', () => {
    // 영업 테이블이 0이 되는 극단적인 경우로 회계 분리를 눈으로 확인한다.
    const config = demandConfig;
    const state = reservableState(config, { tables: 3, dealers: 2 });
    const r = forecastSmallTournament(state, TABLES, config, 600);
    if (!r.supported) throw new Error('지원되는 상태여야 한다');

    expect(G(r.delta.tournamentRevenueUnits)).toBe(2880); // 참가비 16 x 180
    expect(G(r.delta.oneOffExpenseUnits)).toBe(1880); // 준비비 1회
    expect(r.delta.recurringCostUnits).toBe(0); // 급여·시설비 중복 없음
    expect(G(r.delta.ordinaryRevenueUnits)).toBe(-6400); // 일반 영업 기회비용
    expect(G(r.delta.endCashUnits)).toBe(-6400 + 2880 - 1880);
    expect(G(r.delta.endCashUnits)).toBe(-5400);
  });
});

/* ------------------------------------------------------------------ */
/* 기존 동작 보존과 결정성                                               */
/* ------------------------------------------------------------------ */

describe('15. 기존 일반 투자 예상치는 그대로다', () => {
  it('평범한 투자 예상치가 계속 supported: true다', () => {
    const config = fixedDemandConfig(20);
    const state = labState({ tables: 4, dealers: 3, cashGold: 50_000 }, config);
    state.staff.push({ id: 'SPARE', type: 'normal', duty: 'standby', assignedTableId: null });

    const r = forecast(state, { type: 'assignDealer', tableId: 'T4', staffId: 'SPARE' }, config);
    expect(r.supported).toBe(true);
    if (!r.supported) throw new Error('unreachable');
    expect(r.deltaCompletedGuests).toBeGreaterThan(0);
    expect(r.paybackMinutes === null || r.paybackMinutes > 0).toBe(true);
  });

  it('forecast()는 예약 명령을 여전히 거절하고 새 진입점을 안내한다', () => {
    const state = reservableState(demandConfig);
    expect(validateCommand(state, RESERVE, demandConfig).ok).toBe(true);

    const r = forecast(state, RESERVE, demandConfig);
    expect(r.supported).toBe(false);
    if (r.supported) throw new Error('unreachable');
    expect(r.code).toBe('TOURNAMENT_NOT_IMPLEMENTED');
    expect(r.detail).toMatch(/forecastSmallTournament/);
  });

  it('forecast()는 대회가 걸린 상태도 여전히 거절한다', () => {
    const state = reservableState(demandConfig, { tables: 5, dealers: 5 });
    applyCommand(state, RESERVE, demandConfig, []);
    const r = forecast(state, { type: 'hireDealer' }, demandConfig);
    expect(r.supported).toBe(false);
    if (r.supported) throw new Error('unreachable');
    expect(r.code).toBe('TOURNAMENT_NOT_IMPLEMENTED');
  });
});

describe('16. 시간 분할·저장 복원이 예측 결과를 바꾸지 않는다', () => {
  const horizon = 600;

  it('저장·복원한 입력에서 같은 예측이 나온다', () => {
    const state = reservableState(demandConfig);
    const direct = forecastSmallTournament(state, TABLES, demandConfig, horizon);
    const restored = forecastSmallTournament(
      deserialize(serialize(state), demandConfig),
      TABLES,
      demandConfig,
      horizon,
    );
    expect(JSON.stringify(restored)).toBe(JSON.stringify(direct));
  });

  it('같은 지점에 시간 분할로 도달해도 같은 예측이 나온다', () => {
    const base = reservableState(demandConfig);

    const straight = run(cloneState(base), 200, demandConfig);

    let split = cloneState(base);
    for (const chunk of [37, 1, 99, 63]) split = run(split, chunk, demandConfig);
    split = deserialize(serialize(split), demandConfig);

    expect(serialize(split)).toBe(serialize(straight));

    const a = forecastSmallTournament(straight, TABLES, demandConfig, horizon);
    const b = forecastSmallTournament(split, TABLES, demandConfig, horizon);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('예측이 대회 생애주기를 바꾸지 않는다 — 실제 진행과 같은 시각에 끝난다', () => {
    const state = reservableState(demandConfig);
    const r = forecastSmallTournament(state, TABLES, demandConfig, horizon);
    if (!r.supported) throw new Error('지원되는 상태여야 한다');

    const actual = cloneState(state);
    applyCommand(actual, RESERVE, demandConfig, []);
    let cur = actual;
    let completedAt = -1;
    for (let i = 0; i < horizon; i += 1) {
      const res = tick(cur, demandConfig);
      cur = res.state;
      if (res.events.some((e) => e.type === 'tournamentCompleted')) {
        completedAt = cur.time.minute;
        break;
      }
    }
    expect(completedAt).toBe(r.completedAtMinute);
  });
});
