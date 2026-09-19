/**
 * 서비스 품질·이탈률·만족도 (Economy §6).
 *
 *   서비스 수용 기준 = 8 + 16 x 근무 서비스 직원 수
 *   Q = min(100, 100 x 기준 / max(8, O))
 *   L = 최근 6게임시간 이탈 / 같은 기간 신규 방문        (방문 0이면 0 — 채택 R5)
 *   T = clamp(80 + 3 x 편의시설 + 0.15 x (Q-100) - 10 x L, 40, 95)
 *   S_next = S + (T - S) x (1 - exp(-1/360))
 *
 * 감쇠는 정수 분수 + 나머지 보존으로 계산한다. 반올림으로 버리지 않는다 (05 §4-2).
 */

import type { EconomyConfig } from '../config/economy.js';
import { clamp, divRem } from './fixed.js';
import { seatedGuests, serviceCapacity } from './derive.js';
import type { GameState } from './types.js';

/**
 * k = 1 - exp(-1/360) 를 10^-9 자리까지 고정한 값.
 *
 *   1/360           = 0.002777777777...
 *   exp(-1/360)     = 0.997226076677...
 *   k               = 0.002773923322...
 *   k x 1e9         = 2773923.32...  ->  2773923
 *
 * 고정 상수를 썼다는 사실만으로 결정론이 확보되는 것은 아니므로
 * 시간 분할·저장 복원 테스트로 확인한다 (05 §4-5).
 */
export const SAT_K_NUM = 2_773_923;
export const SAT_K_DEN = 1_000_000_000;

/** 서비스 품질 Q x1000. 상한 100.000 */
export function qualityMilli(state: GameState, config: EconomyConfig): number {
  const capacity = serviceCapacity(state, config);
  const occupied = Math.max(config.satisfaction.baseServiceCapacity, seatedGuests(state));
  return Math.min(100_000, Math.floor((100_000 * capacity) / occupied));
}

/**
 * 이탈률 L x1000 (0 ~ 1000).
 * 채택 R5: 윈도우 안에 방문 기록이 없으면 0.
 */
export function abandonRateMilli(state: GameState): number {
  const { sumArrivals, sumAbandons } = state.window;
  if (sumArrivals <= 0) return 0;
  return Math.min(1000, Math.floor((1000 * sumAbandons) / sumArrivals));
}

/** 목표 만족도 T x1000 */
export function targetSatisfactionMilli(state: GameState, config: EconomyConfig): number {
  const cfg = config.satisfaction;
  const qMilli = qualityMilli(state, config);

  // 0.15 x (Q - 100), milli 단위
  const qTerm = Math.floor((cfg.qualityWeightNum * (qMilli - 100_000)) / cfg.qualityWeightDen);

  // 10 x L, milli 단위. abandonRateMilli는 x1000이므로 x10 하면 그대로 milli가 된다.
  const lTerm = Math.floor((cfg.abandonPenaltyMilli * abandonRateMilli(state)) / 1000);

  const raw =
    cfg.targetBaseMilli + cfg.amenityBonusPerLevelMilli * state.venue.amenityLevel + qTerm - lTerm;

  return clamp(raw, config.demand.satisfactionMinMilli, config.demand.satisfactionMaxMilli);
}

export interface SatisfactionStep {
  readonly satisfactionMilli: number;
  readonly remainder: number;
}

/**
 * 만족도 1분 갱신.
 *
 * 내림 + 나머지 보존이므로 누적 오차가 영구히 1 milli 미만이다.
 * 음수 변화에도 floor를 쓰므로 부호에 따라 거동이 갈리지 않는다.
 */
export function stepSatisfaction(state: GameState, config: EconomyConfig): SatisfactionStep {
  const target = targetSatisfactionMilli(state, config);
  const diff = target - state.venue.satisfactionMilli;

  const total = diff * SAT_K_NUM + state.venue.satisfactionRemainder;
  const { quotient, remainder } = divRem(total, SAT_K_DEN);

  const next = clamp(
    state.venue.satisfactionMilli + quotient,
    config.demand.satisfactionMinMilli,
    config.demand.satisfactionMaxMilli,
  );

  return { satisfactionMilli: next, remainder };
}

/**
 * 이탈률 윈도우 갱신.
 * 분 m의 기록을 슬롯 (m % 길이)에 쓴다. 그 슬롯에 있던 분 m-360의 기록을 합계에서 뺀다.
 * 빈 슬롯은 0이므로 시작 직후에도 별도 처리가 필요 없다 (채택 R5).
 */
export function recordWindow(state: GameState, arrivals: number, abandons: number): void {
  const w = state.window;
  const slot = state.time.minute % w.arrivals.length;

  w.sumArrivals -= w.arrivals[slot] ?? 0;
  w.sumAbandons -= w.abandons[slot] ?? 0;

  w.arrivals[slot] = arrivals;
  w.abandons[slot] = abandons;

  w.sumArrivals += arrivals;
  w.sumAbandons += abandons;
}
