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
import { validateCommand } from './commands.js';
import {
  availableCash,
  demandPerHourMilli,
  operatingTableCount,
  theoreticalCapacityMilli,
} from './derive.js';
import { cloneState } from './state.js';
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
  // 원본은 읽기만 한다. 아래 모든 진행은 복제본 위에서 일어난다.
  const before = snapshot(original, config);

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
    const baselineStart = cloneState(original);
    const investedStart = cloneState(original);

    // 투자 분기: 명령을 1단계에서 반영하는 첫 틱을 먼저 돌린다.
    const first = tick(investedStart, config, [command]);
    if (first.events.some((e) => e.type === 'commandRejected')) {
      return {
        supported: false,
        code: 'COMMAND_REJECTED',
        detail: '복제본에서 명령이 거절됨',
      };
    }

    const cashAfterInvest = first.state.venue.cash;
    const investmentCostUnits =
      first.state.records.totalOneOffUnits - original.records.totalOneOffUnits;

    // 투자 직후 스냅샷은 첫 틱 종료 시점의 값이다.
    const after = snapshot(first.state, config);

    const delays: ForecastDelayReason[] = [];
    if (first.state.tables.some((t) => t.pendingDealerId !== undefined)) {
      delays.push('DEALER_CHANGE_PENDING');
    }
    if (first.state.tables.some((t) => t.status === 'idle')) {
      delays.push('TABLE_WITHOUT_DEALER');
    }

    const baselineRun = run(baselineStart, horizonMinutes, config);
    // 투자 분기는 첫 틱을 이미 썼으므로 남은 분만 진행한다.
    const investedRun = run(first.state, horizonMinutes - 1, config);

    // run()은 각 분기의 시작 시점 누적값을 기준으로 삼는다.
    // 투자 분기의 첫 틱은 run() 밖에서 돌았으므로 그 1분치를 더해준다.
    const firstMinuteRevenue =
      first.state.records.totalRevenueUnits - original.records.totalRevenueUnits;
    const firstMinuteRecurring =
      first.state.records.totalWageUnits +
      first.state.records.totalFacilityUnits +
      first.state.records.totalVenueCostUnits -
      (original.records.totalWageUnits +
        original.records.totalFacilityUnits +
        original.records.totalVenueCostUnits);
    const firstMinuteGuests =
      first.state.records.completedGuests - original.records.completedGuests;

    const invested: ForecastBranch = {
      revenueUnits: investedRun.branch.revenueUnits + firstMinuteRevenue,
      recurringCostUnits: investedRun.branch.recurringCostUnits + firstMinuteRecurring,
      operatingNetUnits:
        investedRun.branch.operatingNetUnits + firstMinuteRevenue - firstMinuteRecurring,
      completedGuests: investedRun.branch.completedGuests + firstMinuteGuests,
      endCashUnits: investedRun.branch.endCashUnits,
    };

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
      immediateAfter: { ...after, cashUnits: cashAfterInvest },
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
