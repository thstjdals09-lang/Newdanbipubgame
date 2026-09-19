/**
 * 첫 리모델링 (작업 C-1, Progression §5·§6).
 *
 *   일반 영업 -> PREPARING -> (단일 전환 작업) -> 2단계 영업
 *
 * 이 모듈이 소유하는 범위:
 *   - 시작 자격 판정과 필요 현금 계산
 *   - 요청 트랜잭션 (비용 잠금 + 준비 상태 진입 + 대기 해산)
 *   - 9단계의 전환 (비용 정산 + 단계 변경 + 자산 보존)
 *
 * **별도의 경제 계산 엔진을 만들지 않는다.** 필요 현금은 기존 minuteCosts에서 파생한다.
 *
 * 범위 밖: 화면·연출, 오프라인 환산, 중규모 대회, 리모델링 투자 예상치.
 */

import { gold } from '../config/economy.js';
import type { EconomyConfig, Stage } from '../config/economy.js';
import { lock, settleLocked } from './cash.js';
import { minuteCosts } from './costs.js';
import { availableCash } from './derive.js';
import type {
  CommandResult,
  EngineEvent,
  GameState,
  Money,
  RejectReason,
  RemodelCompletionRecord,
  RemodelState,
} from './types.js';

const ok: CommandResult = { ok: true };
const no = (reason: RejectReason, detail?: string): CommandResult =>
  detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };

/** 2단계 도달로 열리는 두 번째 테마 해금 ID (Progression §4). */
export const SECOND_THEME_UNLOCK_ID = 'secondTheme';

/** 리모델링이 가능한 출발 단계와 도착 단계 */
const FROM_STAGE: Stage = 1;
const TO_STAGE: Stage = 2;

/** 현재 일반 세션이 모두 끝날 때까지의 최대 잔여 게임시간 (Progression §5의 T) */
export function drainHours(state: GameState): number {
  let maxEnd = state.time.minute;
  for (const s of state.sessions) {
    if (s.settled) continue;
    if (s.endsAtMinute > maxEnd) maxEnd = s.endsAtMinute;
  }
  return Math.ceil((maxEnd - state.time.minute) / 60);
}

/**
 * 필요 현금 (Progression §5).
 *
 *   필요 현금 = 15000 + T x C_before + 4 x C_after
 *
 * 정리 기간에 배치가 바뀌지 않으므로 C_before와 C_after는 같은 값이며,
 * 이는 동시에 "정리 동안 발생할 시간당 비용의 보수적인 상한"이기도 하다.
 * 정리 기간에 발생할 매출을 조건 충족 자금으로 미리 계산하지 않는다.
 */
export interface RemodelCostBreakdown {
  readonly costUnits: Money;
  readonly drainHours: number;
  readonly hourlyCostUnits: Money;
  readonly drainCostUnits: Money;
  readonly reserveUnits: Money;
  readonly requiredUnits: Money;
}

export function remodelCostBreakdown(
  state: GameState,
  config: EconomyConfig,
): RemodelCostBreakdown {
  const costUnits = gold(config.remodel.costGold);
  const hours = drainHours(state);
  const hourlyCostUnits = minuteCosts(state, config).total * 60;
  const drainCostUnits = hourlyCostUnits * hours;
  const reserveUnits = hourlyCostUnits * config.remodel.reserveHours;

  return {
    costUnits,
    drainHours: hours,
    hourlyCostUnits,
    drainCostUnits,
    reserveUnits,
    requiredUnits: costUnits + drainCostUnits + reserveUnits,
  };
}

export interface RemodelPlan {
  readonly fromStage: Stage;
  readonly toStage: Stage;
  readonly cost: RemodelCostBreakdown;
}

/**
 * 시작 자격 판정. **상태를 수정하지 않는다.**
 *
 * 조건 (Progression §5):
 *   1. 1단계 매장에서 테이블 6개 설치 (미운영 포함)
 *   2. 인지도 50 이상
 *   3. 소규모 대회 정상 완료 2회 이상
 *   4. 예약·정리·진행 상태의 대회 없음
 *   5. 리모델링 비용 + 정리 비용 + 전환 후 예비금 확보
 *
 * **딜러 6명은 조건이 아니다** (GDD §8, Progression P07).
 * 근무 딜러가 3명이어도 다른 조건이 맞으면 통과해야 한다.
 *
 * 긴급 운영 중 금지는 commands.ts의 EMERGENCY_ACTIVE 관문이 담당한다.
 *
 * 추가 전제: 아직 반영되지 않은 딜러 교체 예약이 없어야 한다.
 * Progression §6이 "기존 직원 배치를 유지한다"고 했는데, 준비 중에 교체가
 * 반영되면 그 약속이 깨진다. 취소 메커니즘을 새로 만드는 대신 시작 시점에 막는다.
 */
