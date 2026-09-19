/**
 * 홀덤펍 타이쿤 — 경제 엔진 (작업 A).
 *
 * 화면·오디오·타이머·난수에 의존하지 않는다.
 * 현실 시각 환산은 이 엔진 밖의 책임이다 (05 채택기록 v1 §1).
 */

export * from './types.js';
export * from './fixed.js';
export * from './state.js';
export * from './derive.js';
export * from './demand.js';
export * from './seating.js';
export * from './satisfaction.js';
export * from './costs.js';
export * from './cash.js';
export * from './commands.js';
export * from './tick.js';
export * from './forecast.js';

export {
  DEFAULT_CONFIG,
  RULES_VERSION,
  SAVE_VERSION,
  MONEY_SCALE,
  gold,
  milli,
} from '../config/economy.js';
export type {
  EconomyConfig,
  StaffSpec,
  StaffType,
  DealerType,
  Stage,
  TournamentSpec,
} from '../config/economy.js';
