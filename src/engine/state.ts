/**
 * 상태 생성·복제·직렬화.
 *
 * 직렬화는 나머지 보존 필드를 하나도 빠뜨리면 안 된다.
 * 빠지면 05 §4-5의 저장 복원 테스트가 깨진다.
 */

import { DEFAULT_CONFIG, RULES_VERSION, SAVE_VERSION, gold } from '../config/economy.js';
import type { EconomyConfig } from '../config/economy.js';
import { assertSafeInteger } from './fixed.js';
import { UnsupportedStateError } from './types.js';
import type { GameState } from './types.js';

export function createInitialState(config: EconomyConfig = DEFAULT_CONFIG): GameState {
  const windowLength = config.satisfaction.abandonWindowMinutes;

  const state: GameState = {
    rulesVersion: config.rulesVersion,
    saveVersion: SAVE_VERSION,

    time: { minute: 0, arrivalCarry: 0 },

    venue: {
      stage: 1,
      cash: gold(config.money.startingCashGold),
      lockedCash: 0,
      awarenessMilli: config.venue.startingAwarenessMilli,
      satisfactionMilli: config.venue.startingSatisfactionMilli,
      satisfactionRemainder: 0,
      themeId: 'base',
      amenityLevel: 0,
    },

    // 시작 구성: 테이블 1개, 일반 딜러 1명 (GDD §9 / Economy §1)
    tables: [
      { id: 'T1', spotIndex: 1, floor: 1, status: 'operating', dealerId: 'S1' },
    ],
    staff: [
      { id: 'S1', type: 'normal', duty: 'working', assignedTableId: 'T1' },
    ],
    sessions: [],
    queue: [],

    tournament: null,
    remodel: null,
    emergency: null,

    unlocks: [],

    records: {
      completedGuests: 0,
      tournamentsDone: 0,
      usedTournamentDays: [],
      promoReadyMinute: 0,
      totalRevenueUnits: 0,
      totalWageUnits: 0,
      totalFacilityUnits: 0,
      totalVenueCostUnits: 0,
      totalOneOffUnits: 0,
      nextArrivalSeq: 1,
      nextTableSeq: 2,
      nextStaffSeq: 2,
      nextSessionSeq: 1,
      nextLedgerSeq: 1,
    },

    window: {
      arrivals: new Array<number>(windowLength).fill(0),
      abandons: new Array<number>(windowLength).fill(0),
      sumArrivals: 0,
      sumAbandons: 0,
    },

    ledger: [],
  };

  return state;
}

/**
 * 깊은 복제.
 * 투자 예상치가 원본을 건드리지 않게 하는 핵심 장치 (Economy §9).
 * structuredClone을 쓰지 않는 이유: Node/브라우저 간 동작 차이를 피하고,
 * 어떤 필드가 복제되는지 코드에 드러나게 하기 위해서다.
 */
export function cloneState(state: GameState): GameState {
  return {
    rulesVersion: state.rulesVersion,
    saveVersion: state.saveVersion,
    time: { ...state.time },
    venue: { ...state.venue },
    tables: state.tables.map((t) => ({ ...t })),
    staff: state.staff.map((s) => ({ ...s })),
    sessions: state.sessions.map((s) => ({ ...s })),
    queue: state.queue.map((q) => ({ ...q })),
    tournament: state.tournament,
    remodel: state.remodel,
    emergency: state.emergency,
    unlocks: state.unlocks.map((u) => ({ ...u })),
    records: {
      ...state.records,
      usedTournamentDays: [...state.records.usedTournamentDays],
    },
    window: {
      arrivals: [...state.window.arrivals],
      abandons: [...state.window.abandons],
      sumArrivals: state.window.sumArrivals,
      sumAbandons: state.window.sumAbandons,
    },
    ledger: state.ledger.map((l) => ({ ...l })),
  };
}

/**
 * 이번 구현이 지원하는 상태인지 검사한다.
 * 미구현 영역을 조용히 무시하지 않기 위한 관문이다 (사용자 요구 7).
 */
