/**
 * 파생값.
 *
 * 처리 능력은 절대 저장하지 않는다. 항상 테이블의 실제 상태에서 계산한다.
 * (Economy §2 "각 테이블의 상태에서 운영 좌석을 계산", Progression P02 "허위 처리 능력 증가 없음")
 */

import type { EconomyConfig } from '../config/economy.js';
import type { GameState, Money, StaffState, TableState } from './types.js';

/** 사용 가능 현금 = cash - lockedCash (05 §3) */
export function availableCash(state: GameState): Money {
  return state.venue.cash - state.venue.lockedCash;
}

export function findStaff(state: GameState, id: string): StaffState | undefined {
  return state.staff.find((s) => s.id === id);
}

export function findTable(state: GameState, id: string): TableState | undefined {
  return state.tables.find((t) => t.id === id);
}

/**
 * 이 테이블이 일반 영업으로 신규 손님을 받을 수 있는가.
 *
 * 긴급 축소 운영 중에는 유지 대상으로 고른 테이블 하나만 받는다 (Economy §11).
 * 대상이 아직 정해지지 않았으면 어떤 테이블도 받지 않는다.
 *
 * 대회가 끝나 테이블이 operating으로 돌아와도 이 제한이 먼저 걸린다.
 * 비용 계산은 이 제한과 무관하게 정리·대회 자원의 비용을 정상 부과한다.
 */
export function canSeatNewGuests(state: GameState, table: TableState): boolean {
  if (table.status !== 'operating') return false;
  const emergency = state.emergency;
  if (emergency === null) return true;
  return emergency.keptTableId === table.id;
}

/** 상태와 무관한 테이블 자체의 영업 상태. 비용·집계용. */
export function acceptsNewGuests(table: TableState): boolean {
  return table.status === 'operating';
}

/** 시설비를 내는 상태인가 (Economy §5: 빈 미운영 테이블은 시설비 없음) */
export function paysFacilityCost(table: TableState): boolean {
  return (
    table.status === 'operating' ||
    table.status === 'closing' ||
    table.status === 'tournamentHeld' ||
    table.status === 'remodelPrep'
  );
}

/**
 * 테이블의 세션 시간 (게임 분).
 *   ceil(기본 시간 / 딜러 속도 배율)
 * 일반 1.0 -> 120, 숙련 1.2 -> 100 (Economy §4)
 */
export function sessionMinutesFor(
  state: GameState,
  table: TableState,
  config: EconomyConfig,
): number {
  const dealer = table.dealerId ? findStaff(state, table.dealerId) : undefined;
  if (!dealer) throw new Error(`세션 시간 계산: 테이블 ${table.id}에 딜러가 없음`);
  const speedMilli = config.staff[dealer.type].tableSpeedMilli;
  if (speedMilli <= 0) throw new Error(`세션 시간 계산: ${dealer.type}은 테이블 담당 불가`);
  return Math.ceil((config.time.baseSessionMinutes * 1000) / speedMilli);
}

/** 운영 중인 테이블 수 */
export function operatingTableCount(state: GameState): number {
  return state.tables.filter((t) => t.status === 'operating').length;
}

/**
 * 운영 좌석 수 = 신규 손님을 받을 수 있는 테이블의 전체 좌석 (GDD §4).
 * 긴급 운영 중에는 유지 대상 한 곳만 센다.
 */
export function operatingSeats(state: GameState, config: EconomyConfig): number {
  return state.tables.filter((t) => canSeatNewGuests(state, t)).length * config.table.seats;
}

/**
 * 시간당 이론 처리 능력 x1000.
 *   Sigma(운영 테이블의 좌석 x 60 / 세션 시간)
 * 일반 딜러 테이블 = 4000, 숙련 = 4800 (Economy §4)
 */
export function theoreticalCapacityMilli(state: GameState, config: EconomyConfig): number {
  let total = 0;
  for (const table of state.tables) {
    // 긴급 운영 중에는 실제로 손님을 받을 수 있는 테이블만 센다.
    // 표시된 처리 능력과 착석 가능 좌석이 어긋나지 않게 한다.
    if (!canSeatNewGuests(state, table)) continue;
    const minutes = sessionMinutesFor(state, table, config);
    total += Math.floor((config.table.seats * 60 * 1000) / minutes);
  }
  return total;
}

/** 현재 일반 영업 중 착석 인원 (Economy §6의 O) */
export function seatedGuests(state: GameState): number {
  return state.sessions.filter((s) => !s.settled).length;
}

/** 서비스 수용 기준 = 8 + 16 x 근무 서비스 직원 수 (Economy §6) */
export function serviceCapacity(state: GameState, config: EconomyConfig): number {
  let cap = config.satisfaction.baseServiceCapacity;
  for (const s of state.staff) {
    if (s.type === 'service' && s.duty === 'working') {
      cap += config.staff.service.serviceCapacityBonus;
    }
  }
  return cap;
}

/**
 * 시간당 방문 수요 x1000.
 *   D = B x (1 + A/10) x (0.75 + 0.5 x S/100)
 * 표시·설명용. 실제 도착 누적은 demand.ts가 정수 분수로 처리한다.
 */
export function demandPerHourMilli(state: GameState, config: EconomyConfig): number {
  if (config.fixedDemandMilliPerHour !== null) return config.fixedDemandMilliPerHour;
  const base = config.demand.baseByStageMilli[state.venue.stage];
  const num = base * (10000 + state.venue.awarenessMilli) * (150000 + state.venue.satisfactionMilli);
  // base는 이미 x1000이므로 나머지 분모만 나눈다.
  return Math.floor(num / (10000 * 200000));
}

/** 설치된 테이블 수 (미운영 포함 — Progression §5) */
export function installedTableCount(state: GameState): number {
  return state.tables.length;
}

/** n번째 테이블의 가격 (Progression §3) */
export function tablePriceGold(index: number, config: EconomyConfig): number {
  const table = config.table;
  const listed = table.priceGoldByIndex[index];
  if (listed !== undefined) return listed;

  const f = table.priceFormula;
  if (index < f.fromIndex) {
    throw new Error(`테이블 가격: ${index}번째 가격이 표에도 공식에도 없음`);
  }
  // ceil(base x growth^(n-7) / roundTo) x roundTo
  // growthMilli^power가 배정도 안전 정수를 넘으므로 BigInt로 정확히 계산한다.
  // (18번째는 growth^11 = 1.79e34)
  const power = BigInt(index - (f.fromIndex - 1));
  const num = BigInt(f.baseGold) * BigInt(f.growthMilli) ** power;
  const den = 1000n ** power * BigInt(f.roundToGold);
  const steps = (num + den - 1n) / den; // 올림 나눗셈
  return Number(steps) * f.roundToGold;
}

/** 다음 테이블을 살 수 있는가 (단계별 상한) */
export function canInstallMoreTables(state: GameState, config: EconomyConfig): boolean {
  return state.tables.length < config.table.capByStage[state.venue.stage];
}

/** 대기 중인 직원 (급여 없음 — Economy §5) */
export function isOnPayroll(staff: StaffState): boolean {
  return staff.duty === 'working';
}
