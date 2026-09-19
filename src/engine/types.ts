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
 *   tournamentHeld  대회가 점유 중. B-1에서는 예약 준비 단계 (작업 B-2가 진행을 맡는다)
 *   remodelPrep     리모델링 준비 중 (작업 C)
 *
 * closing과 tournamentHeld는 둘 다 신규 착석을 막지만 소유 주체가 다르다.
 *   closing        -> 소유자는 "딜러 변경 요청". 세션이 비면 applyPendingDealerChanges가
 *                     pendingDealerId에 따라 딜러를 붙이거나 **떼어내고** idle로 되돌린다.
 *   tournamentHeld -> 소유자는 GameState.tournament 예약 레코드.
 *                     딜러 변경 전환 코드는 이 상태를 절대 건드리지 않는다.
 *                     해제는 작업 B-2의 대회 종료 정산만 할 수 있다.
 * 이 분리를 깨면 예약된 딜러가 조용히 풀린다 (계약 4).
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

/* ------------------------------------------------------------------ */
/* 대회 예약 (작업 B-1)                                                 */
/* ------------------------------------------------------------------ */

export type TournamentScale = 'small' | 'mid';

/**
 * 대회 생애주기 중 **B-1이 소유하는 구간**.
 *
 *   RESERVED_DRAINING  예약됨. 선택 테이블이 신규 일반 손님을 받지 않고
 *                      기존 세션이 끝나기를 기다린다 (Economy §8 진행순서 2).
 *   RESERVED_READY     선택 테이블의 기존 일반 세션이 모두 정산됐다.
 *                      **대회가 시작된 상태가 아니다.**
 *
 * RESERVED_READY 다음(대회 시작·진행 시간 계산·정산·자원 해제)은 전부 작업 B-2다.
 * B-2가 단계를 추가하면 여기에 이어 붙이고, assertSupported가 새 단계를
 * 미지원으로 걸러내므로 B-1 코드가 B-2 상태를 조용히 처리하는 일은 없다.
 */
export type TournamentPhase = 'RESERVED_DRAINING' | 'RESERVED_READY';

/**
 * 대회 예약 레코드. **권위 있는 유일한 저장소다.**
 * 별도의 예약 레지스트리를 두지 않는다 (계약: required_behavior).
 *
 * 직렬화만으로 자원 소유 관계를 복원할 수 있어야 하므로
 * 테이블·딜러 ID를 레코드 안에 함께 보관한다.
 */
export interface TournamentReservation {
  readonly id: string;
  readonly scale: TournamentScale;
  phase: TournamentPhase;
  /** 예약 시 수요로 확정한다. 이후 수요가 바뀌어도 변하지 않는다 (Economy §8). */
  readonly participants: number;
  /** 예약 테이블. 소규모는 정확히 2개. */
  readonly tableIds: readonly TableId[];
  /** tableIds와 같은 순서로 대응하는 담당 딜러. */
  readonly dealerIds: readonly StaffId[];
  /** 상금 + 참가자별 운영비 + 고정 개최비 (05 채택기록 R2). 잠긴 금액과 같다. */
  readonly prepCostUnits: Money;
  /** floor(경과 게임분 / minutesPerGameDay) */
  readonly gameDay: number;
  readonly reservedAtMinute: GameMinute;
  /** RESERVED_READY로 바뀐 시각. B-2가 진행 시작 시점으로 쓴다. */
  readyAtMinute: GameMinute | null;
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

  /**
   * 대회 예약. B-1이 만들고 소유한다.
   * 준비 단계(RESERVED_DRAINING / RESERVED_READY)만 지원하며
   * 그 밖의 단계는 assertSupported가 미지원으로 거절한다.
   */
  tournament: TournamentReservation | null;
  /** 작업 C. null이 아니면 엔진이 거절한다. */
  remodel: null;
  /** 작업 B-3. 긴급 축소 운영. 위와 동일. */
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
    nextTournamentSeq: number;
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
  | { readonly type: 'buyPromotion' }
  /**
   * 소규모 대회 예약 (B-1).
   * 플레이어가 테이블 ID 2개를 **명시적으로** 고른다.
   * 딜러는 그 테이블의 현재 담당자에서 파생한다. 자동 선택은 없다 (05 R9).
   */
  | { readonly type: 'reserveSmallTournament'; readonly tableIds: readonly TableId[] };

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
  | 'STAFF_HAS_ACTIVE_TABLE'
  // 대회 예약 (B-1)
  | 'TOURNAMENT_LOCKED'
  | 'TOURNAMENT_SCALE_UNAVAILABLE'
  | 'TOURNAMENT_TABLE_COUNT'
  | 'TOURNAMENT_TABLE_DUPLICATE'
  | 'TOURNAMENT_TABLE_NOT_OPERATING'
  | 'TOURNAMENT_TABLE_NO_DEALER'
  | 'TOURNAMENT_TABLE_DEALER_PENDING'
  | 'TOURNAMENT_DEALER_DUPLICATE'
  | 'TOURNAMENT_ALREADY_RESERVED'
  | 'TOURNAMENT_DAY_USED'
  | 'TOURNAMENT_PARTICIPANTS_TOO_FEW'
  | 'TOURNAMENT_RESERVE_SHORTFALL'
  | 'REMODEL_IN_PROGRESS';

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
  | { readonly type: 'tournamentReserved'; readonly tournamentId: string; readonly tableIds: readonly TableId[]; readonly dealerIds: readonly StaffId[]; readonly prepCostUnits: Money }
  | { readonly type: 'tournamentReady'; readonly tournamentId: string }
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
  /** 준비 단계를 넘어선 대회 진행. 작업 B-2. */
  | 'TOURNAMENT_NOT_IMPLEMENTED'
  | 'REMODEL_NOT_IMPLEMENTED'
  | 'EMERGENCY_NOT_IMPLEMENTED'
  | 'RULES_VERSION_MISMATCH'
  | 'SAVE_VERSION_MISMATCH';
