/**
 * 경제 상태 타입.
 *
 * Economy §2 "최소 상태 항목"을 1:1로 따르되, 05 채택기록 v1에서 결정한
 * 나머지 보존 필드(arrivalCarry, satisfactionRemainder, 이탈률 윈도우)와
 * 버전 필드를 추가했다.
 */

import type { Stage, StaffType } from '../config/economy.js';

/** 게임 경과 분. 현실 시각과 무관하다. */
export type GameMinute = number;
/** 내부 화폐 단위. 1G = 60 units. */
export type Money = number;
/** x1000 정수 (인지도·만족도) */
export type Milli = number;

export type TableId = string;
export type StaffId = string;
export type SessionId = string;

/**
 * 테이블 상태.
 *   idle            설치됐으나 딜러가 없음. 처리 능력에 포함하지 않고 시설비도 없다 (P02)
 *   operating       일반 영업 중
 *   closing         신규 착석 차단, 기존 세션만 소진. 딜러 교체·휴업 요청 중 (Economy §5)
 *   tournamentHeld  대회 예약·진행 중 (작업 B)
 *   remodelPrep     리모델링 준비 중 (작업 C)
 */
export type TableStatus =
  | 'idle'
  | 'operating'
  | 'closing'
  | 'tournamentHeld'
  | 'remodelPrep';

export interface TableState {
  readonly id: TableId;
  /** 설치 지점 번호. 1-indexed. 구매 순번이기도 하다. */
  readonly spotIndex: number;
  readonly floor: 1 | 2;
  status: TableStatus;
  dealerId: StaffId | null;
  /**
   * 기존 세션이 끝난 뒤 반영할 딜러 배치.
   * null이면 "딜러를 떼어낸다", undefined면 "대기 중인 변경 없음".
   * Economy §5: 진행 중 세션은 시작 시 확정한 시간과 금액을 유지한다.
   */
  pendingDealerId?: StaffId | null;
}

export type StaffDuty = 'standby' | 'working';

export interface StaffState {
  readonly id: StaffId;
  readonly type: StaffType;
  duty: StaffDuty;
  /** 딜러만 사용. 서비스 직원은 항상 null. */
  assignedTableId: TableId | null;
}

export interface SessionState {
  readonly id: SessionId;
  readonly tableId: TableId;
  /** 같은 테이블 안에서의 좌석 번호. 1-indexed. */
  readonly seatIndex: number;
  readonly startedAtMinute: GameMinute;
  /** 착석 시점에 확정된다. 이후 딜러가 바뀌어도 변하지 않는다. */
  readonly endsAtMinute: GameMinute;
  readonly revenueUnits: Money;
  /** 정산 여부. 세션당 정확히 한 번만 true가 된다. */
  settled: boolean;
}

export interface QueueEntry {
  /** 도착 순서. 전역 단조 증가. */
  readonly seq: number;
  readonly arrivedAtMinute: GameMinute;
}

/** 이탈률 집계용 슬라이딩 윈도우 (05 §4-4, R5). */
export interface AbandonWindow {
  /** 길이 = config.satisfaction.abandonWindowMinutes. 분 % 길이 위치에 기록. */
  arrivals: number[];
  abandons: number[];
  /** 합계는 증분 갱신하되 역직렬화 시 재계산해 검증한다. */
  sumArrivals: number;
  sumAbandons: number;
}

export interface UnlockRecord {
  readonly id: string;
  readonly grantedAtMinute: GameMinute;
}

export type LedgerKind = 'oneOff' | 'recurring';

export interface LedgerEntry {
  readonly id: string;
  readonly minute: GameMinute;
  readonly purpose: string;
  readonly kind: LedgerKind;
  /** 수입은 양수, 지출은 음수. 내부 단위. */
  readonly amountUnits: Money;
}

export interface GameState {
  /** 계산 순서·공식·반올림 규칙의 버전 (05 §7) */
  rulesVersion: string;
  /** 직렬화 스키마 버전 (05 §7) */
  saveVersion: number;

  time: {
    minute: GameMinute;
    /** 방문 수요 소수 누적값. 정수 분자, 분모는 ARRIVAL_DEN (05 §4-3). */
    arrivalCarry: number;
  };

  venue: {
    stage: Stage;
    /** 잠긴 금액을 포함한 총보유현금 (05 §3) */
    cash: Money;
    /** cash 중 사용할 수 없는 금액 (05 §3) */
    lockedCash: Money;
    awarenessMilli: Milli;
    satisfactionMilli: Milli;
    /** 만족도 감쇠의 나머지. 저장 대상 (05 §4-2). */
    satisfactionRemainder: number;
    themeId: string;
    amenityLevel: number;
  };

  tables: TableState[];
  staff: StaffState[];
  sessions: SessionState[];
  queue: QueueEntry[];

  /** 작업 B. 이번 구현에서는 항상 null이며, null이 아니면 엔진이 거절한다. */
  tournament: null;
  /** 작업 C. 위와 동일. */
  remodel: null;
  /** 작업 B. 긴급 축소 운영. 위와 동일. */
  emergency: null;

