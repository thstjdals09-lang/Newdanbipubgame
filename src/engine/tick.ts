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
 *   8. 급여·시설비·운영비를 해당 1분만큼 차감한다. 부족하면 긴급 지원 후 차감한다.
 *   9. 해금·특별 직원 지급·(긴급 축소 또는 배치 전환)·리모델링 전환을 판정한다.
 *
 * 순서를 바꾸면 같은 조건의 재현 결과가 바뀌므로 rulesVersion을 올려야 한다.
 */

import { DEFAULT_CONFIG } from '../config/economy.js';
import type { EconomyConfig, StaffType } from '../config/economy.js';
import { processCommands } from './commands.js';
import { applyMinuteCostsWithSupport, processEmergency } from './emergency.js';
import { stepArrivals } from './demand.js';
import { installedTableCount } from './derive.js';
import { assertSafeInteger } from './fixed.js';
import { processSeating } from './seating.js';
import { recordWindow, stepSatisfaction } from './satisfaction.js';
import {
  assertCashIntegrity,
  assertInvariants,
  assertRequiredStateFields,
  assertSupported,
  cloneState,
} from './state.js';
import { SECOND_THEME_UNLOCK_ID, isRemodelPreparing, processRemodel } from './remodel.js';
import { processTournament } from './tournament.js';
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
  // 2단계 도달로 두 번째 테마가 열린다 (Progression §4).
  // 조건으로 판정하므로 리모델링 전환 코드가 따로 부여하지 않아도 되고,
  // 기존 ID 검사가 중복 부여를 막는다.
  grant(SECOND_THEME_UNLOCK_ID, state.venue.stage >= 2);
}

/**
 * 특별 직원 지급 마커 (작업 B-2B).
 *
 * **해금 기록과 지급 기록을 분리한다.**
 *   skilledDealerGrant           자격 도달 기록. B-1부터 있었고 직원을 만들지 않았다.
 *   skilledDealerAwarded         직원을 실제로 지급했다는 증거. 아래에서만 붙인다.
 *
 * 기존 v3 저장본에는 자격 기록만 있고 직원이 없을 수 있다. 자격 기록을 지급의
 * 증거로 쓰면 그 저장본이 보상을 영영 못 받는다. 그래서 별도 ID를 쓴다.
 *
 * 마커를 unlocks 배열에 담으므로 새 영속 필드가 필요 없고 saveVersion도 오르지 않는다.
 */
export const SKILLED_DEALER_REWARD_ID = 'skilledDealerAwarded';
export const TOURNAMENT_SPECIALIST_REWARD_ID = 'tournamentSpecialistAwarded';

/**
 * 틱 9단계: 특별 직원 지급 (Economy §5, Progression §4).
 *
 *   숙련 딜러       테이블 3개 설치 -> 1명
 *   대회 전문 딜러  소규모 대회 1회 정상 완료 -> 1명
 *
 * 둘 다 **대기(standby) 상태, 미배치**로 만든다. 기존 딜러를 교체하거나
 * 자동 배치하지 않는다. 배치는 플레이어가 기존 assignDealer로 한다.
 * 대기 직원은 급여가 없다 (Economy §5).
 *
 * 조건은 상태에서 직접 본다. 해금 기록이 아니라 조건 자체를 보므로
 * 기록만 있고 직원을 못 받은 기존 저장본도 다음 틱에 정확히 한 번 받는다.
 *
 * 9단계는 8단계(비용 차감)와 3단계(대회 처리)보다 뒤다. 따라서 이번 분에
 * 새로 생긴 직원이 이미 시작된 세션이나 대회에 영향을 주지 않는다.
 */
