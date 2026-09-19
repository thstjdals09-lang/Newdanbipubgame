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
      totalTournamentRevenueUnits: 0,
      totalEmergencySupportUnits: 0,
      emergencyMinutes: 0,
      nextEmergencySeq: 1,
      completedTournaments: [],
      completedRemodels: [],
      nextRemodelSeq: 1,
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
  // 누락된 필드를 null로 바꿔 손상을 숨기지 않는다. 복제 전에 거절한다.
  assertRequiredStateFields(state);
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
    // 리모델링 작업도 깊게 복제한다. 얕게 두면 예상치의 두 분기가 같은 레코드를 공유한다.
    remodel: state.remodel === null ? null : { ...state.remodel },
    // 긴급 운영 상태도 깊게 복제한다. 얕게 두면 예상치의 두 분기가 같은
    // 레코드를 공유해 단계·지원금 누계가 원본으로 새어 나간다.
    emergency: state.emergency === null ? null : { ...state.emergency },
    unlocks: state.unlocks.map((u) => ({ ...u })),
    records: {
      ...state.records,
      usedTournamentDays: [...state.records.usedTournamentDays],
      completedTournaments: state.records.completedTournaments.map((c) => ({
        ...c,
        tableIds: [...c.tableIds],
        dealerIds: [...c.dealerIds],
      })),
      completedRemodels: state.records.completedRemodels.map((c) => ({
        ...c,
        preservedTableIds: [...c.preservedTableIds],
        preservedStaffIds: [...c.preservedStaffIds],
      })),
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
      tournament.phase === 'RESERVED_DRAINING' ||
      tournament.phase === 'RESERVED_READY' ||
      tournament.phase === 'IN_PROGRESS';
    if (!supportedPhase) {
      throw new UnsupportedStateError(
        'TOURNAMENT_NOT_IMPLEMENTED',
        '대회 진행은 작업 B-2에서 구현한다. 이 상태로는 계산할 수 없다. ' +
          `지원하지 않는 단계: ${String(tournament.phase)}`,
      );
    }
    // 소규모(B-2A)와 중규모(C-2)를 지원한다. 진행·정산은 config.tournament[scale]만
    // 참조하므로 규모별 분기가 없다. 정의되지 않은 규모는 그 조회가 undefined를 돌려줘
    // 계산이 조용히 깨지므로, 여기서 명시적으로 거절한다.
    if (tournament.scale !== 'small' && tournament.scale !== 'mid') {
      throw new UnsupportedStateError(
        'TOURNAMENT_NOT_IMPLEMENTED',
        `지원하지 않는 대회 규모: ${String(tournament.scale)}`,
      );
    }
  }
  const remodel = state.remodel;
  if (remodel !== null && remodel.phase !== 'PREPARING') {
    throw new UnsupportedStateError(
      'REMODEL_NOT_IMPLEMENTED',
      `지원하지 않는 리모델링 단계: ${String(remodel.phase)}`,
    );
  }
  const emergency = state.emergency;
  if (emergency !== null) {
    const supportedPhase = emergency.phase === 'DOWNSIZING' || emergency.phase === 'RECOVERING';
    if (!supportedPhase) {
      throw new UnsupportedStateError(
        'EMERGENCY_NOT_IMPLEMENTED',
        `지원하지 않는 긴급 운영 단계: ${String(emergency.phase)}`,
      );
    }
  }
  if (state.rulesVersion !== config.rulesVersion) {
    throw new UnsupportedStateError(
      'RULES_VERSION_MISMATCH',
      `룰 버전 불일치: 상태 ${state.rulesVersion} vs 설정 ${config.rulesVersion}`,
    );
  }
}

/**
 * 모든 저장 버전에서 존재해야 하는 최상위 필드.
 *
 * tournament / remodel / emergency는 작업 A(saveVersion 1)부터 항상 직렬화됐다.
 * 값이 null인 것(= 그런 상태가 없다)과 필드 자체가 없는 것(= 손상)은 다르다.
 * 어떤 마이그레이션도 이 필드를 초기화하지 않는다. 없으면 거절한다.
 */
