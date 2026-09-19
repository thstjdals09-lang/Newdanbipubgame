/**
 * 대회 자원 예약 (작업 B-1).
 *
 * 이 모듈이 소유하는 범위는 **예약과 준비**뿐이다.
 *   - 예약 자격 판정
 *   - 예약 트랜잭션 (준비비 잠금 + 테이블 점유 + 개최권 소비)
 *   - RESERVED_DRAINING -> RESERVED_READY 전환
 *
 * B-2A가 여기에 더한 범위:
 *   - 대회 시작과 진행 시간 계산 (R3의 대회 전문 딜러 1.25 포함)
 *   - 종료 정산: 준비비 비용화, 참가비 수입, 인지도 보상, 개최 실적
 *   - 예약 자원(테이블·딜러)의 해제
 *
 * 다음은 여전히 후속 범위다. 이 모듈에 넣지 않는다.
 *   - 중규모 대회 진행
 *   - 대회를 반영한 투자 예상치
 *   - 특별 직원 지급, 긴급 축소 운영, 리모델링
 *
 * 별도 모듈로 분리한 이유: commands.ts는 명령 배선과 단순 구매 검증을 담고 있고,
 * 예약 자격은 12개 검사와 자원 소유 규칙이라 성격이 다르다.
 * demand/seating/satisfaction/costs/cash와 같은 "관심사 하나당 모듈 하나" 구조를 따른다.
 */

