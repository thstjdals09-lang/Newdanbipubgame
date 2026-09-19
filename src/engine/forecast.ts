/**
 * 투자 예상치 (Economy §9).
 *
 *   현재 상태를 복제해 '투자 안 함'과 '지금 투자함'을 같은 엔진으로 각각 24게임시간 진행한다.
 *   양쪽 모두 이후 추가 명령은 없다고 가정한다. 원본 상태를 수정하지 않는다.
 *
 * 근사식을 따로 만들지 않는다. 예측과 실제가 같은 규칙을 쓴다는 GDD §5·§10의 요구를
 * 구조적으로 보장하는 유일한 방법이 "복제본을 실제 tick으로 돌리기"이기 때문이다.
 *
 * 아직 구현하지 않은 상태(대회·리모델링·긴급 운영)를 만나면 조용히 무시하거나
 * 완성된 24시간 예측으로 표시하지 않고, 명시적인 미지원 결과를 돌려준다.
 */

import { DEFAULT_CONFIG, MONEY_SCALE } from '../config/economy.js';
import type { EconomyConfig } from '../config/economy.js';
import { applyCommand, validateCommand } from './commands.js';
import {
  availableCash,
  demandPerHourMilli,
  operatingTableCount,
  theoreticalCapacityMilli,
} from './derive.js';
import { assertSupported, cloneState } from './state.js';
import { tick } from './tick.js';
import { UnsupportedStateError } from './types.js';
import type {
  Command,
  GameState,
  Money,
  RejectReason,
  UnsupportedCode,
} from './types.js';

export const DEFAULT_HORIZON_MINUTES = 1440; // 24게임시간

export interface ForecastSnapshot {
  readonly operatingTables: number;
  readonly theoreticalCapacityMilli: number;
  readonly demandPerHourMilli: number;
  readonly cashUnits: Money;
  readonly availableCashUnits: Money;
}

export interface ForecastBranch {
  /** 지평 끝의 누적 매출 - 시작 시점 누적 매출 */
  readonly revenueUnits: Money;
  /** 같은 기간의 반복 비용 (급여 + 시설비 + 매장비) */
  readonly recurringCostUnits: Money;
  /** revenueUnits - recurringCostUnits. 일회성 투자 비용을 포함하지 않는다. */
  readonly operatingNetUnits: Money;
  readonly completedGuests: number;
  readonly endCashUnits: Money;
}

export type ForecastDelayReason =
  | 'DEALER_CHANGE_PENDING'
  | 'TABLE_WITHOUT_DEALER';

export interface ForecastOk {
  readonly supported: true;
  readonly horizonMinutes: number;
  /** 투자 직후(진행 전) 즉시 바뀌는 값 */
  readonly immediateBefore: ForecastSnapshot;
  readonly immediateAfter: ForecastSnapshot;
  /** 즉시 지급하는 일회성 투자 비용 */
  readonly investmentCostUnits: Money;
  readonly baseline: ForecastBranch;
  readonly invested: ForecastBranch;
  /** invested - baseline */
  readonly deltaRevenueUnits: Money;
  readonly deltaRecurringCostUnits: Money;
  readonly deltaOperatingNetUnits: Money;
  readonly deltaCompletedGuests: number;
  /**
   * 회수 시간(게임 분). 추가 순이익이 양수일 때만 참고치로 준다.
   * 그렇지 않으면 null이며, 화면은 이 값을 지어내면 안 된다.
   */
  readonly paybackMinutes: number | null;
  /** 효과 발생이 지연되는 이유 */
  readonly delays: readonly ForecastDelayReason[];
}

export interface ForecastUnsupported {
  readonly supported: false;
  readonly code: UnsupportedCode | 'COMMAND_REJECTED' | 'CASH_WENT_NEGATIVE';
  readonly detail: string;
  /** 명령 자체가 거절된 경우의 사유 */
  readonly reason?: RejectReason;
}

export type ForecastResult = ForecastOk | ForecastUnsupported;

function snapshot(state: GameState, config: EconomyConfig): ForecastSnapshot {
  return {
    operatingTables: operatingTableCount(state),
    theoreticalCapacityMilli: theoreticalCapacityMilli(state, config),
    demandPerHourMilli: demandPerHourMilli(state, config),
    cashUnits: state.venue.cash,
    availableCashUnits: availableCash(state),
  };
}

interface RunOutcome {
  readonly branch: ForecastBranch;
  readonly cashWentNegative: boolean;
}

function run(
  start: GameState,
  minutes: number,
  config: EconomyConfig,
): RunOutcome {
  const r0 = start.records;
  const baseRevenue = r0.totalRevenueUnits;
  const baseRecurring = r0.totalWageUnits + r0.totalFacilityUnits + r0.totalVenueCostUnits;
  const baseGuests = r0.completedGuests;

  let current = start;
  let cashWentNegative = false;

  for (let i = 0; i < minutes; i += 1) {
    const result = tick(current, config);
    current = result.state;
    if (result.events.some((e) => e.type === 'cashNegative')) cashWentNegative = true;
  }

  const r = current.records;
  const revenueUnits = r.totalRevenueUnits - baseRevenue;
  const recurringCostUnits =
    r.totalWageUnits + r.totalFacilityUnits + r.totalVenueCostUnits - baseRecurring;

  return {
    branch: {
      revenueUnits,
      recurringCostUnits,
      operatingNetUnits: revenueUnits - recurringCostUnits,
      completedGuests: r.completedGuests - baseGuests,
      endCashUnits: current.venue.cash,
    },
    cashWentNegative,
  };
}

