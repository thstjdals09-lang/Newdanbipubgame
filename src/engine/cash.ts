/**
 * 현금과 잠금 금액 (05 채택기록 v1 §3).
 *
 *   cash        잠긴 금액을 포함한 총보유현금
 *   lockedCash  cash 중 사용할 수 없는 금액
 *   사용 가능   cash - lockedCash
 *
 * 처리 규칙:
 *   예약  -> lockedCash만 증가. cash는 변하지 않는다.
 *   정산  -> cash 감소와 lockedCash 감소를 각각 한 번씩.
 *   해제  -> lockedCash만 감소. cash는 변하지 않는다.
 *
 * 대회 예약·정산 자체는 작업 B다. 여기서는 그 원시 연산과 준비비 계산만
 * 제공하고, 이중 차감·잠금 중복 사용을 막는 검사를 건다.
 */

import { gold } from '../config/economy.js';
import type { EconomyConfig, TournamentSpec } from '../config/economy.js';
import { assertSafeInteger } from './fixed.js';
import { availableCash } from './derive.js';
import type { GameState, LedgerEntry, Money } from './types.js';

export function spend(
  state: GameState,
  amountUnits: Money,
  purpose: string,
  kind: LedgerEntry['kind'] = 'oneOff',
): void {
  if (amountUnits < 0) throw new Error(`지출액이 음수: ${amountUnits}`);
  if (amountUnits > availableCash(state)) {
    throw new Error(
      `사용 가능 현금 초과: 필요 ${amountUnits}, 가용 ${availableCash(state)} ` +
        `(cash=${state.venue.cash} locked=${state.venue.lockedCash})`,
    );
  }
  state.venue.cash = assertSafeInteger(state.venue.cash - amountUnits, 'cash');
  if (kind === 'oneOff') {
    state.records.totalOneOffUnits += amountUnits;
    state.ledger.push({
      id: `L${state.records.nextLedgerSeq}`,
      minute: state.time.minute,
      purpose,
      kind,
      amountUnits: -amountUnits,
    });
    state.records.nextLedgerSeq += 1;
  }
}

/** 예약: 잠금만 늘린다. cash는 그대로. */
export function lock(state: GameState, amountUnits: Money): void {
  if (amountUnits < 0) throw new Error(`잠금액이 음수: ${amountUnits}`);
  if (amountUnits > availableCash(state)) {
    throw new Error(
      `잠글 수 있는 금액을 초과: 필요 ${amountUnits}, 가용 ${availableCash(state)}`,
    );
  }
  state.venue.lockedCash = assertSafeInteger(state.venue.lockedCash + amountUnits, 'lockedCash');
}

/** 해제(취소): 잠금만 줄인다. cash는 그대로. */
export function release(state: GameState, amountUnits: Money): void {
  if (amountUnits < 0) throw new Error(`해제액이 음수: ${amountUnits}`);
  if (amountUnits > state.venue.lockedCash) {
    throw new Error(`잠긴 금액보다 많이 해제: ${amountUnits} > ${state.venue.lockedCash}`);
  }
  state.venue.lockedCash -= amountUnits;
}

/**
 * 정산: 잠긴 금액을 실제 지출로 확정한다.
 * cash 감소와 lockedCash 감소를 각각 한 번씩만 처리한다.
 * 잠금을 먼저 풀고 spend를 부르면 사용 가능 현금이 잠시 부풀어
 * 그 사이 다른 지출이 끼어들 수 있으므로, 한 연산 안에서 처리한다.
 */
export function settleLocked(state: GameState, amountUnits: Money, purpose: string): void {
  if (amountUnits < 0) throw new Error(`정산액이 음수: ${amountUnits}`);
  if (amountUnits > state.venue.lockedCash) {
    throw new Error(`잠긴 금액보다 많이 정산: ${amountUnits} > ${state.venue.lockedCash}`);
  }
  state.venue.lockedCash -= amountUnits;
  state.venue.cash = assertSafeInteger(state.venue.cash - amountUnits, 'cash');
  state.records.totalOneOffUnits += amountUnits;
  state.ledger.push({
    id: `L${state.records.nextLedgerSeq}`,
    minute: state.time.minute,
    purpose,
    kind: 'oneOff',
    amountUnits: -amountUnits,
  });
  state.records.nextLedgerSeq += 1;
}

/**
 * 대회 준비비 = 상금 + 참가자별 운영비 + 고정 개최비 (채택 R2).
 * 참가비는 여기에 포함하지 않는다. 종료 시 수입으로 정산한다.
 */
export function tournamentPrepCostUnits(spec: TournamentSpec, participants: number): Money {
  if (!Number.isInteger(participants) || participants < 0) {
    throw new Error(`참가자 수가 올바르지 않음: ${participants}`);
  }
  return gold(
    spec.prizePerParticipantGold * participants +
      spec.opCostPerParticipantGold * participants +
      spec.fixedHostingGold,
  );
}

/**
 * 대회 순이익 = 참가비 - 상금 - 참가자별 운영비 - 고정 개최비 (Economy §7).
 * 급여와 테이블비는 전역 반복 비용에서 이미 빠지므로 여기 넣지 않는다.
 */
export function tournamentNetUnits(spec: TournamentSpec, participants: number): Money {
  return gold(spec.entryFeeGold * participants) - tournamentPrepCostUnits(spec, participants);
}

/** 예상 참가자 = min(max, floor(D x multiplier)) (Economy §8) */
export function expectedParticipants(
  demandPerHourMilliValue: number,
  spec: TournamentSpec,
): number {
  return Math.min(
    spec.maxParticipants,
    Math.floor((demandPerHourMilliValue * spec.demandMultiplier) / 1000),
  );
}

export type { EconomyConfig };