export function planRemodel(
  state: GameState,
  config: EconomyConfig,
): { readonly result: CommandResult; readonly plan?: RemodelPlan } {
  if (state.remodel !== null) {
    return { result: no('REMODEL_ACTIVE', `이미 진행 중인 리모델링 ${state.remodel.id}`) };
  }
  if (state.venue.stage !== FROM_STAGE) {
    return {
      result: no(
        'REMODEL_STAGE_NOT_ELIGIBLE',
        `${FROM_STAGE}단계에서만 리모델링할 수 있다. 현재 ${state.venue.stage}단계`,
      ),
    };
  }
  if (state.records.completedRemodels.length > 0) {
    return { result: no('REMODEL_ALREADY_DONE') };
  }

  const requiredTables = config.table.capByStage[FROM_STAGE];
  if (state.tables.length < requiredTables) {
    return {
      result: no(
        'REMODEL_TABLES_REQUIRED',
        `테이블 ${requiredTables}개 설치 필요. 현재 ${state.tables.length}개 (미운영 포함)`,
      ),
    };
  }

  if (state.venue.awarenessMilli < config.remodel.requiredAwarenessMilli) {
    return {
      result: no(
        'REMODEL_AWARENESS_REQUIRED',
        `인지도 ${config.remodel.requiredAwarenessMilli / 1000} 필요. ` +
          `현재 ${state.venue.awarenessMilli / 1000}`,
      ),
    };
  }

  const smallDone = state.records.completedTournaments.filter((c) => c.scale === 'small').length;
  if (smallDone < config.remodel.requiredSmallTournaments) {
    return {
      result: no(
        'REMODEL_TOURNAMENTS_REQUIRED',
        `소규모 대회 정상 완료 ${config.remodel.requiredSmallTournaments}회 필요. 현재 ${smallDone}회`,
      ),
    };
  }

  if (state.tournament !== null) {
    return {
      result: no(
        'REMODEL_TOURNAMENT_ACTIVE',
        `대회 ${state.tournament.id}(${state.tournament.phase})가 남아 있다 (P08)`,
      ),
    };
  }

  const pending = state.tables.find((t) => t.pendingDealerId !== undefined);
  if (pending) {
    return {
      result: no(
        'REMODEL_DEALER_CHANGE_PENDING',
        `테이블 ${pending.id}에 반영되지 않은 딜러 교체 예약이 있다. ` +
          '먼저 반영된 뒤에 요청해야 기존 배치를 그대로 보존할 수 있다.',
      ),
    };
  }

  const cost = remodelCostBreakdown(state, config);
  const available = availableCash(state);
  if (cost.requiredUnits > available) {
    // 비용 자체를 못 내는 경우와 예비금이 모자란 경우를 사유로 구분한다.
    const reason: RejectReason =
      cost.costUnits > available ? 'INSUFFICIENT_CASH' : 'REMODEL_RESERVE_SHORTFALL';
    return {
      result: no(
        reason,
        `필요 ${cost.requiredUnits / 60}G ` +
          `(비용 ${cost.costUnits / 60}G + 정리 ${cost.drainCostUnits / 60}G` +
          ` + 예비금 ${cost.reserveUnits / 60}G), 사용 가능 ${available / 60}G`,
      ),
    };
  }

  return { result: ok, plan: { fromStage: FROM_STAGE, toStage: TO_STAGE, cost } };
}

/**
 * 요청 적용. planRemodel이 통과한 plan만 받는다.
 *
 * 부분 적용을 남기지 않기 위해 예외를 던질 수 있는 lock()을 가장 먼저 호출한다.
 * lock이 실패하면 아무것도 바뀌지 않은 상태로 예외가 올라간다.
 */
