/**
 * 반복 비용 (Economy §5, §7).
 *
 * 핵심 항등식 (05 §4-1):
 *
 *   분당 차감 units = (시간당 비용 G) x MONEY_SCALE / 60
 *                   = (시간당 비용 G) x 60 / 60
 *                   = (시간당 비용 G)
 *
 * 즉 80G/시간짜리 급여는 정확히 80 units/분이다. 나눗셈도 반올림도 없다.
 * 이 항등식이 깨지지 않도록 MONEY_SCALE이 60이 아니면 즉시 예외를 던진다.
 */

import { MONEY_SCALE } from '../config/economy.js';
import type { EconomyConfig } from '../config/economy.js';
import { exactDiv } from './fixed.js';
import { isOnPayroll, paysFacilityCost } from './derive.js';
import type { GameState, Money } from './types.js';

/** 시간당 G -> 분당 units. 나누어떨어지지 않으면 예외. */
export function perMinuteUnits(goldPerHour: number): Money {
  return exactDiv(goldPerHour * MONEY_SCALE, 60, `분당 비용 환산(${goldPerHour}G/시간)`);
}

export interface MinuteCosts {
  readonly wage: Money;
  readonly facility: Money;
  readonly venue: Money;
  readonly total: Money;
}

/** 이번 1분의 반복 비용 */
export function minuteCosts(state: GameState, config: EconomyConfig): MinuteCosts {
  let wage = 0;
  for (const s of state.staff) {
    if (!isOnPayroll(s)) continue; // 대기 중 직원은 급여가 없다
    wage += perMinuteUnits(config.staff[s.type].wagePerHourGold);
  }

  let facility = 0;
  for (const t of state.tables) {
    if (paysFacilityCost(t)) {
      facility += perMinuteUnits(config.table.facilityCostPerHourGold);
    }
  }

  const venue = perMinuteUnits(config.venue.baseCostPerHourGold);

  return { wage, facility, venue, total: wage + facility + venue };
}

/**
 * 현재 배치 기준 시간당 운영비 (내부 단위).
 * 분당 비용 x 60. 새 상수를 만들지 않고 기존 비용 계산에서 파생한다.
 * 대회 예약의 운영 예비금 검사가 쓴다.
 */
export function hourlyOperatingCostUnits(state: GameState, config: EconomyConfig): Money {
  return minuteCosts(state, config).total * 60;
}
