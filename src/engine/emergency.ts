/**
 * 긴급 축소 운영 (작업 B-3, Economy §11).
 *
 * 자기 자금으로 이번 분의 반복 비용을 낼 수 없을 때 진입한다.
 *
 *   8단계  부족액만 지원하고 확정한 비용을 한 번 차감한다.
 *   9단계  예약 정리 -> 유지 대상 선택 -> 일반 테이블 정리 -> 직원 대기 전환
 *          -> 복구 종료 판정.
 *
 * 이 모듈은 **별도의 경제 계산 엔진을 만들지 않는다.** 비용은 기존 minuteCosts에서,
 * 종료 기준액은 축소 완료 상태의 같은 비용 계산에서 파생한다.
 *
 * 대회 예약 자원은 건드리지 않는다. 예약 해제와 준비비 정산은 tournament.ts만 한다.
 */

import type { EconomyConfig } from '../config/economy.js';
import { minuteCosts } from './costs.js';
import { availableCash, findStaff, findTable } from './derive.js';
import { assertSafeInteger } from './fixed.js';
import type {
  EmergencyState,
  EngineEvent,
  GameState,
  Money,
  StaffId,
  StaffState,
  TableId,
  TableState,
} from './types.js';

/** 종료 조건의 운영 예비금: 축소 완료 상태의 4게임시간 운영비 */
export const RECOVERY_RESERVE_MINUTES = 240;

/** 이 테이블이 대회 예약에 묶여 있는가 */
function isTournamentTable(state: GameState, tableId: TableId): boolean {
  return state.tournament?.tableIds.includes(tableId) ?? false;
}

/** 이 딜러가 대회 예약에 묶여 있는가 */
function isTournamentDealer(state: GameState, staffId: StaffId): boolean {
  return state.tournament?.dealerIds.includes(staffId) ?? false;
}

function hasActiveSessions(state: GameState, tableId: TableId): boolean {
  return state.sessions.some((s) => !s.settled && s.tableId === tableId);
}

/* ------------------------------------------------------------------ */
/* 8단계 — 발동과 지원                                                  */
/* ------------------------------------------------------------------ */

export interface MinuteCostOutcome {
  /** 이번 분에 확정한 반복 비용 */
  readonly costUnits: Money;
  /** 실제로 지급한 지원금 */
  readonly supportUnits: Money;
  /** 이번 분에 긴급 운영으로 새로 진입했는가 */
  readonly entered: boolean;
}

/**
 * 틱 8단계: 반복 비용 확정 -> 부족액 지원 -> 비용 1회 차감.
 *
 * 순서가 규칙이다 (사용자 지정 §2).
 *   1. 현재 배치로 이번 분의 반복 비용 C를 한 번 계산한다.
 *   2. 사용 가능 현금 A = cash - lockedCash.
 *   3. A < C이면 긴급 운영에 진입(또는 유지)한다. A === C면 진입하지 않는다.
 *   4. 부족액 S = max(0, C - A)만 지원한다. 복구 목표액을 일괄 충전하지 않는다.
 *   5. 확정한 C를 한 번 차감하고 비용 누계에 반영한다.
 *
 * 발동한 분의 비용을 줄이려고 배치를 소급 변경하지 않는다.
 * 축소는 9단계에서 적용되고 절감은 다음 분부터 나타난다.
 *
 * 지원은 cash만 늘리고 lockedCash는 건드리지 않는다. 잠긴 준비비를 운영비로
 * 쓰지 않는다. 지원과 차감은 같은 틱의 상태 변경으로 함께 확정된다.
 */
export function applyMinuteCostsWithSupport(
  state: GameState,
  config: EconomyConfig,
  events: EngineEvent[],
): MinuteCostOutcome {
  const costs = minuteCosts(state, config);
  const costUnits = costs.total;
  const availableUnits = availableCash(state);

  let supportUnits = 0;
  let entered = false;

  if (availableUnits < costUnits) {
    const emergency = ensureEmergency(state, events);
    entered = emergency.startedAtMinute === state.time.minute;

    supportUnits = costUnits - availableUnits;
    if (supportUnits <= 0) {
      throw new Error(`긴급 지원 금액이 올바르지 않음: ${supportUnits}`);
    }

    state.venue.cash = assertSafeInteger(state.venue.cash + supportUnits, 'cash');
    state.records.totalEmergencySupportUnits += supportUnits;
    emergency.supportUnits += supportUnits;
    emergency.supportedMinutes += 1;

    state.ledger.push({
      id: `L${state.records.nextLedgerSeq}`,
      minute: state.time.minute,
      purpose: `emergency:${emergency.id}:support`,
      kind: 'emergencySupport',
      amountUnits: supportUnits,
    });
    state.records.nextLedgerSeq += 1;

    events.push({
      type: 'emergencySupportGranted',
      emergencyId: emergency.id,
      atMinute: state.time.minute,
      amountUnits: supportUnits,
    });
  }

  // 확정한 비용을 정확히 한 번 차감한다.
  state.venue.cash = assertSafeInteger(state.venue.cash - costUnits, 'cash');
  state.records.totalWageUnits += costs.wage;
  state.records.totalFacilityUnits += costs.facility;
  state.records.totalVenueCostUnits += costs.venue;

  return { costUnits, supportUnits, entered };
}