export function applyRemodelRequest(
  state: GameState,
  plan: RemodelPlan,
  events: EngineEvent[],
): RemodelState {
  // 1) 비용 잠금. cash는 줄지 않고 lockedCash만 는다 (05 §3).
  lock(state, plan.cost.costUnits);

  // 2) 작업 레코드
  const id = `RM${state.records.nextRemodelSeq}`;
  state.records.nextRemodelSeq += 1;

  const remodel: RemodelState = {
    id,
    phase: 'PREPARING',
    startedAtMinute: state.time.minute,
    costUnits: plan.cost.costUnits,
    fromStage: plan.fromStage,
    toStage: plan.toStage,
  };
  state.remodel = remodel;

  // 3) 대기 손님 해산 (Progression §6).
  //    공사 안내에 따른 해산이므로 서비스 불만이 아니다.
  //    방문·이탈 통계에 아무 기록도 추가하지 않는다.
  const dissolved = state.queue.length;
  state.queue = [];
  if (dissolved > 0) {
    events.push({ type: 'remodelQueueDissolved', remodelId: id, guests: dissolved });
  }

  events.push({
    type: 'remodelRequested',
    remodelId: id,
    costUnits: remodel.costUnits,
    atMinute: state.time.minute,
  });

  return remodel;
}

/** 공사 중인가. 착석·수요·만족도·명령 판정이 공유하는 단일 기준. */
export function isRemodelPreparing(state: GameState): boolean {
  return state.remodel !== null && state.remodel.phase === 'PREPARING';
}

/**
 * 틱 9단계의 리모델링 처리.
 *
 * 모든 일반 세션이 정산되면 **하나의 전환 작업**으로 2단계 매장을 확정한다.
 * 세션 정산은 4단계이므로, 마지막 세션이 분 M에 정산되면 전환도 분 M에 일어난다.
 * 2단계 수요는 5단계에서 계산되므로 자연히 **다음 분부터** 적용된다 (Progression §6).
 *
 * 보존 대상: 테이블·직원의 기존 ID와 배치, 시설 레벨, 현금, 인지도, 만족도,
 * 직원 보상 지급 기록, 대회 실적·개최권, 홍보 대기 시간, 게임 시각.
 *
 * 설치 지점: 1단계의 지점 1~6은 2단계 1층의 같은 지점이므로 재매핑이 필요 없다.
 * 2층 지점 7~18은 capByStage[2]가 열어 주며 테이블을 무료로 추가하지 않는다.
 */
export function processRemodel(
  state: GameState,
  config: EconomyConfig,
  events: EngineEvent[],
): void {
  const remodel = state.remodel;
  if (remodel === null) return;
  if (remodel.phase !== 'PREPARING') return;

  // 착석 중인 손님은 정상 세션을 끝내고 정해진 매출을 발생시킨다.
  if (state.sessions.some((s) => !s.settled)) return;

  if (state.records.completedRemodels.some((c) => c.id === remodel.id)) {
    throw new Error(`리모델링 ${remodel.id}: 이미 완료 기록이 있는 작업을 다시 전환하려 했다`);
  }

  // 1) 잠긴 비용을 지출로 확정한다. 정확히 한 번. spend()를 다시 부르지 않는다.
  settleLocked(state, remodel.costUnits, `remodel:${remodel.id}:cost`);

  // 2) 단계 전환. 테이블·직원은 ID·배치 그대로 둔다.
  //    capByStage / baseByStageMilli / capacityByStage가 stage를 참조하므로
  //    테이블 상한 6->18, 기본 수요 3.5->6, 대기 정원 8->16이 함께 따라온다.
  state.venue.stage = remodel.toStage;

  // 3) 완료 기록. 같은 ID를 다시 처리해 비용·해금이 중복되지 않게 한다.
  const record: RemodelCompletionRecord = {
    id: remodel.id,
    fromStage: remodel.fromStage,
    toStage: remodel.toStage,
    startedAtMinute: remodel.startedAtMinute,
    completedAtMinute: state.time.minute,
    costUnits: remodel.costUnits,
    preservedTableIds: state.tables.map((t) => t.id),
    preservedStaffIds: state.staff.map((s) => s.id),
  };
  state.records.completedRemodels.push(record);
  state.remodel = null;

  events.push({
    type: 'remodelCompleted',
    remodelId: record.id,
    atMinute: record.completedAtMinute,
    fromStage: record.fromStage,
    toStage: record.toStage,
    costUnits: record.costUnits,
  });
}