const REQUIRED_STATE_FIELDS = ['tournament', 'remodel', 'emergency'] as const;

/**
 * 필수 필드 존재 검사.
 *
 * **누락을 null로 자동 복구하지 않는다.** 복구하면 손상된 저장본이 정상 상태로
 * 세탁되고, 대회 예약이 사라진 채 준비비 잠금과 tournamentHeld 테이블만 남는다.
 *
 * 누락된 필드를 그대로 두면 이후 코드가 undefined.phase를 읽어 TypeError가 난다.
 * 그 전에 명확한 무결성 오류로 거절하는 것이 이 함수의 목적이다.
 */
export function assertRequiredStateFields(state: GameState): void {
  const raw = state as unknown as Record<string, unknown>;
  for (const key of REQUIRED_STATE_FIELDS) {
    if (!(key in raw)) {
      throw new Error(
        `저장 무결성: 필수 필드 ${key}가 없다. 값이 null인 것과 필드 누락은 다르며, ` +
          '누락은 null로 복구하지 않는다.',
      );
    }
    if (raw[key] === undefined) {
      throw new Error(`저장 무결성: 필수 필드 ${key}가 undefined다. 손상된 저장본이다.`);
    }
  }
}

/**
 * 현금 계정의 무결성 (05 §3).
 *
 * **정상적인 "이번 분 비용 부족"과 이미 손상된 입력 상태를 구분하는 관문이다.**
 *
 * 긴급 축소 운영은 사용 가능 현금이 이번 분 비용보다 모자랄 때 부족액을 지원한다.
 * 그러나 입력 자체가 아래 중 하나라면 그것은 자금 부족이 아니라 손상된 데이터다.
 * 지원금으로 덮으면 잘못된 잔액이 정상값으로 세탁된다.
 *
 *   cash < 0            보유 현금이 음수일 수 없다
 *   lockedCash < 0      잠금 금액이 음수일 수 없다
 *   lockedCash > cash   잠긴 금액이 보유 현금을 넘을 수 없다
 *
 * 정상 운영에서는 이 조합이 만들어지지 않는다. 8단계가 부족액을 지원한 뒤
 * 비용을 차감하면 남는 현금이 잠긴 금액 이상이기 때문이다.
 *
 * 잔액 0, 비용과 같은 잔액, 비용보다 1unit 부족한 잔액은 모두 cash >= 0이므로
 * 여기를 통과하고 정상적으로 지원받는다.
 */
export function assertCashIntegrity(state: GameState): void {
  const { cash, lockedCash } = state.venue;
  assertSafeInteger(cash, 'venue.cash');
  assertSafeInteger(lockedCash, 'venue.lockedCash');

  if (cash < 0) {
    throw new Error(
      `보유 현금이 음수다: cash=${cash}. 손상된 상태이므로 긴급 지원으로 덮지 않는다.`,
    );
  }
  if (lockedCash < 0) {
    throw new Error(`잠금 금액이 음수: ${lockedCash}`);
  }
  if (lockedCash > cash) {
    throw new Error(`잠금 금액이 보유 현금을 초과: locked=${lockedCash} cash=${cash}`);
  }
}