function ensureEmergency(state: GameState, events: EngineEvent[]): EmergencyState {
  if (state.emergency !== null) return state.emergency;

  const id = `EM${state.records.nextEmergencySeq}`;
  state.records.nextEmergencySeq += 1;

  const emergency: EmergencyState = {
    id,
    phase: 'DOWNSIZING',
    startedAtMinute: state.time.minute,
    keptTableId: null,
    keptDealerId: null,
    supportUnits: 0,
    supportedMinutes: 0,
  };
  state.emergency = emergency;
  events.push({ type: 'emergencyStarted', emergencyId: id, atMinute: state.time.minute });
  return emergency;
}

/* ------------------------------------------------------------------ */
/* 9단계 — 유지 대상 선택                                                */
/* ------------------------------------------------------------------ */

interface Candidate {
  readonly table: TableState;
  readonly dealer: StaffState;
  /** 시간당 유지비 (딜러 급여 + 테이블 시설비) */
  readonly upkeepPerHourGold: number;
  /** 이미 근무 배치된 조합인가 */
  readonly keepsExistingAssignment: boolean;
}

/**
 * 유지할 테이블 1개와 딜러 1명의 후보를 모은다.
 *
 *   A. 대회에 예약되지 않은 테이블과 현재 담당 딜러.
 *      기존 세션이 있어도 같은 담당자를 유지하므로 후보가 된다.
 *   B. 일반 세션이 없는 미운영 테이블과 다른 업무에 묶이지 않은 대기 딜러.
 *
 * 진행 중인 세션의 담당자를 다른 테이블로 빼오는 조합은 만들지 않는다.
 */
function collectCandidates(state: GameState, config: EconomyConfig): Candidate[] {
  const facility = config.table.facilityCostPerHourGold;
  const out: Candidate[] = [];

  for (const table of state.tables) {
    if (isTournamentTable(state, table.id)) continue;
    if (table.status === 'remodelPrep') continue;

    // A. 현재 담당 딜러를 그대로 유지하는 조합
    if (table.dealerId !== null) {
      const dealer = findStaff(state, table.dealerId);
      if (
        dealer &&
        dealer.type !== 'service' &&
        dealer.duty === 'working' &&
        dealer.assignedTableId === table.id &&
        !isTournamentDealer(state, dealer.id)
      ) {
        out.push({
          table,
          dealer,
          upkeepPerHourGold: config.staff[dealer.type].wagePerHourGold + facility,
          keepsExistingAssignment: true,
        });
      }
      continue; // 담당자가 있는 테이블에 다른 딜러를 붙이지 않는다
    }

    // B. 미운영 + 세션 없음 + 대기 딜러
    if (table.status !== 'idle') continue;
    if (hasActiveSessions(state, table.id)) continue;

    for (const dealer of state.staff) {
      if (dealer.type === 'service') continue;
      if (dealer.duty !== 'standby') continue;
      if (dealer.assignedTableId !== null) continue;
      if (isTournamentDealer(state, dealer.id)) continue;
      if (state.tables.some((t) => t.pendingDealerId === dealer.id)) continue;

      out.push({
        table,
        dealer,
        upkeepPerHourGold: config.staff[dealer.type].wagePerHourGold + facility,
        keepsExistingAssignment: false,
      });
    }
  }

  return out;
}

/**
 * 후보 우선순위 (사용자 지정 §4).
 *   1. 시간당 유지비가 낮은 조합
 *   2. 동률이면 기존 근무 배치를 유지하는 조합
 *   3. 동률이면 spotIndex가 작은 테이블
 *   4. 마지막 동률은 직원 ID의 고정된 사전순
 *
 * 전순서이므로 같은 상태에서 항상 같은 조합이 나온다.
 */
