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
      nextTournamentSeq: 1,
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
    // 예약 레코드는 깊게 복제한다. 얕게 두면 forecast의 두 분기가 같은
    // 레코드를 공유해 phase 전환이 원본으로 새어 나간다.
    tournament:
      state.tournament === null
        ? null
        : {
            ...state.tournament,
            tableIds: [...state.tournament.tableIds],
            dealerIds: [...state.tournament.dealerIds],
          },
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
  const tournament = state.tournament;
  if (tournament !== null) {
    // B-1이 소유하는 준비 단계만 지원한다.
    // 그 밖의 단계(대회 시작 이후)는 작업 B-2이므로 조용히 처리하지 않고 거절한다.
    const supportedPhase =
      tournament.phase === 'RESERVED_DRAINING' || tournament.phase === 'RESERVED_READY';
    if (!supportedPhase) {
      throw new UnsupportedStateError(
        'TOURNAMENT_NOT_IMPLEMENTED',
        '대회 진행은 작업 B-2에서 구현한다. 이 상태로는 계산할 수 없다. ' +
          `지원하지 않는 단계: ${String(tournament.phase)}`,
      );
    }
    if (tournament.scale !== 'small') {
      throw new UnsupportedStateError(
        'TOURNAMENT_NOT_IMPLEMENTED',
        '대회 진행은 작업 B-2에서 구현한다. 이 상태로는 계산할 수 없다. ' +
          `지원하지 않는 규모: ${String(tournament.scale)}`,
      );
    }
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

/**
 * 저장 스키마 마이그레이션.
 *
 * v1 -> v2 (B-1): v1은 tournament가 항상 null이고 nextTournamentSeq가 없었다.
 * v2에서 두 필드의 의미가 완전히 정의되므로 안전하게 옮길 수 있다.
 *   tournament        null 유지 (v1에는 예약이 존재할 수 없었다)
 *   nextTournamentSeq 1로 초기화 (아직 어떤 대회 ID도 발급된 적 없다)
 * 경제 수치는 하나도 건드리지 않는다.
 *
 * 의미가 정의되지 않은 버전은 마이그레이션하지 않고 거절한다.
 * 오래된 저장본을 조용히 버리거나 버전 검사를 우회하지 않는다.
 */
function migrateSave(raw: GameState): GameState {
  if (raw.saveVersion === SAVE_VERSION) return raw;

  if (raw.saveVersion === 1) {
    const migrated = raw as GameState & { records: { nextTournamentSeq?: number } };
    if (migrated.tournament != null) {
      throw new UnsupportedStateError(
        'SAVE_VERSION_MISMATCH',
        'v1 저장본에 대회 예약이 들어 있다. v1은 예약을 표현할 수 없으므로 마이그레이션 의미가 정의되지 않는다.',
      );
    }
    migrated.tournament = null;
    if (migrated.records.nextTournamentSeq === undefined) {
      migrated.records.nextTournamentSeq = 1;
    }
    migrated.saveVersion = SAVE_VERSION;
    return migrated;
  }

  throw new UnsupportedStateError(
    'SAVE_VERSION_MISMATCH',
    `저장 스키마 버전 불일치: ${raw.saveVersion} vs ${SAVE_VERSION} (정의된 마이그레이션 없음)`,
  );
}

export function deserialize(json: string, config: EconomyConfig = DEFAULT_CONFIG): GameState {
  const parsed = migrateSave(JSON.parse(json) as GameState);
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
  assertReservationIntegrity(parsed);
  return parsed;
}

/**
 * 예약 레코드와 실제 자원의 정합성 검사 (계약 8).
 * 저장본이 대회·테이블·딜러·현금을 새로 만들어 내지 않았는지 확인한다.
 */
export function assertReservationIntegrity(state: GameState): void {
  const t = state.tournament;
  if (t === null) return;

  if (t.tableIds.length !== t.dealerIds.length) {
    throw new Error(`예약 ${t.id}: 테이블 ${t.tableIds.length}개와 딜러 ${t.dealerIds.length}명이 짝이 맞지 않음`);
  }
  if (new Set(t.tableIds).size !== t.tableIds.length) {
    throw new Error(`예약 ${t.id}: 중복된 테이블 ID`);
  }
  if (new Set(t.dealerIds).size !== t.dealerIds.length) {
    throw new Error(`예약 ${t.id}: 중복된 딜러 ID`);
  }

  t.tableIds.forEach((tableId, i) => {
    const table = state.tables.find((x) => x.id === tableId);
    if (!table) throw new Error(`예약 ${t.id}: 테이블 ${tableId}가 매장에 없음`);
    if (table.status !== 'tournamentHeld') {
      throw new Error(`예약 ${t.id}: 테이블 ${tableId}의 상태가 ${table.status}`);
    }
    const dealerId = t.dealerIds[i];
    if (table.dealerId !== dealerId) {
      throw new Error(`예약 ${t.id}: 테이블 ${tableId}의 담당 딜러가 ${String(table.dealerId)} (예약은 ${String(dealerId)})`);
    }
    const dealer = state.staff.find((x) => x.id === dealerId);
    if (!dealer) throw new Error(`예약 ${t.id}: 딜러 ${String(dealerId)}가 명부에 없음`);
    if (dealer.duty !== 'working' || dealer.assignedTableId !== tableId) {
      throw new Error(`예약 ${t.id}: 딜러 ${String(dealerId)}의 배치가 예약과 다름`);
    }
  });

  if (state.venue.lockedCash < t.prepCostUnits) {
    throw new Error(
      `예약 ${t.id}: 잠긴 금액 ${state.venue.lockedCash}가 준비비 ${t.prepCostUnits}보다 적음`,
    );
  }
  if (!state.records.usedTournamentDays.includes(t.gameDay)) {
    throw new Error(`예약 ${t.id}: 게임일 ${t.gameDay}의 개최권 소비 기록이 없음`);
  }
}
