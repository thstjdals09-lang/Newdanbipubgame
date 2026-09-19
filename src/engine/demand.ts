/**
 * 방문 수요 (Economy §3).
 *
 *   D = B x (1 + A/10) x (0.75 + 0.5 x S/100)      (게임 1시간당 명)
 *   매분 arrivalCarry += D / 60, 정수 부분만 신규 방문객으로 만든다.
 *
 * 부동소수를 쓰지 않는다. 공식 전체를 하나의 정수 분수로 계산한다 (05 §4-3).
 *
 *   NUM = baseMilli x (10000 + A_milli) x (150000 + S_milli)
 *   DEN = 1000 x 10000 x 200000 x 60 = 1.2e14
 *
 * 검증: B=3.5, A=0, S=80 -> NUM = 3500 x 10000 x 230000 = 8.05e12
 *       8.05e12 / 1.2e14 = 0.0670833/분 = 4.025/시간   (문서 값과 일치)
 */

import type { EconomyConfig } from '../config/economy.js';
import { assertSafeInteger, divRem } from './fixed.js';
import type { GameState } from './types.js';

/** 1000 (B) x 10000 (A항) x 200000 (S항) x 60 (분) */
export const ARRIVAL_DEN = 1000 * 10000 * 200000 * 60;

/** 고정 수요 실험용 분모: 1000 (milli) x 60 (분) */
export const FIXED_ARRIVAL_DEN = 1000 * 60;

/**
 * 이번 분의 도착 분자를 구한다.
 * 갱신 전 만족도와 현재 인지도를 쓴다 (Economy §6, §10-5).
 */
export function arrivalNumerator(state: GameState, config: EconomyConfig): number {
  if (config.fixedDemandMilliPerHour !== null) {
    return config.fixedDemandMilliPerHour;
  }
  const base = config.demand.baseByStageMilli[state.venue.stage];
  const num = base * (10000 + state.venue.awarenessMilli) * (150000 + state.venue.satisfactionMilli);
  return assertSafeInteger(num, 'demand.arrivalNumerator');
}

export function arrivalDenominator(config: EconomyConfig): number {
  return config.fixedDemandMilliPerHour !== null ? FIXED_ARRIVAL_DEN : ARRIVAL_DEN;
}

export interface ArrivalStep {
  readonly newGuests: number;
  readonly carry: number;
}

/**
 * 1분치 도착 계산. 나머지를 보존한다.
 * quotient * den + remainder === total 이 항상 성립하므로
 * 몇 분씩 끊어 계산해도 결과가 같다 (시간 분할 일관성).
 */
export function stepArrivals(state: GameState, config: EconomyConfig): ArrivalStep {
  const num = arrivalNumerator(state, config);
  const den = arrivalDenominator(config);
  const total = assertSafeInteger(num + state.time.arrivalCarry, 'demand.total');
  const { quotient, remainder } = divRem(total, den);
  return { newGuests: quotient, carry: remainder };
}