import { gold } from '../config/economy.js';
import type { EconomyConfig, Stage, TournamentSpec } from '../config/economy.js';
import { expectedParticipants, lock, settleLocked, tournamentPrepCostUnits } from './cash.js';
import { hourlyOperatingCostUnits } from './costs.js';
import { availableCash, demandPerHourMilli, findStaff, findTable } from './derive.js';
import { assertSafeInteger } from './fixed.js';
import type {
  CommandResult,
  EngineEvent,
  GameState,
  Money,
  RejectReason,
  StaffId,
  TableId,
  TournamentCompletionRecord,
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
    startedAtMinute: null,
    endsAtMinute: null,
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
 * 진행 시간 (게임 분).
 *
 * 05 채택기록 R3: **이 대회에 실제 예약된 딜러**에 대회 전문 딜러가 한 명 이상
 * 있으면 1.25 배율을 적용한다. 명부에만 있고 예약되지 않은 전문 딜러는 효과가 없다.
 * 여러 명이어도 중첩하지 않는다.
 *
 * 기존 정수 규약을 그대로 쓴다: ceil(기본 시간 x 1000 / 속도배율milli).
 * 일반 세션 시간과 딜러 속도는 건드리지 않는다.
 */
export function tournamentDurationMinutes(
  state: GameState,
  reservation: TournamentReservation,
  config: EconomyConfig,
): number {
  const spec = config.tournament[reservation.scale];
  const base = spec.baseDurationMinutes;

  const hasReservedSpecialist = reservation.dealerIds.some(
    (id) => findStaff(state, id)?.type === 'tournament',
  );
  if (!hasReservedSpecialist) return base;

  const speedMilli = config.staff.tournament.tournamentSpeedMilli;
  if (speedMilli <= 0) throw new Error('대회 운영 속도 배율이 올바르지 않음');
  return Math.ceil((base * 1000) / speedMilli);
}

/**
 * 준비 완료 판정.
 *
 * 예약 테이블에 미정산 일반 세션이 하나도 없으면 RESERVED_READY로 바꾼다.
 * B-1에서 확정한 타이밍을 그대로 유지한다. 3단계는 세션 정산(4단계)보다
 * 앞이므로 마지막 세션이 분 M에 정산되면 준비 완료는 분 M+1에 확인된다.
 */
function updateReadiness(state: GameState, events: EngineEvent[]): void {
  const t = state.tournament;
  if (t === null) return;
  if (t.phase !== 'RESERVED_DRAINING') return;

  const stillBusy = state.sessions.some((s) => !s.settled && t.tableIds.includes(s.tableId));
  if (stillBusy) return;

  t.phase = 'RESERVED_READY';
  t.readyAtMinute = state.time.minute;
  events.push({ type: 'tournamentReady', tournamentId: t.id });
}

/** 대회 시작. RESERVED_READY에서만 일어난다. */
function startTournament(state: GameState, config: EconomyConfig, events: EngineEvent[]): void {
  const t = state.tournament;
  if (t === null || t.phase !== 'RESERVED_READY') return;

  // 같은 3단계 호출에서 막 READY가 된 대회는 시작하지 않는다.
  // processTournament의 호출 순서가 이미 이를 보장하지만,
  // 상태를 직접 만들어 넣은 경우까지 막기 위해 명시적으로 확인한다.
  if (t.readyAtMinute === null || t.readyAtMinute >= state.time.minute) return;

  // 예약 테이블에 일반 세션이 남아 있으면 시작하지 않는다 (방어적).
  if (state.sessions.some((s) => !s.settled && t.tableIds.includes(s.tableId))) return;

  const duration = tournamentDurationMinutes(state, t, config);
  t.phase = 'IN_PROGRESS';
  t.startedAtMinute = state.time.minute;
  t.endsAtMinute = state.time.minute + duration;

  events.push({
    type: 'tournamentStarted',
    tournamentId: t.id,
    startedAtMinute: t.startedAtMinute,
    endsAtMinute: t.endsAtMinute,
  });
}

/**
 * 대회 종료 정산. **하나의 논리적 트랜잭션이다.**
 *
 *   1) 중복 정산 방지 검사
 *   2) 잠긴 준비비를 실제 지출로 확정 (settleLocked — 예외를 던질 수 있는 유일한 지점)
 *   3) 참가비 수입 인식 — 일반 세션 매출과 분리된 계정에 넣는다
 *   4) 인지도 보상 (상한 100, 채택 R4)
 *   5) 개최 실적 +1
 *   6) 예약 테이블·딜러 해제
 *   7) 완료 기록을 남기고 예약 슬롯을 비운다
 *
 * 2단계 뒤의 연산은 모두 예외를 던지지 않는다. 그리고 tick()이 입력 상태를
 * 복제해 돌리므로 어느 지점에서 예외가 나도 호출자의 상태에는
 * 부분 정산이 남지 않는다.
 *
 * 상금·참가자별 운영비·고정 개최비는 이미 prepCostUnits에 들어 있다. 다시 빼지 않는다.
 * 급여·시설비는 전역 틱이 매분 차감하므로 대회 정산에서 또 빼지 않는다.
 */
function completeTournament(
  state: GameState,
  config: EconomyConfig,
  events: EngineEvent[],
): void {
  const t = state.tournament;
  if (t === null || t.phase !== 'IN_PROGRESS') return;
  if (t.endsAtMinute === null || state.time.minute < t.endsAtMinute) return;
  if (t.startedAtMinute === null) {
    throw new Error(`대회 ${t.id}: 진행 중인데 시작 시각이 없다`);
  }

  // 1) 같은 대회를 두 번 정산하지 않는다.
  if (state.records.completedTournaments.some((c) => c.id === t.id)) {
    throw new Error(`대회 ${t.id}: 이미 완료 기록이 있는 대회를 다시 정산하려 했다`);
  }

  const spec = config.tournament[t.scale];

  // 2) 잠긴 준비비를 비용으로 확정. spend()로 같은 비용을 또 청구하지 않는다.
  settleLocked(state, t.prepCostUnits, `tournament:${t.id}:prep`);

  // 3) 참가비 수입. 예약 시 확정한 참가자 수를 쓴다.
  const entryFeeUnits = gold(spec.entryFeeGold * t.participants);
  state.venue.cash = assertSafeInteger(state.venue.cash + entryFeeUnits, 'cash');
  state.records.totalTournamentRevenueUnits += entryFeeUnits;
  state.ledger.push({
    id: `L${state.records.nextLedgerSeq}`,
    minute: state.time.minute,
    purpose: `tournament:${t.id}:entryFee`,
    kind: 'oneOff',
    amountUnits: entryFeeUnits,
  });
  state.records.nextLedgerSeq += 1;

  // 4) 인지도 보상. 채택 R4의 상한 100을 그대로 따른다.
  const beforeAwareness = state.venue.awarenessMilli;
  state.venue.awarenessMilli = Math.min(
    config.demand.awarenessMaxMilli,
    beforeAwareness + spec.awarenessRewardMilli,
  );
  const awarenessGainedMilli = state.venue.awarenessMilli - beforeAwareness;

  // 5) 개최 실적
  state.records.tournamentsDone += 1;

  // 6) 자원 해제. 담당 딜러는 그대로 두고 테이블만 일반 영업으로 되돌린다.
  //    'closing' 딜러 변경 경로를 쓰지 않는다 — 그 경로는 딜러를 떼어낼 수 있다.
  t.tableIds.forEach((tableId, i) => {
    const table = findTable(state, tableId);
    if (!table) throw new Error(`대회 ${t.id}: 해제할 테이블 ${tableId}가 없다`);
    const dealerId = t.dealerIds[i];
    if (table.dealerId !== dealerId) {
      throw new Error(
        `대회 ${t.id}: 테이블 ${tableId}의 담당 딜러가 예약과 다르다 ` +
          `(${String(table.dealerId)} vs ${String(dealerId)})`,
      );
    }
    table.status = 'operating';
  });

  // 7) 완료 기록. 예약 슬롯을 비워 다음 대회를 영구히 막지 않는다.
  //    같은 게임일 재예약은 usedTournamentDays가 계속 막는다.
  const record: TournamentCompletionRecord = {
    id: t.id,
    scale: t.scale,
    participants: t.participants,
    gameDay: t.gameDay,
    startedAtMinute: t.startedAtMinute,
    completedAtMinute: state.time.minute,
    prepCostUnits: t.prepCostUnits,
    entryFeeUnits,
    awarenessGainedMilli,
    tableIds: [...t.tableIds],
    dealerIds: [...t.dealerIds],
  };
  state.records.completedTournaments.push(record);
  state.tournament = null;

  events.push({
    type: 'tournamentCompleted',
    tournamentId: record.id,
    prepCostUnits: record.prepCostUnits,
    entryFeeUnits: record.entryFeeUnits,
    awarenessGainedMilli: record.awarenessGainedMilli,
  });
}

/**
 * 틱 3단계의 대회 처리 (Economy §10).
 *
 * **평가 순서가 곧 결정성이다.**
 *   1) 종료 시각에 도달한 대회를 정산한다.
 *   2) 이전 분에 준비가 끝난 대회를 시작한다.
 *   3) 정리가 끝난 예약을 RESERVED_READY로 바꾼다.
 *
 * 준비 완료 판정을 마지막에 두므로, 분 M에 READY가 된 대회는 분 M+1의
 * 3단계에서야 시작한다. 같은 호출에서 준비되자마자 시작하는 일이 없다.
 *
 * 이 함수는 게임 분만 쓴다. 현실 시각·타이머·렌더링 프레임·난수를 쓰지 않는다.
 */
export function processTournament(
  state: GameState,
  config: EconomyConfig,
  events: EngineEvent[],
): void {
  completeTournament(state, config, events);
  startTournament(state, config, events);
  updateReadiness(state, events);
}

/** 이 테이블이 대회 예약에 묶여 있는가. 화면·검증이 소유 주체를 구분할 때 쓴다. */
export function isTableReserved(state: GameState, tableId: TableId): boolean {
  return state.tournament?.tableIds.includes(tableId) ?? false;
}

/** 이 딜러가 대회 예약에 묶여 있는가. */
export function isDealerReserved(state: GameState, staffId: StaffId): boolean {
  return state.tournament?.dealerIds.includes(staffId) ?? false;
}