export function assertSupported(state: GameState, config: EconomyConfig): void {
  if (state.tournament !== null) {
    throw new UnsupportedStateError(
      'TOURNAMENT_NOT_IMPLEMENTED',
      '대회 진행은 작업 B에서 구현한다. 이 상태로는 계산할 수 없다.',
    );
  }
  if (state.remodel !== null) {
    throw new UnsupportedStateError(
      'REMODEL_NOT_IMPLEMENTED',
      '리모델링 전환은 작업 C에서 구현한다. 이 상태로는 계산할 수 없다.',
    );
  }
  if (state.emergency !== null) {
    throw new UnsupportedStateError(
      'EMERGENCY_NOT_IMPLEMENTED',
      '긴급 축소 운영은 작업 B에서 구현한다. 이 상태로는 계산할 수 없다.',
    );
  }
  if (state.rulesVersion !== config.rulesVersion) {
    throw new UnsupportedStateError(
      'RULES_VERSION_MISMATCH',
      `룰 버전 불일치: 상태 ${state.rulesVersion} vs 설정 ${config.rulesVersion}`,
    );
  }
}

/** 매 틱 검사하는 불변식 (05 §3, §4-1) */
export function assertInvariants(state: GameState): void {
  const { cash, lockedCash } = state.venue;
  assertSafeInteger(cash, 'venue.cash');
  assertSafeInteger(lockedCash, 'venue.lockedCash');
  if (lockedCash < 0) {
    throw new Error(`잠금 금액이 음수: ${lockedCash}`);
  }
  if (cash >= 0 && lockedCash > cash) {
    throw new Error(`잠금 금액이 보유 현금을 초과: locked=${lockedCash} cash=${cash}`);
  }
  if (cash < 0 && lockedCash > 0) {
    // 현금이 음수인데 잠긴 자금이 남아 있는 상태는 긴급 축소 운영(작업 B)의 영역이다.
    // 이번 구현에서 이 조합이 만들어지면 버그다.
    throw new Error(`현금이 음수인데 잠긴 자금이 있음: locked=${lockedCash} cash=${cash}`);
  }
  assertSafeInteger(state.time.arrivalCarry, 'time.arrivalCarry');
  assertSafeInteger(state.venue.satisfactionRemainder, 'venue.satisfactionRemainder');
}

/* ------------------------------------------------------------------ */
/* 직렬화                                                              */
/* ------------------------------------------------------------------ */

export function serialize(state: GameState): string {
  return JSON.stringify(state);
}

export function deserialize(json: string, config: EconomyConfig = DEFAULT_CONFIG): GameState {
  const parsed = JSON.parse(json) as GameState;

  if (parsed.saveVersion !== SAVE_VERSION) {
    throw new UnsupportedStateError(
      'SAVE_VERSION_MISMATCH',
      `저장 스키마 버전 불일치: ${parsed.saveVersion} vs ${SAVE_VERSION}`,
    );
  }
  if (parsed.rulesVersion !== RULES_VERSION) {
    throw new UnsupportedStateError(
      'RULES_VERSION_MISMATCH',
      `룰 버전 불일치: ${parsed.rulesVersion} vs ${RULES_VERSION}`,
    );
  }

  // 윈도우 합계를 재계산해 저장값과 대조한다.
  // 증분 갱신 버그가 저장을 통과해 살아남지 않게 하는 검사다.
  const sumA = parsed.window.arrivals.reduce((a, b) => a + b, 0);
  const sumB = parsed.window.abandons.reduce((a, b) => a + b, 0);
  if (sumA !== parsed.window.sumArrivals || sumB !== parsed.window.sumAbandons) {
    throw new Error(
      `이탈률 윈도우 합계 불일치: arrivals ${parsed.window.sumArrivals}!=${sumA}, ` +
        `abandons ${parsed.window.sumAbandons}!=${sumB}`,
    );
  }
  if (parsed.window.arrivals.length !== config.satisfaction.abandonWindowMinutes) {
    throw new Error('이탈률 윈도우 길이가 설정과 다름');
  }

  assertInvariants(parsed);
  return parsed;
}