function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.upkeepPerHourGold !== b.upkeepPerHourGold) {
    return a.upkeepPerHourGold - b.upkeepPerHourGold;
  }
  if (a.keepsExistingAssignment !== b.keepsExistingAssignment) {
    return a.keepsExistingAssignment ? -1 : 1;
  }
  if (a.table.spotIndex !== b.table.spotIndex) {
    return a.table.spotIndex - b.table.spotIndex;
  }
  if (a.dealer.id === b.dealer.id) return 0;
  return a.dealer.id < b.dealer.id ? -1 : 1;
}

/** 현재 상태에서 고를 유지 대상. 가능한 조합이 없으면 null. */
export function selectKeptPair(
  state: GameState,
  config: EconomyConfig,
): { readonly tableId: TableId; readonly dealerId: StaffId } | null {
  const candidates = collectCandidates(state, config);
  if (candidates.length === 0) return null;
  const best = candidates.slice().sort(compareCandidates)[0];
  if (!best) return null;
  return { tableId: best.table.id, dealerId: best.dealer.id };
}

/* ------------------------------------------------------------------ */
/* 9단계 — 축소와 종료                                                   */
/* ------------------------------------------------------------------ */

/**
 * 유지 대상이 실제로 일반 영업 중인지 확인하고, 필요하면 배치한다.
 * 대기 딜러를 미운영 테이블에 붙이는 경우(후보 B)만 배치가 일어난다.
 */
function activateKeptPair(state: GameState, emergency: EmergencyState): void {
  if (emergency.keptTableId === null || emergency.keptDealerId === null) return;

  const table = findTable(state, emergency.keptTableId);
  const dealer = findStaff(state, emergency.keptDealerId);
  if (!table || !dealer) {
    throw new Error(`긴급 운영 ${emergency.id}: 유지 대상 자원이 사라졌다`);
  }

  if (table.dealerId === null) {
    dealer.duty = 'working';
    dealer.assignedTableId = table.id;
    table.dealerId = dealer.id;
  }
  if (table.dealerId !== dealer.id) {
    throw new Error(`긴급 운영 ${emergency.id}: 유지 테이블의 담당 딜러가 선택과 다르다`);
  }
  delete table.pendingDealerId;
  table.status = 'operating';
}

/**
 * 유지 대상 밖의 일반 테이블을 정리한다.
 *
 * 신규 착석은 이미 seating 쪽에서 막히므로, 여기서는 상태 표기와
 * 세션이 모두 끝난 테이블의 해제를 담당한다.
 * 대회 점유 테이블은 건드리지 않는다.
 */
function downsizeOtherTables(state: GameState, emergency: EmergencyState): void {
  for (const table of state.tables) {
    if (table.id === emergency.keptTableId) continue;
    if (isTournamentTable(state, table.id)) continue;
    if (table.status === 'remodelPrep') continue;

    // 배치 예약은 이미 cancelPendingDealerChanges가 해제했다. 방어적으로 한 번 더 확인한다.
    delete table.pendingDealerId;

    if (table.dealerId === null) {
      if (table.status !== 'idle') table.status = 'idle';
      continue;
    }

    if (hasActiveSessions(state, table.id)) {
      // 정리 중. 기존 세션만 정상 완료시킨다.
      table.status = 'closing';
      continue;
    }

    const dealer = findStaff(state, table.dealerId);
    if (dealer) {
      dealer.duty = 'standby';
      dealer.assignedTableId = null;
    }
    table.dealerId = null;
    table.status = 'idle';
  }
}

/**
 * 아직 투입되지 않은 일반 딜러 교체 예약을 해제한다.
 *
 * **유지 대상 선택보다 먼저 실행해야 한다.** 예약이 남아 있으면 그 예약에 묶인
 * 대기 딜러가 후보에서 빠져, 더 저렴한 조합을 두고 비싼 조합을 고르게 된다.
 * 긴급 축소 계획이 일반 교체 예약을 대체한다는 규칙의 실제 적용 지점이다.
 *
 * 대회 예약 테이블은 건드리지 않는다. 예약은 tournament.ts만 해제할 수 있다.
 * 이미 근무 중인 딜러의 배치는 바꾸지 않는다 — 해제하는 것은 "아직 투입되지 않은"
 * 예약(pendingDealerId)뿐이다.
 */
function cancelPendingDealerChanges(state: GameState): void {
  for (const table of state.tables) {
    if (isTournamentTable(state, table.id)) continue;
    if (table.status === 'remodelPrep') continue;
    delete table.pendingDealerId;
  }
}

