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
  GameMinute,
  GameState,
  Milli,
  Money,
  RejectReason,
  StaffId,
  TableId,
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
        '이 함수는 일반 투자 회계(추가 매출·반복 비용·일회성 투자비·회수 시간)만 보고한다. ' +
        '대회는 준비비 잠금과 지연 정산이라는 다른 현금흐름을 가지므로 여기서 계산하지 않는다. ' +
        '작업 B-2의 forecastSmallTournament를 쓰되, 이미 예약이 걸린 상태는 그쪽에서도 ' +
        '일반 영업 반사실을 복원할 수 없어 미지원이다.',
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

  // 명령 자체가 대회를 예약하는 경우도 위와 같은 이유로 예측할 수 없다.
  //
  // 위의 검사는 "이미 예약이 걸린 상태"만 막는다. 그러나 유효한 예약 명령을
  // 복제본에 적용하면 투자 분기가 곧 예약 상태가 되고, 그 뒤 1,440분을 돌리면
  // 대회가 영영 시작되지 않는 전망이 만들어진다. 예약 테이블이 24시간 내내
  // 비어 있는 것으로 계산되므로 추가 매출·순이익·회수 시간이 모두 사실과 다르다.
  //
  // 이 검사는 validateCommand 뒤에 온다. 자격을 갖추지 못한 예약 명령은
  // 미지원이 아니라 거절이므로 사유(COMMAND_REJECTED)를 그대로 돌려줘야 한다.
  if (command.type === 'reserveSmallTournament') {
    return {
      supported: false,
      code: 'TOURNAMENT_NOT_IMPLEMENTED',
      detail:
        '대회 예약 명령의 예상치는 대회 시작·진행·정산까지 계산해야 의미가 있다. ' +
        '이 함수의 일반 투자 회계 필드(추가 매출·회수 시간)로는 준비비 잠금과 ' +
        '지연 정산을 올바르게 표현할 수 없다. ' +
        '작업 B-2의 forecastSmallTournament(state, tableIds, config, horizon)를 사용할 것.',
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

/* ------------------------------------------------------------------ */
/* 소규모 대회 예상치 (작업 B-2C)                                        */
/* ------------------------------------------------------------------ */

/**
 * 대회 예상치가 돌려줄 수 있는 미지원 사유.
 * 일반 투자 예상치의 사유에 대회 고유 두 가지를 더한다.
 */
export type TournamentForecastUnsupportedCode =
  | UnsupportedCode
  | 'COMMAND_REJECTED'
  | 'CASH_WENT_NEGATIVE'
  /** 입력 상태에 이미 대회가 걸려 있어 "대회를 안 열었을 때"를 복원할 수 없다 */
  | 'TOURNAMENT_ALREADY_ACTIVE'
  /** 지평 안에서 대회가 끝나지 않았다. 지평을 늘리거나 정산을 지어내지 않는다 */
  | 'TOURNAMENT_INCOMPLETE_AT_HORIZON';

export interface TournamentForecastUnsupported {
  readonly supported: false;
  readonly code: TournamentForecastUnsupportedCode;
  readonly detail: string;
  /** 명령 자체가 거절된 경우의 사유 */
  readonly reason?: RejectReason;
}

/**
 * 한 분기가 지평 동안 실제로 기록한 값.
 *
 * 일반 투자 예상치의 ForecastBranch를 재사용하지 않는다.
 * 그쪽은 "일반 매출 - 반복 비용"만 보는 구조라 참가비 수입과
 * 준비비 잠금·지연 정산을 표현할 자리가 없다.
 */
export interface TournamentBranchTotals {
  /** 일반 세션 매출 (참가비 제외) */
  readonly ordinaryRevenueUnits: Money;
  /** 대회 참가비 수입 */
  readonly tournamentRevenueUnits: Money;
  /** 급여 + 시설비 + 매장 운영비 */
  readonly recurringCostUnits: Money;
  /** 일회성 지출. 대회 준비비가 완료 시점에 여기로 들어간다. */
  readonly oneOffExpenseUnits: Money;
  /** 일반 완료 이용객. 대회 참가자는 포함하지 않는다. */
  readonly completedGuests: number;
  readonly endCashUnits: Money;
  readonly endLockedCashUnits: Money;
  readonly endAvailableCashUnits: Money;
}

/** 현금 3종 스냅샷 */
export interface CashSnapshot {
  readonly cashUnits: Money;
  readonly lockedCashUnits: Money;
  readonly availableCashUnits: Money;
}

export interface TournamentForecastOk {
  readonly supported: true;
  readonly horizonMinutes: number;

  /** 예약이 만들 대회의 확정 정보 */
  readonly tournamentId: string;
  readonly participants: number;
  readonly tableIds: readonly TableId[];
  readonly dealerIds: readonly StaffId[];
  /** 예약 시 잠기는 준비비 (상금 + 참가자별 운영비 + 고정 개최비, 채택 R2) */
  readonly prepCostUnits: Money;

  /** 예약 직전 / 직후. 잠금이 총현금이 아니라 가용 현금을 줄인다는 사실이 여기 드러난다. */
  readonly cashBeforeReservation: CashSnapshot;
  readonly cashAfterReservation: CashSnapshot;

  /** 지평 안에서 대회가 끝났다. 끝나지 않으면 이 결과가 나오지 않는다. */
  readonly completedAtMinute: GameMinute;
  /** 실제로 반영된 인지도 증가분. 현금에 잡히지 않는 이득이다. */
  readonly awarenessGainedMilli: Milli;

  readonly baseline: TournamentBranchTotals;
  readonly tournament: TournamentBranchTotals;

  /**
   * tournament - baseline.
   *
   * ordinaryRevenueUnits는 보통 **음수**다. 예약 테이블이 정리·진행 동안
   * 일반 손님을 받지 못한 기회비용이기 때문이다. 참가비만 떼어 "대회의 이득"이라고
   * 표현하면 안 된다는 Economy §8의 요구가 이 구조로 드러난다.
   */
  readonly delta: {
    readonly ordinaryRevenueUnits: Money;
    readonly tournamentRevenueUnits: Money;
    readonly recurringCostUnits: Money;
    readonly oneOffExpenseUnits: Money;
    readonly completedGuests: number;
    readonly endCashUnits: Money;
    readonly endAvailableCashUnits: Money;
  };
}

export type TournamentForecastResult = TournamentForecastOk | TournamentForecastUnsupported;

interface TournamentRunOutcome {
  readonly totals: TournamentBranchTotals;
  readonly endState: GameState;
  readonly cashWentNegative: boolean;
}

function cashSnapshot(state: GameState): CashSnapshot {
  return {
    cashUnits: state.venue.cash,
    lockedCashUnits: state.venue.lockedCash,
    availableCashUnits: availableCash(state),
  };
}

/** 한 분기를 지평만큼 진행하며 실제 기록값의 차이를 모은다. */
function runTournamentBranch(
  start: GameState,
  minutes: number,
  config: EconomyConfig,
): TournamentRunOutcome {
  const r0 = start.records;
  const baseOrdinary = r0.totalRevenueUnits;
  const baseTournament = r0.totalTournamentRevenueUnits;
  const baseRecurring = r0.totalWageUnits + r0.totalFacilityUnits + r0.totalVenueCostUnits;
  const baseOneOff = r0.totalOneOffUnits;
  const baseGuests = r0.completedGuests;

  let current = start;
  let cashWentNegative = false;

  for (let i = 0; i < minutes; i += 1) {
    const result = tick(current, config);
    current = result.state;
    if (result.events.some((e) => e.type === 'cashNegative')) cashWentNegative = true;
  }

  const r = current.records;
  return {
    totals: {
      ordinaryRevenueUnits: r.totalRevenueUnits - baseOrdinary,
      tournamentRevenueUnits: r.totalTournamentRevenueUnits - baseTournament,
      recurringCostUnits:
        r.totalWageUnits + r.totalFacilityUnits + r.totalVenueCostUnits - baseRecurring,
      oneOffExpenseUnits: r.totalOneOffUnits - baseOneOff,
      completedGuests: r.completedGuests - baseGuests,
      endCashUnits: current.venue.cash,
      endLockedCashUnits: current.venue.lockedCash,
      endAvailableCashUnits: availableCash(current),
    },
    endState: current,
    cashWentNegative,
  };
}

/**
 * 소규모 대회 예상치 (작업 B-2C).
 *
 *   A. 대회를 열지 않고 일반 영업을 계속한다.
 *   B. 지금 예약하고 대회를 끝까지 치른다.
 *
 * 두 분기를 **같은 tick() 엔진으로 같은 게임 분만큼** 진행해 실제 기록값을 비교한다.
 * 별도의 대회 시뮬레이터나 근사 공식을 만들지 않는다. 예약 이후 추가 명령은 없다고 본다.
 * 원본 상태는 읽기만 한다.
 *
 * 회계 원칙 (Economy §7·§8, 채택 R2):
 *   - 준비비는 예약 시 **잠기기만** 하고 총현금에서 빠지지 않는다. 가용 현금만 줄어든다.
 *   - 실제 지출은 완료 시점에 인식되며 oneOffExpenseUnits 차이로 한 번만 잡힌다.
 *   - 참가비는 일반 세션 매출과 분리해 따로 보고한다.
 *   - 상금·참가자별 운영비·고정 개최비는 이미 준비비에 들어 있어 다시 빼지 않는다.
 *   - 급여·시설비는 전역 틱이 부과하므로 대회 쪽에서 또 빼지 않는다.
 *   - 일반 투자 예상치의 회수 시간(paybackMinutes)을 대회에 재사용하지 않는다.
 */
export function forecastSmallTournament(
  original: GameState,
  tableIds: readonly TableId[],
  config: EconomyConfig = DEFAULT_CONFIG,
  horizonMinutes: number = DEFAULT_HORIZON_MINUTES,
): TournamentForecastResult {
  if (!Number.isSafeInteger(horizonMinutes) || horizonMinutes < 1) {
    throw new RangeError(`forecastSmallTournament: 예측 분이 올바르지 않음 (${horizonMinutes})`);
  }

  // 이미 대회가 걸려 있으면 "대회를 안 열었을 때"라는 비교 기준을 만들 수 없다.
  // 예약 테이블과 잠긴 준비비를 되돌리는 것은 상태를 지어내는 일이다.
  if (original.tournament !== null) {
    return {
      supported: false,
      code: 'TOURNAMENT_ALREADY_ACTIVE',
      detail:
        `이미 대회 ${original.tournament.id}(${original.tournament.phase})가 진행 중이다. ` +
        '일반 영업 반사실을 현재 상태에서 복원할 수 없으므로 비교 예측을 만들지 않는다.',
    };
  }

  const command: Command = { type: 'reserveSmallTournament', tableIds: [...tableIds] };

  // 자격 판정은 기존 검증 함수를 그대로 쓴다. 자격 미달은 미지원이 아니라 거절이다.
  const check = validateCommand(original, command, config);
  if (!check.ok) {
    const reason = check.reason as RejectReason;
    return {
      supported: false,
      code: 'COMMAND_REJECTED',
      detail: check.detail ?? `예약할 수 없다: ${reason}`,
      reason,
    };
  }

  try {
    assertSupported(original, config);

    const baselineStart = cloneState(original);
    const tournamentStart = cloneState(original);

    const cashBeforeReservation = cashSnapshot(tournamentStart);

    // 예약은 게임 분 경계에서 즉시 적용한다. 아직 시간은 진행하지 않는다.
    applyCommand(tournamentStart, command, config, []);
    const reservation = tournamentStart.tournament;
    if (reservation === null) {
      throw new Error('forecastSmallTournament: 예약이 만들어지지 않았다');
    }
    const cashAfterReservation = cashSnapshot(tournamentStart);

    // 양쪽 모두 정확히 같은 게임 분을 진행한다.
    const baselineRun = runTournamentBranch(baselineStart, horizonMinutes, config);
    const tournamentRun = runTournamentBranch(tournamentStart, horizonMinutes, config);

    if (baselineRun.cashWentNegative || tournamentRun.cashWentNegative) {
      return {
        supported: false,
        code: 'CASH_WENT_NEGATIVE',
        detail:
          '예측 기간 중 현금이 음수가 된다. 완성된 게임이라면 긴급 축소 운영(Economy §11)이 ' +
          '발동하는 구간이며 그 규칙은 작업 B-3이다. 이 구간의 비교 예측은 신뢰할 수 없다.',
      };
    }

    // 지평 안에서 끝나지 않았다면 정산을 지어내지 않는다. 지평도 조용히 늘리지 않는다.
    const endTournament = tournamentRun.endState.tournament;
    if (endTournament !== null) {
      return {
        supported: false,
        code: 'TOURNAMENT_INCOMPLETE_AT_HORIZON',
        detail:
          `예측 지평 ${horizonMinutes}게임분 끝에도 대회 ${endTournament.id}가 ` +
          `${endTournament.phase} 상태로 남아 있다. 준비비가 잠긴 채이고 참가비도 아직 ` +
          '수입이 아니므로 완료된 대회의 예측으로 표시하지 않는다.',
      };
    }

    const record = tournamentRun.endState.records.completedTournaments.find(
      (c) => c.id === reservation.id,
    );
    if (!record) {
      throw new Error(
        `forecastSmallTournament: 대회 ${reservation.id}가 사라졌는데 완료 기록이 없다`,
      );
    }

    const baseline = baselineRun.totals;
    const tournament = tournamentRun.totals;
    const delta = {
      ordinaryRevenueUnits: tournament.ordinaryRevenueUnits - baseline.ordinaryRevenueUnits,
      tournamentRevenueUnits: tournament.tournamentRevenueUnits - baseline.tournamentRevenueUnits,
      recurringCostUnits: tournament.recurringCostUnits - baseline.recurringCostUnits,
      oneOffExpenseUnits: tournament.oneOffExpenseUnits - baseline.oneOffExpenseUnits,
      completedGuests: tournament.completedGuests - baseline.completedGuests,
      endCashUnits: tournament.endCashUnits - baseline.endCashUnits,
      endAvailableCashUnits: tournament.endAvailableCashUnits - baseline.endAvailableCashUnits,
    };

    // 현금 차이는 기록된 수입·지출 차이와 반드시 맞아야 한다.
    // 어긋나면 어딘가에서 금액을 두 번 셌거나 빠뜨린 것이므로 결과를 내지 않는다.
    const reconciled =
      delta.ordinaryRevenueUnits +
      delta.tournamentRevenueUnits -
      delta.recurringCostUnits -
      delta.oneOffExpenseUnits;
    if (reconciled !== delta.endCashUnits) {
      throw new Error(
        'forecastSmallTournament: 현금 차이가 수입·지출 차이와 맞지 않는다 ' +
          `(기록 ${reconciled} vs 현금 ${delta.endCashUnits})`,
      );
    }

    return {
      supported: true,
      horizonMinutes,
      tournamentId: reservation.id,
      participants: reservation.participants,
      tableIds: [...reservation.tableIds],
      dealerIds: [...reservation.dealerIds],
      prepCostUnits: reservation.prepCostUnits,
      cashBeforeReservation,
      cashAfterReservation,
      completedAtMinute: record.completedAtMinute,
      awarenessGainedMilli: record.awarenessGainedMilli,
      baseline,
      tournament,
      delta,
    };
  } catch (error) {
    if (error instanceof UnsupportedStateError) {
      return { supported: false, code: error.code, detail: error.message };
    }
    throw error;
  }
}
