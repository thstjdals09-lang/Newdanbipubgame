/**
 * 경제 설정 데이터.
 *
 * 각 값에 출처를 표기한다.
 *   [확정]  GDD v1.0에서 확정된 값. 코드가 반드시 따른다.
 *   [초안]  Economy/Progression v0.1의 제안값. 밸런스 조정 대상.
 *   [채택]  05 채택기록 v1에서 이번 구현이 따르기로 한 규칙.
 *
 * 수치 변경만으로는 rulesVersion/saveVersion을 올리지 않는다 (04 §4).
 */

/** 1G = 60 내부 단위. 시간당 비용 G가 그대로 분당 units가 된다 (05 §4-1). */
export const MONEY_SCALE = 60;

/** G -> 내부 단위 */
export const gold = (g: number): number => {
  const units = g * MONEY_SCALE;
  if (!Number.isInteger(units)) {
    throw new Error(`화폐 단위가 정수가 아님: ${g}G -> ${units}units`);
  }
  return units;
};

/** 인지도·만족도는 x1000 정수 (05 §4-2) */
export const milli = (v: number): number => {
  const m = Math.round(v * 1000);
  if (Math.abs(m - v * 1000) > 1e-9) {
    throw new Error(`milli 변환이 정확하지 않음: ${v}`);
  }
  return m;
};

export type DealerType = 'normal' | 'skilled' | 'tournament';
export type StaffType = DealerType | 'service';
export type Stage = 1 | 2;

export interface StaffSpec {
  /** 게임 1시간당 급여 (G). 정수여야 분당 units가 정확해진다. */
  readonly wagePerHourGold: number;
  /** 담당 테이블 속도 배율 x1000. 일반 1000, 숙련 1200. */
  readonly tableSpeedMilli: number;
  /** 대회 운영 속도 배율 x1000 (작업 B에서 사용). */
  readonly tournamentSpeedMilli: number;
  /** 서비스 수용 기준 가산 (명). */
  readonly serviceCapacityBonus: number;
}

export interface TournamentSpec {
  readonly tables: number;
  readonly dealers: number;
  readonly minParticipants: number;
  readonly maxParticipants: number;
  /** 예상 참가자 = min(max, floor(D x multiplier)) */
  readonly demandMultiplier: number;
  readonly baseDurationMinutes: number;
  readonly entryFeeGold: number;
  readonly prizePerParticipantGold: number;
  readonly opCostPerParticipantGold: number;
  readonly fixedHostingGold: number;
  readonly awarenessRewardMilli: number;
}

export interface EconomyConfig {
  readonly rulesVersion: string;

  readonly money: {
    /** [초안 Economy §1] 정상 완료 세션 1건의 매출 */
    readonly sessionRevenueGold: number;
    /** [초안 Economy §1] 시작 자금 */
    readonly startingCashGold: number;
  };

  readonly time: {
    /** [초안 Economy §1] 기본 이용 시간 (게임 분). 딜러 속도로 나눈다. */
    readonly baseSessionMinutes: number;
    /** [초안 Economy §8] 게임 하루 길이 (분). 대회 개최권 단위. */
    readonly minutesPerGameDay: number;
  };

  readonly table: {
    /** [초안 Economy §1] 테이블당 좌석 수 */
    readonly seats: number;
    /** [초안 Economy §5] 운영·정리·대회 점유 테이블의 시간당 시설비 */
    readonly facilityCostPerHourGold: number;
    /** [확정 GDD §8] 단계별 테이블 상한 */
    readonly capByStage: Readonly<Record<Stage, number>>;
    /** [초안 Progression §3] 1~7번째 테이블 가격. index n = n번째 테이블. */
    readonly priceGoldByIndex: readonly number[];
    /** [초안 Progression §3] 8번째 이후: ceil(base x growth^(n-7) / 100) x 100 */
    readonly priceFormula: {
      readonly fromIndex: number;
      readonly baseGold: number;
      readonly growthMilli: number;
      readonly roundToGold: number;
    };
  };

  readonly venue: {
    /** [초안 Economy §5] 기본 매장 시간당 운영비 */
    readonly baseCostPerHourGold: number;
    /** [초안 Economy §1] 시작 인지도·만족도 */
    readonly startingAwarenessMilli: number;
    readonly startingSatisfactionMilli: number;
  };

  readonly staff: Readonly<Record<StaffType, StaffSpec>>;

  readonly hire: {
    /** [초안 Economy §5 / Progression §3] 고용 비용 */
    readonly normalDealerGold: number;
    readonly serviceStaffGold: number;
  };