function processStaffRewards(
  state: GameState,
  config: EconomyConfig,
  events: EngineEvent[],
): void {
  const award = (rewardId: string, eligible: boolean, type: StaffType): void => {
    if (!eligible) return;
    if (state.unlocks.some((u) => u.id === rewardId)) return; // 이미 지급했다

    const id = `S${state.records.nextStaffSeq}`;
    state.records.nextStaffSeq += 1;
    state.staff.push({ id, type, duty: 'standby', assignedTableId: null });
    state.unlocks.push({ id: rewardId, grantedAtMinute: state.time.minute });
    events.push({ type: 'staffGranted', staffId: id, staffType: type, rewardId });
  };

  award(
    SKILLED_DEALER_REWARD_ID,
    installedTableCount(state) >= config.unlock.skilledDealerTableCount,
    'skilled',
  );

  // "첫 소규모 대회 완료" (Economy §5). 완료 기록에서 직접 확인하므로
  // 이후 대회가 몇 번 더 끝나도 마커가 이미 있어 두 번 지급되지 않는다.
  award(
    TOURNAMENT_SPECIALIST_REWARD_ID,
    state.records.completedTournaments.some((c) => c.scale === 'small'),
    'tournament',
  );
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
  // 손상된 입력을 지원금·매출·복제가 가리기 전에 먼저 거절한다.
  // 복제 전에 검사하므로 거절 시 호출자의 상태는 그대로다.
  assertRequiredStateFields(input);
  assertSupported(input, config);
  assertCashIntegrity(input);
  const state = cloneState(input);
  const events: EngineEvent[] = [];

  // 1) 플레이어 명령
  processCommands(state, commands, config, events);

  // 2) 시각 진행
  state.time.minute += 1;

  // 3) 대회 처리: 종료 정산 -> 시작 -> 준비 완료 판정 (B-1 + B-2A).
  //    Economy §10이 지정한 자리를 그대로 지킨다. 4단계 세션 정산보다 앞이므로
  //    마지막 일반 세션이 분 M에 정산되면 준비 완료는 분 M+1에 확인되고,
  //    그 대회의 시작은 다시 그다음 3단계 평가에서 일어난다.
  processTournament(state, config, events);

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
  //    리모델링 공사 중에는 신규 방문 생성을 멈춘다 (Progression §6).
  //    누적값도 함께 멈춘다. 계속 쌓으면 공사가 끝나는 순간 손님이 몰려나온다.
  const arrival = isRemodelPreparing(state)
    ? { newGuests: 0, carry: state.time.arrivalCarry }
    : stepArrivals(state, config);
  state.time.arrivalCarry = arrival.carry;

  // 6) 대기·착석
  const seating = processSeating(state, config, arrival.newGuests, events);

  // 7) 서비스 품질·이탈률·만족도, 그리고 세션 인지도 보상
  //    공사 중에도 윈도우에는 이번 분의 사실(방문 0, 이탈 0)을 그대로 기록한다.
  //    해산한 대기 손님을 이탈로 넣지 않으며 허위 방문 기록도 만들지 않는다.
  recordWindow(state, seating.arrivals, seating.abandons);
  if (!isRemodelPreparing(state)) {
    // 만족도는 공사 기간 고정한다 (Progression §6).
    const sat = stepSatisfaction(state, config);
    state.venue.satisfactionMilli = sat.satisfactionMilli;
    state.venue.satisfactionRemainder = sat.remainder;
  }

  if (completedThisMinute > 0) {
    // 채택 R4: 인지도는 모든 경로에서 100을 넘지 않는다.
    state.venue.awarenessMilli = Math.min(
      config.demand.awarenessMaxMilli,
      state.venue.awarenessMilli + completedThisMinute * config.demand.awarenessPerSessionMilli,
    );
  }

  // 8) 반복 비용. 자기 자금으로 못 내면 부족액만 지원하고 긴급 운영에 진입한다 (B-3).
  //    비용 확정 -> 부족액 지원 -> 1회 차감 순서를 emergency.ts가 보장한다.
  //    발동한 분의 비용을 줄이려고 배치를 소급 변경하지 않는다.
  applyMinuteCostsWithSupport(state, config, events);

  if (state.venue.cash < 0) {
    // 지원이 정상 동작하면 도달하지 않는다. 방어적으로 사실대로 알린다.
    events.push({ type: 'cashNegative', cash: state.venue.cash });
  }

  // 9) 해금·보상·배치 전환
  processUnlocks(state, config, events);
  processStaffRewards(state, config, events);

  if (state.emergency !== null) {
    // 긴급 운영 중에는 축소 계획이 일반 pendingDealerId 전환을 대신한다.
    // 두 소유자가 같은 테이블을 동시에 건드리지 않게 한 쪽만 실행한다.
    // 리모델링 공사 중이면 processEmergency가 축소를 유예한다 (C-1).
    state.records.emergencyMinutes += 1;
    processEmergency(state, config, events);
  } else if (state.remodel === null) {
    // 공사 중에는 기존 배치를 그대로 유지한다. 배치 전환도 멈춘다.
    // (요청 시점에 대기 중인 교체 예약이 없음을 planRemodel이 보장한다.)
    applyPendingDealerChanges(state, events);
  }

  // 리모델링 전환은 9단계의 마지막이다.
  // 세션 정산(4단계)이 끝난 같은 분에 전환되고, 2단계 수요는 다음 분 5단계부터 적용된다.
  // 긴급 축소보다 뒤에 두어, 공사가 끝난 뒤의 유예 축소가 같은 분에 겹치지 않게 한다.
  processRemodel(state, config, events);

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