  unlocks: UnlockRecord[];

  records: {
    completedGuests: number;
    tournamentsDone: number;
    usedTournamentDays: number[];
    /** 지역 홍보 재사용 가능 시각 */
    promoReadyMinute: GameMinute;

    /**
     * 누적 손익. 예상치가 "추가 매출 / 추가 반복 비용 / 추가 순이익"을
     * 계산하는 근거다 (Economy §9).
     * 반복 비용을 거래 원장에 분 단위로 쌓지 않는 이유는 48게임시간에
     * 2,880건이 쌓여 저장 크기와 복제 비용이 무의미하게 커지기 때문이다.
     * 원장(ledger)에는 일회성 거래만 남긴다 (Economy §7 "일회성 투자와 반복 비용을 구분").
     */
    totalRevenueUnits: Money;
    totalWageUnits: Money;
    totalFacilityUnits: Money;
    totalVenueCostUnits: Money;
    totalOneOffUnits: Money;
    /** 다음에 부여할 도착 순번 */
    nextArrivalSeq: number;
    /** ID 생성용 단조 증가 카운터 (난수 미사용) */
    nextTableSeq: number;
    nextStaffSeq: number;
    nextSessionSeq: number;
    nextLedgerSeq: number;
  };

  window: AbandonWindow;
  ledger: LedgerEntry[];
}

/* ------------------------------------------------------------------ */
/* 명령                                                                */
/* ------------------------------------------------------------------ */

export type Command =
  | { readonly type: 'buyTable' }
  | { readonly type: 'hireDealer' }
  | { readonly type: 'hireServiceStaff' }
  | { readonly type: 'assignDealer'; readonly tableId: TableId; readonly staffId: StaffId }
  | { readonly type: 'unassignDealer'; readonly tableId: TableId }
  | { readonly type: 'setStaffStandby'; readonly staffId: StaffId }
  | { readonly type: 'setServiceWorking'; readonly staffId: StaffId }
  | { readonly type: 'upgradeAmenity' }
  | { readonly type: 'buyPromotion' };

export type RejectReason =
  | 'INSUFFICIENT_CASH'
  | 'TABLE_CAP_REACHED'
  | 'TABLE_NOT_FOUND'
  | 'STAFF_NOT_FOUND'
  | 'STAFF_NOT_DEALER'
  | 'STAFF_ALREADY_ASSIGNED'
  | 'TABLE_ALREADY_HAS_DEALER'
  | 'TABLE_NOT_AVAILABLE'
  | 'NO_DEALER_ON_TABLE'
  | 'AMENITY_MAX_LEVEL'
  | 'AMENITY_LOCKED'
  | 'PROMOTION_DISABLED'
  | 'PROMOTION_ON_COOLDOWN'
  | 'PROMOTION_AWARENESS_TOO_HIGH'
  | 'STAFF_IS_SERVICE'
  | 'STAFF_NOT_SERVICE'
  | 'STAFF_HAS_ACTIVE_TABLE';

export interface CommandResult {
  readonly ok: boolean;
  readonly reason?: RejectReason;
  readonly detail?: string;
}

/* ------------------------------------------------------------------ */
/* 이벤트                                                              */
/* ------------------------------------------------------------------ */

export type EngineEvent =
  | { readonly type: 'commandAccepted'; readonly command: Command }
  | { readonly type: 'commandRejected'; readonly command: Command; readonly reason: RejectReason }
  | { readonly type: 'guestArrived'; readonly seq: number }
  | { readonly type: 'guestSeated'; readonly seq: number; readonly tableId: TableId; readonly sessionId: SessionId }
  | { readonly type: 'guestAbandoned'; readonly seq: number; readonly waitedMinutes: number; readonly cause: 'timeout' | 'queueFull' }
  | { readonly type: 'sessionCompleted'; readonly sessionId: SessionId; readonly revenueUnits: Money }
  | { readonly type: 'dealerChangeApplied'; readonly tableId: TableId; readonly dealerId: StaffId | null }
  | { readonly type: 'unlockGranted'; readonly id: string }
  | { readonly type: 'cashNegative'; readonly cash: Money };

export interface TickResult {
  readonly state: GameState;
  readonly events: EngineEvent[];
}

/**
 * 이번 구현이 지원하지 않는 상태를 만났을 때 던진다.
 * 조용히 무시하지 않기 위한 것이다 (사용자 요구 7).
 */
export class UnsupportedStateError extends Error {
  constructor(public readonly code: UnsupportedCode, message: string) {
    super(message);
    this.name = 'UnsupportedStateError';
  }
}

export type UnsupportedCode =
  | 'TOURNAMENT_NOT_IMPLEMENTED'
  | 'REMODEL_NOT_IMPLEMENTED'
  | 'EMERGENCY_NOT_IMPLEMENTED'
  | 'RULES_VERSION_MISMATCH'
  | 'SAVE_VERSION_MISMATCH';