  readonly demand: {
    /** [초안 Economy §3] 단계별 기본 방문 수요 x1000 */
    readonly baseByStageMilli: Readonly<Record<Stage, number>>;
    /** [초안 Economy §3] 완료 세션 1건당 인지도 증가 (milli) */
    readonly awarenessPerSessionMilli: number;
    /** [채택 05 §2 R4] 인지도 상한 */
    readonly awarenessMaxMilli: number;
    /** [초안 Economy §6] 만족도 하한·상한 */
    readonly satisfactionMinMilli: number;
    readonly satisfactionMaxMilli: number;
  };

  readonly queue: {
    /** [초안 Economy §4] 단계별 대기 정원 */
    readonly capacityByStage: Readonly<Record<Stage, number>>;
    /** [초안 Economy §4] 이 시간에 도달하면 착석 전 이탈 */
    readonly abandonAfterMinutes: number;
  };

  readonly satisfaction: {
    /** [초안 Economy §6] 서비스 수용 기준의 기본값 */
    readonly baseServiceCapacity: number;
    /** [초안 Economy §6] 목표 만족도 기준값 (milli) */
    readonly targetBaseMilli: number;
    /** [초안 Economy §5] 편의시설 레벨당 목표 만족도 가산 (milli) */
    readonly amenityBonusPerLevelMilli: number;
    /** [초안 Economy §6] 0.15 x (Q - 100) 의 분자/분모 */
    readonly qualityWeightNum: number;
    readonly qualityWeightDen: number;
    /** [초안 Economy §6] 10 x L 의 계수 (milli) */
    readonly abandonPenaltyMilli: number;
    /** [초안 Economy §6] 이탈률 집계 윈도우 (게임 분) */
    readonly abandonWindowMinutes: number;
  };

  readonly amenity: {
    /** [초안 Economy §5] 레벨별 개별 구매 비용 */
    readonly costGoldByLevel: readonly number[];
    readonly maxLevel: number;
    /** [초안 Progression §4] 해금 조건: 설치 테이블 수 */
    readonly unlockTableCount: number;
  };

  readonly promotion: {
    /** [채택 05 §2 R6] 검증용 기본값 on */
    readonly enabled: boolean;
    /** [초안 Economy §3] 지역 홍보 */
    readonly costGold: number;
    readonly awarenessGainMilli: number;
    readonly cooldownMinutes: number;
    /** 이 인지도 미만에서만 구매 가능 */
    readonly maxAwarenessMilli: number;
  };

  /**
   * [초안 Economy §8] 대회 수치.
   * 이번 구현은 준비비 계산만 사용한다. 예약·진행·정산은 작업 B.
   */
  readonly tournament: Readonly<Record<'small' | 'mid', TournamentSpec>>;

  readonly unlock: {
    /** [초안 Progression §4] 소규모 대회 해금 */
    readonly smallTournamentTableCount: number;
    readonly smallTournamentAwarenessMilli: number;
    /** [초안 Progression §4] 숙련 딜러 지급 해금 */
    readonly skilledDealerTableCount: number;
  };

  /**
   * [채택 — 잠정 밸런스] 대회 예약 시 요구하는 운영 예비금 (게임 시간).
   *
   * Economy §8("준비비 지급 후 운영 예비금 확보를 검사한다")과
   * Progression §3("대회와 리모델링의 운영 예비금 조건은 별도 필수 검사다")이
   * 필수 검사로 지정했으나 수치가 없던 항목이다. 05 채택기록 R10에서
   * **4게임시간**으로 채택했다. 잠정 밸런스 값이며 조정 대상이다.
   *
   * 예약 자격: 사용 가능 현금 >= 준비비 + 현재 시간당 운영비 x 4
   *
   * 적용 범위는 **대회 예약뿐이다.** 일반 구매의 4게임시간 경고(Progression §3)와
   * 리모델링의 `4 x C_after` 공식(Progression §5)은 건드리지 않는다.
   *
   * null이면 예비금 항을 요구하지 않는다(미채택 상태 표현용).
   */
  readonly tournamentOperatingReserveHours: number | null;

  /**
   * 실험용: 수요 피드백을 끊고 고정 수요를 쓴다.
   * 04 §1의 "수요와 인지도 변화를 고정해 처리 능력의 효과만 분리" 재현용.
   * 게임 플레이용 값이 아니며 null이 기본이다.
   */
  readonly fixedDemandMilliPerHour: number | null;
}

/** 05 채택기록 v1 §7 */

/**
 * 계산 순서·공식·반올림 규칙의 버전.
 *
 * B-1에서 올리지 않았다. 대회 예약은 새로운 상태를 추가했을 뿐
 * 수요·착석·만족도·매출·비용의 공식과 Economy §10의 9단계 순서를 바꾸지 않았다.
 * 예약이 없는 상태(tournament === null)의 모든 계산 결과는 이전과 비트 단위로 같고,
 * 기존 시간 분할·저장 복원·검산 재현 테스트가 그것을 검증한다.
 */
export const RULES_VERSION = 'economy-0.1+adopt-v1';

