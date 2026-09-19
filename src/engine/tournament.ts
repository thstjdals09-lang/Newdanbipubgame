/**
 * 대회 자원 예약 (작업 B-1).
 *
 * 이 모듈이 소유하는 범위는 **예약과 준비**뿐이다.
 *   - 예약 자격 판정
 *   - 예약 트랜잭션 (준비비 잠금 + 테이블 점유 + 개최권 소비)
 *   - RESERVED_DRAINING -> RESERVED_READY 전환
 *
 * 다음은 전부 작업 B-2다. 이 모듈에 넣지 않는다.
 *   - 대회 시작, 진행 시간 계산(R3의 대회 전문 딜러 1.25 포함)
 *   - 참가비·상금·인지도 보상 정산
 *   - 예약 자원(테이블·딜러)의 해제
 *
 * 별도 모듈로 분리한 이유: commands.ts는 명령 배선과 단순 구매 검증을 담고 있고,
 * 예약 자격은 12개 검사와 자원 소유 규칙이라 성격이 다르다.
 * demand/seating/satisfaction/costs/cash와 같은 "관심사 하나당 모듈 하나" 구조를 따른다.
 */

import type { EconomyConfig, Stage, TournamentSpec } from '../config/economy.js';
import { expectedParticipants, lock, tournamentPrepCostUnits } from './cash.js';
import { hourlyOperatingCostUnits } from './costs.js';
import { availableCash, demandPerHourMilli, findStaff, findTable } from './derive.js';
import type {
  CommandResult,
  EngineEvent,
  GameState,
  Money,
  RejectReason,
  StaffId,
  TableId,
  TournamentReservation,
  TournamentScale,
} from './types.js';

const ok: CommandResult = { ok: true };
const no = (reason: RejectReason, detail?: string): CommandResult =>
  detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };

/** 해금 ID. tick 9단계의 processUnlocks가 부여한다. */
export const SMALL_TOURNAMENT_UNLOCK_ID = 'smallTournament';

/** 게임일 번호 = floor(경과 게임분 / 하루 길이) (Economy §8) */
export function gameDayOf(minute: number, config: EconomyConfig): number {
  return Math.floor(minute / config.time.minutesPerGameDay);
}

/** 이 단계에서 해당 규모의 대회를 열 수 있는가 (Progression §4) */
export function isScaleAvailable(stage: Stage, scale: TournamentScale): boolean {
  return scale === 'small' ? true : stage === 2;
}

/**
 * 예약 시 요구하는 운영 예비금 (내부 단위).
 *
 *   예비금 = 현재 시간당 운영비 x config.tournamentOperatingReserveHours
 *
 * 05 채택기록 R10에서 4게임시간을 채택했다 (잠정 밸런스).
 * 시간당 운영비는 기존 minuteCosts에서 파생한 hourlyOperatingCostUnits 하나만 쓴다.
 * 두 번째 비용 계산을 만들지 않는다.
 *
 * null이면 0을 돌려준다. 예비금 규칙을 적용하지 않는 상태를 표현하기 위한 값이며
 * isOperatingReserveAdopted가 그 구분을 노출한다.
 */
export function requiredOperatingReserveUnits(
  state: GameState,
  config: EconomyConfig,
): Money {
  const hours = config.tournamentOperatingReserveHours;
  if (hours === null) return 0;
  return hourlyOperatingCostUnits(state, config) * hours;
}

/** 운영 예비금 규칙이 채택됐는가. 화면과 보고가 "검사 안 함"을 구분할 수 있게 한다. */
export function isOperatingReserveAdopted(config: EconomyConfig): boolean {
  return config.tournamentOperatingReserveHours !== null;
}

export interface ReservationPlan {
  readonly scale: TournamentScale;
  readonly spec: TournamentSpec;
  readonly tableIds: readonly TableId[];
  readonly dealerIds: readonly StaffId[];
  readonly participants: number;
  readonly prepCostUnits: Money;
  readonly reserveUnits: Money;
  readonly gameDay: number;
}

/**
 * 예약 자격 판정. **상태를 수정하지 않는다.**
 *
 * 성공하면 적용에 필요한 값이 모두 담긴 plan을 함께 돌려준다.
 * 검증과 적용이 같은 함수로 자격을 판단하므로 규칙이 갈라질 수 없다 (계약 2).
 */