/**
 * 투자 전후 예상치.
 * command가 없으면 순수 '투자 안 함' 전망만 계산한다.
 */
export function forecast(
  original: GameState,
  command: Command,
  config: EconomyConfig = DEFAULT_CONFIG,
  horizonMinutes: number = DEFAULT_HORIZON_MINUTES,
): ForecastResult {
  if (!Number.isSafeInteger(horizonMinutes) || horizonMinutes < 1) {
    throw new RangeError(`forecast: 예측 분이 올바르지 않음 (${horizonMinutes})`);
  }

  // 원본은 읽기만 한다. 아래 모든 진행은 복제본 위에서 일어난다.
  const before = snapshot(original, config);

  // 대회 예약이 걸린 상태에서는 24게임시간 예측을 만들지 않는다.
  // 예약은 준비 -> 시작 -> 진행 -> 정산으로 이어지는데 시작 이후는 작업 B-2다.
  // 그대로 1,440분을 돌리면 "대회가 영영 시작되지 않고 테이블이 계속 비어 있다"는
  // 사실이 아닌 전망을 내놓게 된다. 지어내지 않고 미지원을 돌려준다 (계약 7).
  if (original.tournament !== null) {
    return {
      supported: false,
      code: 'TOURNAMENT_NOT_IMPLEMENTED',
      detail:
        `대회 예약 ${original.tournament.id}(${original.tournament.phase}) 상태다. ` +
        '대회 시작과 진행은 작업 B-2에서 구현하므로 이 구간의 24시간 예측은 신뢰할 수 없다.',
    };
  }

  const check = validateCommand(original, command, config);
  if (!check.ok) {
    const reason = check.reason as RejectReason;
    return {
      supported: false,
      code: 'COMMAND_REJECTED',
      detail: check.detail ?? `명령이 거절됨: ${reason}`,
      reason,
    };
  }

  try {
    assertSupported(original, config);
    const baselineStart = cloneState(original);
    const investedStart = cloneState(original);

    // 명령은 게임 분 경계에서 즉시 적용한다. 아직 게임 시간/방문/세션/급여는 진행하지 않는다.
    // tick()도 같은 applyCommand를 1단계에서 호출하므로 실제 영업 결과와 규칙을 공유한다.
    applyCommand(investedStart, command, config, []);
    const investmentCostUnits =
      investedStart.records.totalOneOffUnits - original.records.totalOneOffUnits;
    const after = snapshot(investedStart, config);

    const delays: ForecastDelayReason[] = [];
    if (investedStart.tables.some((t) => t.pendingDealerId !== undefined)) {
      delays.push('DEALER_CHANGE_PENDING');
    }
    if (investedStart.tables.some((t) => t.status === 'idle')) {
      delays.push('TABLE_WITHOUT_DEALER');
    }

    const baselineRun = run(baselineStart, horizonMinutes, config);
    // 양쪽 모두 정확히 같은 기간을 돌린다. 투자 분기는 명령만 미리 적용했으므로
    // 첫 틱의 현금 부족, 영업 매출, 반복 비용도 run()에서 빠짐없이 검사/집계된다.
    const investedRun = run(investedStart, horizonMinutes, config);
    const invested = investedRun.branch;

    if (baselineRun.cashWentNegative || investedRun.cashWentNegative) {
      return {
        supported: false,
        code: 'CASH_WENT_NEGATIVE',
        detail:
          '예측 기간 중 현금이 음수가 된다. 완성된 게임이라면 긴급 축소 운영(Economy §11)이 ' +
          '발동하는 구간이며, 그 규칙은 작업 B에서 구현한다. 이 구간의 24시간 예측은 신뢰할 수 없다.',
      };
    }

    const deltaOperatingNetUnits = invested.operatingNetUnits - baselineRun.branch.operatingNetUnits;

    // 회수 시간은 추가 순이익이 양수이고 투자 비용이 있을 때만 준다 (Economy §9).
    let paybackMinutes: number | null = null;
    if (deltaOperatingNetUnits > 0 && investmentCostUnits > 0) {
      paybackMinutes = Math.ceil((investmentCostUnits * horizonMinutes) / deltaOperatingNetUnits);
    }

    return {
      supported: true,
      horizonMinutes,
      immediateBefore: before,
      immediateAfter: after,
      investmentCostUnits,
      baseline: baselineRun.branch,
      invested,
      deltaRevenueUnits: invested.revenueUnits - baselineRun.branch.revenueUnits,
      deltaRecurringCostUnits:
        invested.recurringCostUnits - baselineRun.branch.recurringCostUnits,
      deltaOperatingNetUnits,
      deltaCompletedGuests: invested.completedGuests - baselineRun.branch.completedGuests,
      paybackMinutes,
      delays,
    };
  } catch (error) {
    if (error instanceof UnsupportedStateError) {
      return { supported: false, code: error.code, detail: error.message };
    }
    throw error;
  }
}

/** 내부 단위 -> 표시용 G. 표시에만 쓴다. */
export function toGold(units: Money): number {
  return units / MONEY_SCALE;
}