/** 서비스 직원을 대기로 돌린다. 발동한 분부터 매분 멱등하게 적용한다. */
function standbyServiceStaff(state: GameState): void {
  for (const staff of state.staff) {
    if (staff.type === 'service' && staff.duty === 'working') {
      staff.duty = 'standby';
    }
  }
}

/** 축소가 끝났는가 (자금 조건 제외) */
function isDownsizeComplete(state: GameState, emergency: EmergencyState): boolean {
  if (emergency.keptTableId === null || emergency.keptDealerId === null) return false;

  const keptTable = findTable(state, emergency.keptTableId);
  const keptDealer = findStaff(state, emergency.keptDealerId);
  if (!keptTable || !keptDealer) return false;
  if (keptTable.status !== 'operating') return false;
  if (keptTable.dealerId !== keptDealer.id) return false;
  if (keptDealer.duty !== 'working' || keptDealer.assignedTableId !== keptTable.id) return false;

  // 대회가 남아 있으면 자원이 아직 묶여 있다.
  if (state.tournament !== null) return false;
  if (state.venue.lockedCash !== 0) return false;

  for (const table of state.tables) {
    if (table.id === keptTable.id) continue;
    if (table.status !== 'idle') return false;
    if (table.dealerId !== null) return false;
    if (hasActiveSessions(state, table.id)) return false;
  }

  for (const staff of state.staff) {
    if (staff.id === keptDealer.id) continue;
    if (staff.duty !== 'standby') return false;
    if (staff.assignedTableId !== null) return false;
  }

  return true;
}

/**
 * 종료 기준액 = 축소 완료 상태의 분당 반복 비용 x 240분.
 * 새 상수를 만들지 않고 기존 비용 계산에서 파생한다.
 * 현재 설정에서 일반 딜러 조합은 600G, 숙련 딜러 조합은 720G가 된다.
 */
export function recoveryThresholdUnits(state: GameState, config: EconomyConfig): Money {
  return minuteCosts(state, config).total * RECOVERY_RESERVE_MINUTES;
}

/**
 * 틱 9단계의 긴급 운영 처리.
 *
 * 순서가 규칙이다 (사용자 지정 §8).
 *   1) 일반 딜러 교체 예약 해제  <- 유지 대상 선택보다 반드시 먼저
 *   2) 서비스 직원 대기 전환
 *   3) 유지 대상 선택 (한 번 고르면 끝까지 유지)
 *   4) 유지 대상 활성화
 *   5) 나머지 일반 테이블 정리
 *   6) 단계 갱신과 복구 종료 판정
 *
 * 긴급 운영 중에는 이 처리가 일반 pendingDealerId 전환을 대신한다.
 * 대회 예약 자원은 어느 단계에서도 건드리지 않는다.
 */
export function processEmergency(
  state: GameState,
  config: EconomyConfig,
  events: EngineEvent[],
): void {
  const emergency = state.emergency;
  if (emergency === null) return;

  // 예약 해제가 선택보다 먼저다. 순서를 바꾸면 취소될 예약에 묶인 대기 딜러가
  // 후보에서 빠져 더 비싼 조합이 선택된다.
  cancelPendingDealerChanges(state);
  standbyServiceStaff(state);

  if (emergency.keptTableId === null) {
    const picked = selectKeptPair(state, config);
    if (picked) {
      emergency.keptTableId = picked.tableId;
      emergency.keptDealerId = picked.dealerId;
      events.push({
        type: 'emergencyKeptSelected',
        emergencyId: emergency.id,
        tableId: picked.tableId,
        dealerId: picked.dealerId,
      });
    }
  }

  activateKeptPair(state, emergency);
  downsizeOtherTables(state, emergency);

  const downsized = isDownsizeComplete(state, emergency);
  emergency.phase = downsized ? 'RECOVERING' : 'DOWNSIZING';

  if (!downsized) return;

  // 자금 조건: 비용 지급이 끝난 뒤의 사용 가능 현금이 4게임시간 운영비 이상.
  if (availableCash(state) < recoveryThresholdUnits(state, config)) return;

  events.push({
    type: 'emergencyEnded',
    emergencyId: emergency.id,
    atMinute: state.time.minute,
    totalSupportUnits: emergency.supportUnits,
  });
  // 기존 테이블·직원을 자동 재가동하지 않는다. 유지하던 1개 배치를 그대로 둔다.
  state.emergency = null;
}
