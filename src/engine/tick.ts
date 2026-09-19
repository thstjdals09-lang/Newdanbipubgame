/**
 * 매분 처리 순서 (Economy §10).
 *
 *   1. 직전 경계에서 승인한 플레이어 명령을 순서대로 반영한다.
 *   2. 게임 시각을 1분 진행한다.
 *   3. 대회 시작 판정 / 종료 정산.                    <- 작업 B (미구현, 상태가 null임을 보장)
 *   4. 완료 시각에 도달한 일반 세션의 매출을 정산하고 좌석을 비운다.
 *   5. 갱신 전 만족도 및 현재 인지도로 수요를 계산하고 신규 방문 수를 누적한다.
 *   6. 대기 만료 -> 기존 대기 -> 신규 방문 순으로 착석. 잔여는 대기 또는 이탈.
 *   7. 서비스 품질·최근 이탈률·만족도를 갱신하고 세션 인지도 보상을 반영한다.
 *   8. 급여·시설비·운영비를 해당 1분만큼 차감한다.
 *   9. 해금·직원 배치 전환을 판정하고 상태를 저장 대상으로 만든다.
 *
 * 순서를 바꾸면 같은 조건의 재현 결과가 바뀌므로 rulesVersion을 올려야 한다.
 */

import { DEFAULT_CONFIG } from '../config/economy.js';
import type { EconomyConfig } from '../config/economy.js';
import { processCommands } from './commands.js';
import { minuteCosts } from './costs.js';
import { stepArrivals } from './demand.js';
import { installedTableCount } from './derive.js';
import { assertSafeInteger } from './fixed.js';
import { processSeating } from './seating.js';
import { recordWindow, stepSatisfaction } from './satisfaction.js';
import { assertInvariants, assertSupported, cloneState } from './state.js';
import type { Command, EngineEvent, GameState, TickResult } from './types.js';

/** 틱 9단계: 해금 판정. 같은 해금은 기록 ID로 한 번만 부여한다 (Progression §4). */
function processUnlocks(state: GameState, config: EconomyConfig, events: EngineEvent[]): void {
  const grant = (id: string, condition: boolean): void => {
    if (!condition) return;
    if (state.unlocks.some((u) => u.id === id)) return;
    state.unlocks.push({ id, grantedAtMinute: state.time.minute });
    events.push({ type: 'unlockGranted', id });
  };

  const tables = installedTableCount(state);

  grant('amenityUpgrade', tables >= config.amenity.unlockTableCount);
  grant('skilledDealerGrant', tables >= config.unlock.skilledDealerTableCount);
  grant(
    'smallTournament',
    tables >= config.unlock.smallTournamentTableCount &&
      state.venue.awarenessMilli >= config.unlock.smallTournamentAwarenessMilli,
  );
  // 특별 직원의 실제 지급은 작업 B다 (05 §2 D5). 여기서는 해금 기록만 남긴다.
}

/** 틱 9단계: 기존 세션이 모두 끝난 closing 테이블의 딜러 변경을 반영한다 (Economy §5). */
function applyPendingDealerChanges(state: GameState, events: EngineEvent[]): void {
  for (const table of state.tables) {
    if (table.status !== 'closing') continue;
    const busy = state.sessions.some((s) => !s.settled && s.tableId === table.id);
    if (busy) continue;

    const previous = table.dealerId;
    const next = table.pendingDealerId ?? null;

    if (previous !== null && previous !== next) {
      const old = state.staff.find((s) => s.id === previous);
      if (old) {
        old.assignedTableId = null;
        old.duty = 'standby';
      }
    }

    if (next !== null) {
      const incoming = state.staff.find((s) => s.id === next);
      if (!incoming) throw new Error(`배치 전환: 직원 ${next} 없음`);
      incoming.assignedTableId = table.id;
      incoming.duty = 'working';
      table.dealerId = next;
      table.status = 'operating';
    } else {
      table.dealerId = null;
      table.status = 'idle';
    }

    delete table.pendingDealerId;
    events.push({ type: 'dealerChangeApplied', tableId: table.id, dealerId: table.dealerId });
  }
}