/**
 * 직렬화 스키마 버전.
 *
 * 1 -> 2 (B-1): GameState.tournament가 null 전용에서 예약 레코드를 담을 수 있게 되었고
 * records.nextTournamentSeq가 추가됐다.
 *
 * 2 -> 3 (B-2A): 대회 진행·정산 상태가 추가됐다.
 *   TournamentReservation.startedAtMinute / endsAtMinute
 *   records.totalTournamentRevenueUnits
 *   records.completedTournaments
 * 05 §7의 "상태 필드가 추가될 때" 규칙에 해당한다.
 *
 * 두 마이그레이션 모두 의미가 완전히 정의된다 (state.ts의 migrateSave 참조).
 * v2가 담을 수 있던 대회 상태(없음 / DRAINING / READY)는 그대로 보존한다.
 */
export const SAVE_VERSION = 3;

export const DEFAULT_CONFIG: EconomyConfig = {
  rulesVersion: RULES_VERSION,

  money: {
    sessionRevenueGold: 200,
    startingCashGold: 600,
  },

  time: {
    baseSessionMinutes: 120,
    minutesPerGameDay: 1440,
  },

  table: {
    seats: 8,
    facilityCostPerHourGold: 30,
    capByStage: { 1: 6, 2: 18 },
    // index 0은 사용하지 않는다. 1번째 테이블은 시작 시 무상 보유.
    priceGoldByIndex: [0, 0, 1200, 2400, 4200, 7000, 11000, 16000],
    priceFormula: {
      fromIndex: 8,
      baseGold: 16000,
      growthMilli: 1300,
      roundToGold: 100,
    },
  },

  venue: {
    baseCostPerHourGold: 40,
    startingAwarenessMilli: milli(0),
    startingSatisfactionMilli: milli(80),
  },

  staff: {
    normal: {
      wagePerHourGold: 80,
      tableSpeedMilli: 1000,
      tournamentSpeedMilli: 1000,
      serviceCapacityBonus: 0,
    },
    skilled: {
      wagePerHourGold: 110,
      tableSpeedMilli: 1200,
      tournamentSpeedMilli: 1000,
      serviceCapacityBonus: 0,
    },
    tournament: {
      wagePerHourGold: 100,
      tableSpeedMilli: 1000,
      tournamentSpeedMilli: 1250,
      serviceCapacityBonus: 0,
    },
    service: {
      wagePerHourGold: 60,
      tableSpeedMilli: 0,
      tournamentSpeedMilli: 0,
      serviceCapacityBonus: 16,
    },
  },

  hire: {
    normalDealerGold: 400,
    serviceStaffGold: 600,
  },

  demand: {
    baseByStageMilli: { 1: milli(3.5), 2: milli(6) },
    awarenessPerSessionMilli: milli(0.02),
    awarenessMaxMilli: milli(100),
    satisfactionMinMilli: milli(40),
    satisfactionMaxMilli: milli(95),
  },

  queue: {
    capacityByStage: { 1: 8, 2: 16 },
    abandonAfterMinutes: 30,
  },

  satisfaction: {
    baseServiceCapacity: 8,
    targetBaseMilli: milli(80),
    amenityBonusPerLevelMilli: milli(3),
    qualityWeightNum: 15,
    qualityWeightDen: 100,
    abandonPenaltyMilli: milli(10),
    abandonWindowMinutes: 360,
  },

  amenity: {
    costGoldByLevel: [0, 1000, 2500],
    maxLevel: 2,
    unlockTableCount: 2,
  },

  promotion: {
    enabled: true,
    costGold: 400,
    awarenessGainMilli: milli(5),
    cooldownMinutes: 360,
    maxAwarenessMilli: milli(40),
  },

  tournament: {
    small: {
      tables: 2,
      dealers: 2,
      minParticipants: 8,
      maxParticipants: 16,
      demandMultiplier: 2,
      baseDurationMinutes: 240,
      entryFeeGold: 180,
      prizePerParticipantGold: 60,
      opCostPerParticipantGold: 20,
      fixedHostingGold: 600,
      awarenessRewardMilli: milli(12),
    },
    mid: {
      tables: 4,
      dealers: 4,
      minParticipants: 16,
      maxParticipants: 32,
      demandMultiplier: 3,
      baseDurationMinutes: 360,
      entryFeeGold: 240,
      prizePerParticipantGold: 100,
      opCostPerParticipantGold: 30,
      fixedHostingGold: 1800,
      awarenessRewardMilli: milli(18),
    },
  },

  unlock: {
    smallTournamentTableCount: 3,
    smallTournamentAwarenessMilli: milli(10),
    skilledDealerTableCount: 3,
  },

  // 채택 (잠정). 05 채택기록 R10 참조.
  tournamentOperatingReserveHours: 4,

  fixedDemandMilliPerHour: null,
};