export function planSmallTournament(
  state: GameState,
  tableIds: readonly TableId[],
  config: EconomyConfig,
): { readonly result: CommandResult; readonly plan?: ReservationPlan } {
  const scale: TournamentScale = 'small';
  const spec = config.tournament[scale];

  // 1. 해금
  if (!state.unlocks.some((u) => u.id === SMALL_TOURNAMENT_UNLOCK_ID)) {
    return {
      result: no(
        'TOURNAMENT_LOCKED',
        `테이블 ${config.unlock.smallTournamentTableCount}개와 인지도 ` +
          `${config.unlock.smallTournamentAwarenessMilli / 1000} 필요`,
      ),
    };
  }

  // 2. 단계와 규모 가용성
  if (!isScaleAvailable(state.venue.stage, scale)) {
    return { result: no('TOURNAMENT_SCALE_UNAVAILABLE') };
  }

  // 8. 기존 대회 예약·진행 부재 (개별 테이블 검사보다 먼저 본다)
  if (state.tournament !== null) {
    return {
      result: no('TOURNAMENT_ALREADY_RESERVED', `진행 중인 예약 ${state.tournament.id}`),
    };
  }

  // 9. 리모델링 부재 (P08)
  if (state.remodel !== null) {
    return { result: no('REMODEL_IN_PROGRESS') };
  }

  // 10. 같은 게임일 개최권 (Economy §8: 규모와 관계없이 공유)
  const gameDay = gameDayOf(state.time.minute, config);
  if (state.records.usedTournamentDays.includes(gameDay)) {
    return { result: no('TOURNAMENT_DAY_USED', `게임일 ${gameDay}의 개최권을 이미 사용했다`) };
  }

  // 3. 정확히 2개, 중복 없음
  if (tableIds.length !== spec.tables) {
    return {
      result: no('TOURNAMENT_TABLE_COUNT', `테이블 ${spec.tables}개를 선택해야 한다`),
    };
  }
  if (new Set(tableIds).size !== tableIds.length) {
    return { result: no('TOURNAMENT_TABLE_DUPLICATE') };
  }

  // 4~7. 각 테이블의 존재·운영 상태·담당 딜러
  const dealerIds: StaffId[] = [];
  for (const tableId of tableIds) {
    const table = findTable(state, tableId);
    if (!table) {
      return { result: no('TABLE_NOT_FOUND', tableId) };
    }
    // 예약·리모델링 점유 테이블은 status로 걸러진다 (operating이 아니다)
    if (table.status !== 'operating') {
      return {
        result: no('TOURNAMENT_TABLE_NOT_OPERATING', `${tableId}의 상태가 ${table.status}`),
      };
    }
    if (table.pendingDealerId !== undefined) {
      return { result: no('TOURNAMENT_TABLE_DEALER_PENDING', tableId) };
    }
    if (table.dealerId === null) {
      return { result: no('TOURNAMENT_TABLE_NO_DEALER', tableId) };
    }
    const dealer = findStaff(state, table.dealerId);
    if (!dealer || dealer.type === 'service' || dealer.duty !== 'working') {
      return { result: no('TOURNAMENT_TABLE_NO_DEALER', `${tableId}의 담당 딜러가 근무 상태가 아님`) };
    }
    dealerIds.push(dealer.id);
  }

  // 7. 딜러 중복
  if (new Set(dealerIds).size !== dealerIds.length) {
    return { result: no('TOURNAMENT_DEALER_DUPLICATE') };
  }
  if (dealerIds.length !== spec.dealers) {
    // 테이블 수와 딜러 수는 소규모에서 같다. 방어적 검사.
    return { result: no('TOURNAMENT_TABLE_COUNT', `딜러 ${spec.dealers}명이 필요하다`) };
  }

  // 11. 예상 참가자 하한 (Economy §8). 예약 시점 수요로 확정한다.
  const participants = expectedParticipants(demandPerHourMilli(state, config), spec);
  if (participants < spec.minParticipants) {
    return {
      result: no(
        'TOURNAMENT_PARTICIPANTS_TOO_FEW',
        `예상 ${participants}명 < 최소 ${spec.minParticipants}명`,
      ),
    };
  }

  // 12. 준비비 + 운영 예비금
  const prepCostUnits = tournamentPrepCostUnits(spec, participants);
  const reserveUnits = requiredOperatingReserveUnits(state, config);
  const available = availableCash(state);

  if (prepCostUnits > available) {
    return {
      result: no(
        'INSUFFICIENT_CASH',
        `준비비 ${prepCostUnits / 60}G > 사용 가능 ${available / 60}G`,
      ),
    };
  }
  if (prepCostUnits + reserveUnits > available) {
    return {
      result: no(
        'TOURNAMENT_RESERVE_SHORTFALL',
        `준비비 ${prepCostUnits / 60}G + 예비금 ${reserveUnits / 60}G > 사용 가능 ${available / 60}G`,
      ),
    };
  }

  return {
    result: ok,
    plan: {
      scale,
      spec,
      tableIds: [...tableIds],
      dealerIds,
      participants,
      prepCostUnits,
      reserveUnits,
      gameDay,
    },
  };
}