/**
 * 게임 1분을 진행한다.
 *
 * **입력 상태를 수정하지 않는다.** 새 상태를 만들어 돌려준다.
 *
 * 제자리 수정이 더 빠르지만 쓰지 않는다. 호출자가 "진행 전" 상태를 잃으면
 * 투자 예상치가 비교 기준을 잃고, 저장 복원 테스트도 의미가 없어진다.
 * GDD §10이 요구하는 "예측과 실제가 같은 규칙"은 진행 전후를 나란히 놓고
 * 비교할 수 있을 때만 검증할 수 있다.
 */
export function tick(
  input: GameState,
  config: EconomyConfig = DEFAULT_CONFIG,
  commands: readonly Command[] = [],
): TickResult {
  assertSupported(input, config);
  const state = cloneState(input);
  const events: EngineEvent[] = [];

  // 1) 플레이어 명령
  processCommands(state, commands, config, events);

  // 2) 시각 진행
  state.time.minute += 1;

  // 3) 대회 — 작업 B. assertSupported가 tournament === null을 보장한다.

  // 4) 세션 정산. settled 플래그로 단일 정산을 보장한다.
  let completedThisMinute = 0;
  const remaining = [];
  for (const session of state.sessions) {
    if (session.settled) continue; // 방어적: 정산된 세션은 이미 제거된다
    if (session.endsAtMinute > state.time.minute) {
      remaining.push(session);
      continue;
    }
    session.settled = true;
    state.venue.cash = assertSafeInteger(state.venue.cash + session.revenueUnits, 'cash');
    state.records.totalRevenueUnits += session.revenueUnits;
    state.records.completedGuests += 1;
    completedThisMinute += 1;
    events.push({
      type: 'sessionCompleted',
      sessionId: session.id,
      revenueUnits: session.revenueUnits,
    });
  }
  state.sessions = remaining;

  // 5) 수요. 갱신 전 만족도와 현재 인지도를 쓴다.
  const arrival = stepArrivals(state, config);
  state.time.arrivalCarry = arrival.carry;

  // 6) 대기·착석
  const seating = processSeating(state, config, arrival.newGuests, events);

  // 7) 서비스 품질·이탈률·만족도, 그리고 세션 인지도 보상
  recordWindow(state, seating.arrivals, seating.abandons);
  const sat = stepSatisfaction(state, config);
  state.venue.satisfactionMilli = sat.satisfactionMilli;
  state.venue.satisfactionRemainder = sat.remainder;

  if (completedThisMinute > 0) {
    // 채택 R4: 인지도는 모든 경로에서 100을 넘지 않는다.
    state.venue.awarenessMilli = Math.min(
      config.demand.awarenessMaxMilli,
      state.venue.awarenessMilli + completedThisMinute * config.demand.awarenessPerSessionMilli,
    );
  }

  // 8) 반복 비용
  const costs = minuteCosts(state, config);
  state.venue.cash = assertSafeInteger(state.venue.cash - costs.total, 'cash');
  state.records.totalWageUnits += costs.wage;
  state.records.totalFacilityUnits += costs.facility;
  state.records.totalVenueCostUnits += costs.venue;

  if (state.venue.cash < 0) {
    // 긴급 축소 운영은 작업 B다. 조용히 0으로 자르지 않고 사실대로 알린다.
    events.push({ type: 'cashNegative', cash: state.venue.cash });
  }

  // 9) 해금·배치 전환
  processUnlocks(state, config, events);
  applyPendingDealerChanges(state, events);

  assertInvariants(state);
  return { state, events };
}

/** n분 진행. 중간 명령이 없을 때 쓴다. 입력 상태를 수정하지 않는다. */
export function tickMany(
  state: GameState,
  minutes: number,
  config: EconomyConfig = DEFAULT_CONFIG,
): GameState {
  if (!Number.isInteger(minutes) || minutes < 0) {
    throw new Error(`tickMany: 분이 올바르지 않음 (${minutes})`);
  }
  let current = state;
  for (let i = 0; i < minutes; i += 1) {
    current = tick(current, config).state;
  }
  return current;
}