/** 매 틱 검사하는 불변식 (05 §3, §4-1) */
export function assertInvariants(state: GameState): void {
  assertCashIntegrity(state);
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
 * 저장 스키마 마이그레이션. **한 버전씩 체인으로 올린다.**
 *
 * v1 -> v2 (B-1): v1은 tournament가 항상 null이고 nextTournamentSeq가 없었다.
 *   tournament        null 유지 (v1에는 예약이 존재할 수 없었다)
 *   nextTournamentSeq 1로 초기화 (아직 어떤 대회 ID도 발급된 적 없다)
 *
 * v2 -> v3 (B-2A): 대회 진행·정산 상태가 추가됐다.
 *   records.totalTournamentRevenueUnits  0으로 초기화 (v2는 참가비를 인식한 적이 없다)
 *   records.completedTournaments         [] 로 초기화 (v2는 대회를 완료한 적이 없다)
 *   tournament.startedAtMinute/endsAtMinute  null (v2 예약은 시작한 적이 없다)
 *
 * v2가 담을 수 있던 대회 상태는 "없음 / RESERVED_DRAINING / RESERVED_READY"뿐이다.
 * 세 경우 모두 그대로 보존한다. READY 예약은 READY로 이어지며 완료로 오인하지 않는다.
 * 예약 테이블·딜러 ID, 잠긴 금액, 소비한 개최권은 건드리지 않는다.
 *
 * 경제 수치는 하나도 바꾸지 않는다.
 * 의미가 정의되지 않은 버전이나 그 버전이 표현할 수 없는 상태는 거절한다.
 * 오래된 저장본을 조용히 버리거나 버전 검사를 우회하지 않는다.
 */
function migrateV1ToV2(raw: GameState): GameState {
  const migrated = raw as GameState & { records: { nextTournamentSeq?: number } };
  // v1에도 tournament 필드는 있었다(항상 null). 값만 확인하고 초기화하지 않는다.
  if (migrated.tournament !== null) {
    throw new UnsupportedStateError(
      'SAVE_VERSION_MISMATCH',
      'v1 저장본에 대회 예약이 들어 있다. v1은 예약을 표현할 수 없으므로 마이그레이션 의미가 정의되지 않는다.',
    );
  }
  // v1에 실제로 없던 필드만 초기화한다.
  if (migrated.records.nextTournamentSeq === undefined) {
    migrated.records.nextTournamentSeq = 1;
  }
  migrated.saveVersion = 2;
  return migrated;
}

function migrateV2ToV3(raw: GameState): GameState {
  const migrated = raw as GameState & {
    records: {
      totalTournamentRevenueUnits?: number;
      completedTournaments?: GameState['records']['completedTournaments'];
    };
  };

  const t = migrated.tournament;
  if (t != null) {
    if (t.phase !== 'RESERVED_DRAINING' && t.phase !== 'RESERVED_READY') {
      throw new UnsupportedStateError(
        'SAVE_VERSION_MISMATCH',
        `v2 저장본이 표현할 수 없는 대회 단계다: ${String(t.phase)}. 마이그레이션 의미가 정의되지 않는다.`,
      );
    }
    // v2 예약은 시작한 적이 없다. 두 시각은 null이 유일하게 옳은 값이다.
    t.startedAtMinute = null;
    t.endsAtMinute = null;
  }

  if (migrated.records.totalTournamentRevenueUnits === undefined) {
    migrated.records.totalTournamentRevenueUnits = 0;
  }
  if (migrated.records.completedTournaments === undefined) {
    migrated.records.completedTournaments = [];
  }
  migrated.saveVersion = 3;
  return migrated;
}

/**
 * saveVersion 1~3이 함께 쓰던 유일한 계산 규칙 버전.
 *
 * 작업 A부터 B-2C까지 규칙 버전은 이 값 하나였고, B-3에서 8·9단계 규칙이 바뀌며
 * saveVersion 4와 함께 올라갔다. 따라서 (saveVersion <= 3, rulesVersion) 조합 중
 * 실제로 존재한 적 있는 것은 이 하나뿐이다.
 */
const LEGACY_RULES_VERSION_V1_TO_V3 = 'economy-0.1+adopt-v1';

/**
 * v3 -> v4 (B-3): 긴급 축소 운영 상태와 지원금 계정이 추가됐다.
 *   emergency                            null (v3은 긴급 운영을 표현할 수 없었다)
 *   records.totalEmergencySupportUnits    0   (v3은 지원금을 지급한 적이 없다)
 *   records.emergencyMinutes              0
 *   records.nextEmergencySeq              1   (아직 어떤 긴급 운영 ID도 발급된 적 없다)
 *
 * 계산 규칙도 함께 바뀌었으므로 rulesVersion을 올린다.
 * v3 상태는 새 규칙에서도 그대로 유효하다. 달라지는 것은 "자기 자금으로 비용을
 * 낼 수 없는 순간"의 처리뿐이며, v3에서 그 순간은 예외로 중단되던 지점이다.
 * 따라서 정상적으로 저장된 v3 본은 과거 기록을 바꾸지 않고 옮길 수 있다.
 *
 * 완료된 대회 기록, 준비비 잠금, 직원 보상 지급 기록, 나머지 누계는 보존한다.
 * 손상된 저장 데이터를 지원금으로 정상화하지 않는다.
 */
function migrateV3ToV4(raw: GameState): GameState {
  // 원본 저장 구조 버전과 계산 규칙 버전의 **조합**을 검사한다.
  // 규칙 버전을 무조건 현재 값으로 덮어써서 알 수 없는 저장본을 받아들이지 않는다.
  if (raw.rulesVersion !== LEGACY_RULES_VERSION_V1_TO_V3) {
    throw new UnsupportedStateError(
      'RULES_VERSION_MISMATCH',
      `saveVersion 3과 함께 존재한 계산 규칙 버전은 ${LEGACY_RULES_VERSION_V1_TO_V3}뿐이다. ` +
        `받은 값: ${String(raw.rulesVersion)}. 알 수 없는 조합이므로 변환하지 않는다.`,
    );
  }

  const migrated = raw as GameState & {
    records: {
      totalEmergencySupportUnits?: number;
      emergencyMinutes?: number;
      nextEmergencySeq?: number;
    };
  };

  // v3에도 emergency 필드는 있었다(항상 null). 값만 확인하고 초기화하지 않는다.
  if (migrated.emergency !== null) {
    throw new UnsupportedStateError(
      'SAVE_VERSION_MISMATCH',
      'v3 저장본에 긴급 운영 상태가 들어 있다. v3은 이를 표현할 수 없으므로 마이그레이션 의미가 정의되지 않는다.',
    );
  }
  // v3에 실제로 없던 필드만 초기화한다.
  if (migrated.records.totalEmergencySupportUnits === undefined) {
    migrated.records.totalEmergencySupportUnits = 0;
  }
  if (migrated.records.emergencyMinutes === undefined) {
    migrated.records.emergencyMinutes = 0;
  }
  if (migrated.records.nextEmergencySeq === undefined) {
    migrated.records.nextEmergencySeq = 1;
  }
  // 위에서 확인한 과거 규칙 버전에서 v4 시절의 규칙 버전으로만 올린다.
  // 체인의 다음 단계(v4 -> v5)가 다시 검사하고 현재 버전으로 올린다.
  // 경제 수치는 하나도 건드리지 않는다.
  migrated.rulesVersion = LEGACY_RULES_VERSION_V4;
  migrated.saveVersion = 4;
  return migrated;
}

/** saveVersion 4가 함께 쓰던 유일한 계산 규칙 버전 */
const LEGACY_RULES_VERSION_V4 = 'economy-0.2+b3-emergency';

/**
 * v4 -> v5 (C-1): 리모델링 상태와 완료 기록이 추가됐다.
 *   records.completedRemodels   [] 로 초기화 (v4는 리모델링을 완료한 적이 없다)
 *   records.nextRemodelSeq      1 로 초기화
 *
 * remodel 필드 자체는 작업 A(v1)부터 항상 있었으므로 초기화하지 않고 값만 확인한다.
 * v4는 리모델링 작업을 표현할 수 없었으므로 null이어야 한다.
 *
 * 계산 규칙도 함께 바뀌었으므로 rulesVersion을 올린다.
 * v4 상태는 새 규칙에서도 그대로 유효하다. 달라지는 것은 리모델링이 걸린 동안의
 * 처리뿐이며, v4에서 그 상태는 존재할 수 없었다.
 *
 * 완료된 대회 기록, 준비비 잠금, 직원 보상 지급 기록, 긴급 운영 누계,
 * 나머지 누적값은 모두 보존한다.
 */
function migrateV4ToV5(raw: GameState): GameState {
  if (raw.rulesVersion !== LEGACY_RULES_VERSION_V4) {
    throw new UnsupportedStateError(
      'RULES_VERSION_MISMATCH',
      `saveVersion 4와 함께 존재한 계산 규칙 버전은 ${LEGACY_RULES_VERSION_V4}뿐이다. ` +
        `받은 값: ${String(raw.rulesVersion)}. 알 수 없는 조합이므로 변환하지 않는다.`,
    );
  }

  const migrated = raw as GameState & {
    records: {
      completedRemodels?: GameState['records']['completedRemodels'];
      nextRemodelSeq?: number;
    };
  };

  if (migrated.remodel !== null) {
    throw new UnsupportedStateError(
      'SAVE_VERSION_MISMATCH',
      'v4 저장본에 리모델링 작업이 들어 있다. v4는 이를 표현할 수 없으므로 마이그레이션 의미가 정의되지 않는다.',
    );
  }

  // v4에 실제로 없던 필드만 초기화한다.
  if (migrated.records.completedRemodels === undefined) {
    migrated.records.completedRemodels = [];
  }
  if (migrated.records.nextRemodelSeq === undefined) {
    migrated.records.nextRemodelSeq = 1;
  }
  migrated.rulesVersion = RULES_VERSION;
  migrated.saveVersion = 5;
  return migrated;
}

function migrateSave(raw: GameState): GameState {
  // 필수 필드는 모든 저장 버전에 있었다. 버전 분기 전에 확인한다.
  // 여기서 통과시키면 아래 마이그레이션이 누락을 조용히 메우게 된다.
  assertRequiredStateFields(raw);

  let current = raw;

  if (current.saveVersion === 1) current = migrateV1ToV2(current);
  if (current.saveVersion === 2) current = migrateV2ToV3(current);
  if (current.saveVersion === 3) current = migrateV3ToV4(current);
  if (current.saveVersion === 4) current = migrateV4ToV5(current);

  if (current.saveVersion !== SAVE_VERSION) {
    throw new UnsupportedStateError(
      'SAVE_VERSION_MISMATCH',
      `저장 스키마 버전 불일치: ${raw.saveVersion} vs ${SAVE_VERSION} (정의된 마이그레이션 없음)`,
    );
  }
  return current;
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
  // 완료 기록 자체의 무결성부터 본다.
  const completedIds = state.records.completedTournaments.map((c) => c.id);
  if (new Set(completedIds).size !== completedIds.length) {
    throw new Error('완료된 대회 기록에 중복 ID가 있다');
  }

  // undefined는 "대회가 없다"가 아니라 "필드가 손상됐다"는 뜻이다.
  // 조용히 없음으로 취급하면 준비비 잠금과 tournamentHeld 테이블만 남는다.
  const t = state.tournament;
  if (t === undefined) {
    throw new Error('저장 무결성: tournament 필드가 없다. 없음(null)과 누락은 다르다.');
  }
  if (t === null) return;

  // 활성 예약이 이미 완료된 대회와 같은 ID면 중복 정산이 가능해진다.
  if (completedIds.includes(t.id)) {
    throw new Error(`예약 ${t.id}: 이미 완료 기록이 있는 대회가 활성 예약으로 남아 있다`);
  }

  // 단계별로 시각 필드가 앞뒤가 맞아야 한다.
  if (t.phase === 'IN_PROGRESS') {
    if (t.startedAtMinute === null || t.endsAtMinute === null) {
      throw new Error(`예약 ${t.id}: 진행 중인데 시작·종료 시각이 없다`);
    }
    if (t.endsAtMinute <= t.startedAtMinute) {
      throw new Error(`예약 ${t.id}: 종료 시각이 시작 시각보다 앞선다`);
    }
    if (t.readyAtMinute === null || t.readyAtMinute >= t.startedAtMinute) {
      throw new Error(`예약 ${t.id}: 준비 완료 시각이 시작 시각보다 앞서지 않는다`);
    }
  } else {
    if (t.startedAtMinute !== null || t.endsAtMinute !== null) {
      throw new Error(`예약 ${t.id}: 시작 전인데 시작·종료 시각이 채워져 있다`);
    }
    if (t.phase === 'RESERVED_READY' && t.readyAtMinute === null) {
      throw new Error(`예약 ${t.id}: 준비 완료 상태인데 그 시각이 없다`);
    }
    if (t.phase === 'RESERVED_DRAINING' && t.readyAtMinute !== null) {
      throw new Error(`예약 ${t.id}: 정리 중인데 준비 완료 시각이 채워져 있다`);
    }
  }

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