/**
 * 예약 적용. planSmallTournament가 통과한 plan만 받는다.
 *
 * 부분 적용을 남기지 않기 위해 **예외를 던질 수 있는 lock()을 가장 먼저** 호출한다.
 * lock이 실패하면 아무것도 바뀌지 않은 상태로 예외가 올라간다.
 * 그 뒤의 대입은 모두 예외를 던지지 않는다.
 */
export function applyReservation(
  state: GameState,
  plan: ReservationPlan,
  events: EngineEvent[],
): TournamentReservation {
  // 1) 준비비 잠금. cash는 줄지 않고 lockedCash만 는다 (05 §3).
  lock(state, plan.prepCostUnits);

  // 2) 테이블 점유. acceptsNewGuests가 false가 되어 신규 착석이 멈춘다.
  //    기존 세션은 건드리지 않는다. endsAtMinute과 revenueUnits 그대로다.
  for (const tableId of plan.tableIds) {
    const table = findTable(state, tableId);
    if (!table) throw new Error(`applyReservation: 테이블 ${tableId} 없음`);
    table.status = 'tournamentHeld';
  }

  // 3) 예약 레코드 생성
  const id = `TN${state.records.nextTournamentSeq}`;
  state.records.nextTournamentSeq += 1;

  const reservation: TournamentReservation = {
    id,
    scale: plan.scale,
    phase: 'RESERVED_DRAINING',
    participants: plan.participants,
    tableIds: [...plan.tableIds],
    dealerIds: [...plan.dealerIds],
    prepCostUnits: plan.prepCostUnits,
    gameDay: plan.gameDay,
    reservedAtMinute: state.time.minute,
    readyAtMinute: null,
  };
  state.tournament = reservation;

  // 4) 게임일 개최권 소비. 정확히 한 번만.
  if (!state.records.usedTournamentDays.includes(plan.gameDay)) {
    state.records.usedTournamentDays.push(plan.gameDay);
  }

  events.push({
    type: 'tournamentReserved',
    tournamentId: id,
    tableIds: reservation.tableIds,
    dealerIds: reservation.dealerIds,
    prepCostUnits: reservation.prepCostUnits,
  });

  return reservation;
}

/**
 * 준비 완료 판정 (Economy §10의 3단계).
 *
 * 예약 테이블에 미정산 일반 세션이 하나도 없으면 RESERVED_READY로 바꾼다.
 *
 * 문서가 지정한 자리를 그대로 지킨다. 3단계는 세션 정산(4단계)보다 앞이므로
 * 마지막 세션이 분 M에 정산되면 준비 완료는 분 M+1에 확인된다.
 * Economy §10 말미가 이 지연을 명시적으로 예고하고 있다.
 *
 * **RESERVED_READY는 대회가 시작된 상태가 아니다.** 시작은 작업 B-2다.
 */
export function updateTournamentPhase(state: GameState, events: EngineEvent[]): void {
  const t = state.tournament;
  if (t === null) return;
  if (t.phase !== 'RESERVED_DRAINING') return;

  const stillBusy = state.sessions.some(
    (s) => !s.settled && t.tableIds.includes(s.tableId),
  );
  if (stillBusy) return;

  t.phase = 'RESERVED_READY';
  t.readyAtMinute = state.time.minute;
  events.push({ type: 'tournamentReady', tournamentId: t.id });
}

/** 이 테이블이 대회 예약에 묶여 있는가. 화면·검증이 소유 주체를 구분할 때 쓴다. */
export function isTableReserved(state: GameState, tableId: TableId): boolean {
  return state.tournament?.tableIds.includes(tableId) ?? false;
}

/** 이 딜러가 대회 예약에 묶여 있는가. */
export function isDealerReserved(state: GameState, staffId: StaffId): boolean {
  return state.tournament?.dealerIds.includes(staffId) ?? false;
}
