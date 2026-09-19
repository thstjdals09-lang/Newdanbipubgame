/**
 * 첫 리모델링 (작업 C-1) 인수 테스트. R01~R20.
 *
 * 실제 엔진 동작을 검사한다. 기대값을 프로덕션 코드에 심어 통과시키지 않는다.
 * 필요한 상태에 도달했는지 먼저 단언하고, 조건이 안 맞으면 건너뛰는 테스트를 만들지 않는다.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, RULES_VERSION, SAVE_VERSION, gold, milli } from '../src/config/economy.js';
import type { EconomyConfig } from '../src/config/economy.js';
import { applyCommand, validateCommand } from '../src/engine/commands.js';
import { minuteCosts } from '../src/engine/costs.js';
import {
  availableCash,
  canInstallMoreTables,
  tablePriceGold,
  theoreticalCapacityMilli,
} from '../src/engine/derive.js';
import { forecast, forecastSmallTournament } from '../src/engine/forecast.js';
import { remodelCostBreakdown, planRemodel } from '../src/engine/remodel.js';
import { cloneState, createInitialState, deserialize, serialize } from '../src/engine/state.js';
import { tick } from '../src/engine/tick.js';
import type { Command, GameState, TournamentCompletionRecord } from '../src/engine/types.js';
import { G, fixedDemandConfig, labState, run } from './helpers.js';

const REQUEST: Command = { type: 'requestRemodel' };
const demandConfig = fixedDemandConfig(20);
const noDemand = fixedDemandConfig(0);

/** 소규모 대회 완료 기록 n건을 만든다 (조건 충족용 — 대회 자체는 B-2가 검증한다) */
function fakeCompletions(n: number): TournamentCompletionRecord[] {
  const out: TournamentCompletionRecord[] = [];
  for (let i = 1; i <= n; i += 1) {
    out.push({
      id: `TN${i}`,
      scale: 'small',
      participants: 16,
      gameDay: i - 1,
      startedAtMinute: i * 100,
      completedAtMinute: i * 100 + 240,
      prepCostUnits: gold(1880),
      entryFeeUnits: gold(2880),
      awarenessGainedMilli: milli(12),
      tableIds: ['T1', 'T2'],
      dealerIds: ['D1', 'D2'],
    });
  }
  return out;
}

/**
 * 리모델링 조건을 충족한 1단계 매장.
 * **딜러는 기본 3명** — 딜러 6명이 조건이 아님을 기본 상태로 못박는다.
 */
function eligibleState(
  config: EconomyConfig,
  opts: { dealers?: number; cashGold?: number; warmupMinutes?: number } = {},
): GameState {
  const state = labState(
    { tables: 6, dealers: opts.dealers ?? 3, cashGold: opts.cashGold ?? 60_000 },
    config,
  );
  state.venue.awarenessMilli = milli(50);
  state.records.completedTournaments = fakeCompletions(2);
  state.records.tournamentsDone = 2;
  state.records.usedTournamentDays = [0, 1];
  return opts.warmupMinutes ? run(state, opts.warmupMinutes, config) : run(state, 1, config);
}

/** 리모델링이 완료될 때까지 진행한다 */
function runUntilRemodelDone(start: GameState, config: EconomyConfig) {
  let cur = start;
  for (let i = 0; i < 3000; i += 1) {
    const r = tick(cur, config);
    cur = r.state;
    if (r.events.some((e) => e.type === 'remodelCompleted')) {
      return { state: cur, completedAtMinute: cur.time.minute };
    }
  }
  throw new Error('리모델링이 완료되지 않았다');
}

/* ------------------------------------------------------------------ */
/* 시작 조건                                                            */
/* ------------------------------------------------------------------ */

describe('R01~R05 시작 조건', () => {
  it('R01. 딜러 3명으로도 다른 조건을 만족하면 리모델링할 수 있다 (P07)', () => {
    const state = eligibleState(demandConfig, { dealers: 3 });

    // 재현 조건 확인
    expect(state.venue.stage).toBe(1);
    expect(state.tables).toHaveLength(6);
    expect(state.staff.filter((s) => s.duty === 'working')).toHaveLength(3);
    expect(state.tables.filter((t) => t.status === 'operating')).toHaveLength(3);

    const r = validateCommand(state, REQUEST, demandConfig);
    expect(r.ok).toBe(true);
  });

  it('R05a. 테이블 6개 미만이면 거절한다', () => {
    const state = eligibleState(demandConfig);
    state.tables = state.tables.slice(0, 5);
    const r = validateCommand(state, REQUEST, demandConfig);
    expect(r.reason).toBe('REMODEL_TABLES_REQUIRED');
  });

  it('R05b. 인지도 50 미만이면 거절한다', () => {
    const state = eligibleState(demandConfig);
    state.venue.awarenessMilli = milli(49.999);
    expect(validateCommand(state, REQUEST, demandConfig).reason).toBe('REMODEL_AWARENESS_REQUIRED');
  });

  it('R05c. 소규모 대회 완료 1회면 거절한다', () => {
    const state = eligibleState(demandConfig);
    state.records.completedTournaments = fakeCompletions(1);
    expect(validateCommand(state, REQUEST, demandConfig).reason).toBe(
      'REMODEL_TOURNAMENTS_REQUIRED',
    );
  });

  it('R02. 대회가 남아 있으면 거절한다 (P08)', () => {
    const state = eligibleState(demandConfig);
    (state as { tournament: unknown }).tournament = {
      id: 'TN9',
      scale: 'small',
      phase: 'RESERVED_DRAINING',
      participants: 16,
      tableIds: ['T1', 'T2'],
      dealerIds: ['D1', 'D2'],
      prepCostUnits: gold(1880),
      gameDay: 2,
      reservedAtMinute: 1,
      readyAtMinute: null,
      startedAtMinute: null,
      endsAtMinute: null,
    };
    expect(validateCommand(state, REQUEST, demandConfig).reason).toBe('REMODEL_TOURNAMENT_ACTIVE');
  });

  it('R03. 긴급 운영 중에는 거절한다', () => {
    const config = noDemand;
    const state = eligibleState(config);
    state.venue.cash = minuteCosts(state, config).total - 1;
    const inEmergency = tick(state, config).state;
    expect(inEmergency.emergency).not.toBeNull();

    expect(validateCommand(inEmergency, REQUEST, config).reason).toBe('EMERGENCY_ACTIVE');
  });

  it('반영되지 않은 딜러 교체 예약이 있으면 거절한다', () => {
    const config = demandConfig;
    const state = eligibleState(config, { warmupMinutes: 150 });
    state.staff.push({ id: 'SPARE', type: 'normal', duty: 'standby', assignedTableId: null });
    applyCommand(state, { type: 'assignDealer', tableId: 'T1', staffId: 'SPARE' }, config, []);
    expect(state.tables.find((t) => t.id === 'T1')!.pendingDealerId).toBe('SPARE');

    expect(validateCommand(state, REQUEST, config).reason).toBe('REMODEL_DEALER_CHANGE_PENDING');
  });
});

describe('R04 비용과 운영 예비금', () => {
  it('필요 현금 = 15,000G + T x C_before + 4 x C_after', () => {
    const config = demandConfig;
    const state = eligibleState(config, { warmupMinutes: 150 });
    const cost = remodelCostBreakdown(state, config);

    expect(G(cost.costUnits)).toBe(15_000);
    expect(cost.hourlyCostUnits).toBe(minuteCosts(state, config).total * 60);
    expect(cost.drainCostUnits).toBe(cost.hourlyCostUnits * cost.drainHours);
    expect(cost.reserveUnits).toBe(cost.hourlyCostUnits * config.remodel.reserveHours);
    expect(cost.requiredUnits).toBe(
      cost.costUnits + cost.drainCostUnits + cost.reserveUnits,
    );
    // 세션이 진행 중이므로 정리 시간이 0보다 크다
    expect(cost.drainHours).toBeGreaterThan(0);
  });

  it('R04. 비용만 있고 예비금이 없으면 거절하고 상태를 바꾸지 않는다 (P09)', () => {
    const config = demandConfig;
    const state = eligibleState(config, { warmupMinutes: 150 });
    const cost = remodelCostBreakdown(state, config);

    state.venue.cash = cost.requiredUnits - 1;
    const r = validateCommand(state, REQUEST, config);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('REMODEL_RESERVE_SHORTFALL');

    const before = serialize(state);
    const result = tick(cloneState(state), config, [REQUEST]);
    expect(result.events.filter((e) => e.type === 'commandRejected')).toHaveLength(1);
    expect(serialize(state)).toBe(before);
    expect(result.state.remodel).toBeNull();
    expect(result.state.venue.lockedCash).toBe(0);
    expect(result.state.venue.stage).toBe(1);
  });

  it('필요 금액과 정확히 같으면 통과하고 1unit 부족하면 거절한다', () => {
    const config = demandConfig;
    const state = eligibleState(config, { warmupMinutes: 150 });
    const required = remodelCostBreakdown(state, config).requiredUnits;

    state.venue.cash = required;
    expect(validateCommand(state, REQUEST, config).ok).toBe(true);
    state.venue.cash = required - 1;
    expect(validateCommand(state, REQUEST, config).ok).toBe(false);
  });

  it('비용 자체를 못 내면 INSUFFICIENT_CASH로 구분한다', () => {
    const config = demandConfig;
    const state = eligibleState(config);
    state.venue.cash = gold(100);
    expect(validateCommand(state, REQUEST, config).reason).toBe('INSUFFICIENT_CASH');
  });
});

/* ------------------------------------------------------------------ */
/* 공사 중 동작                                                          */
/* ------------------------------------------------------------------ */

describe('공사 중 동작', () => {
  it('요청 즉시 비용이 잠기고 cash는 줄지 않는다', () => {
    const config = demandConfig;
    const state = eligibleState(config, { warmupMinutes: 150 });
    const cashBefore = state.venue.cash;
    const availBefore = availableCash(state);

    applyCommand(state, REQUEST, config, []);

    expect(state.remodel).not.toBeNull();
    expect(state.remodel!.phase).toBe('PREPARING');
    expect(state.venue.cash).toBe(cashBefore);
    expect(state.venue.lockedCash).toBe(gold(15_000));
    expect(availableCash(state)).toBe(availBefore - gold(15_000));
  });

  it('대기 손님을 해산하되 이탈·방문 통계에 기록하지 않는다', () => {
    const config = fixedDemandConfig(60); // 대기가 쌓이는 높은 수요
    const state = eligibleState(config, { warmupMinutes: 200 });
    expect(state.queue.length).toBeGreaterThan(0);

    const arrivalsBefore = state.window.sumArrivals;
    const abandonsBefore = state.window.sumAbandons;

    const events: ReturnType<typeof tick>['events'] = [];
    applyCommand(state, REQUEST, config, events);

    expect(state.queue).toHaveLength(0);
    expect(events.some((e) => e.type === 'remodelQueueDissolved')).toBe(true);
    // 허위 기록을 추가하지 않는다
    expect(state.window.sumArrivals).toBe(arrivalsBefore);
    expect(state.window.sumAbandons).toBe(abandonsBefore);
  });

  it('R06. 신규 방문이 생기지 않고 착석도 없다', () => {
    const config = demandConfig;
    const state = eligibleState(config, { warmupMinutes: 150 });
    applyCommand(state, REQUEST, config, []);
    const sessionsBefore = new Set(state.sessions.map((s) => s.id));
    const carryBefore = state.time.arrivalCarry;

    let cur = state;
    for (let i = 0; i < 60; i += 1) {
      const r = tick(cur, config);
      cur = r.state;
      expect(r.events.some((e) => e.type === 'guestArrived')).toBe(false);
      expect(r.events.some((e) => e.type === 'guestSeated')).toBe(false);
      for (const s of cur.sessions) expect(sessionsBefore.has(s.id)).toBe(true);
    }
    // 누적값도 멈춘다 — 공사가 끝나는 순간 손님이 몰려나오지 않는다
    expect(cur.time.arrivalCarry).toBe(carryBefore);
    expect(theoreticalCapacityMilli(cur, config)).toBe(0);
  });

  it('만족도는 공사 기간 고정된다', () => {
    const config = demandConfig;
    const state = eligibleState(config, { warmupMinutes: 150 });
    applyCommand(state, REQUEST, config, []);
    const satBefore = state.venue.satisfactionMilli;
    const remBefore = state.venue.satisfactionRemainder;

    const later = run(state, 60, config);
    expect(later.remodel).not.toBeNull();
    expect(later.venue.satisfactionMilli).toBe(satBefore);
    expect(later.venue.satisfactionRemainder).toBe(remBefore);
  });

  it('R07. 기존 세션이 완료 시각·매출 그대로 정확히 한 번 정산된다', () => {
    const config = demandConfig;
    const state = eligibleState(config, { warmupMinutes: 150 });
    applyCommand(state, REQUEST, config, []);

    const snapshot = state.sessions.map((s) => ({
      id: s.id,
      endsAtMinute: s.endsAtMinute,
      revenueUnits: s.revenueUnits,
    }));
    expect(snapshot.length).toBeGreaterThan(0);

    const settled = new Map<string, number>();
    let cur = state;
    for (let i = 0; i < 300; i += 1) {
      const r = tick(cur, config);
      cur = r.state;
      for (const e of r.events) {
        if (e.type === 'sessionCompleted') {
          settled.set(e.sessionId, (settled.get(e.sessionId) ?? 0) + 1);
        }
      }
      if (cur.remodel === null) break;
    }

    for (const s of snapshot) expect(settled.get(s.id)).toBe(1);
    // 매출은 완료 이용객 x 200G 불변식을 유지한다
    expect(cur.records.totalRevenueUnits).toBe(cur.records.completedGuests * gold(200));
  });

  it('공사 중에도 반복 비용은 계속 부과된다', () => {
    const config = demandConfig;
    const state = eligibleState(config, { warmupMinutes: 150 });
    applyCommand(state, REQUEST, config, []);
    const before =
      state.records.totalWageUnits + state.records.totalFacilityUnits + state.records.totalVenueCostUnits;
    const hourly = minuteCosts(state, config).total * 60;

    const after = run(state, 60, config);
    const delta =
      after.records.totalWageUnits + after.records.totalFacilityUnits + after.records.totalVenueCostUnits - before;
    expect(delta).toBe(hourly);
  });

  it('R08. 공사 중 명령은 REMODEL_ACTIVE로 거절한다', () => {
    const config = demandConfig;
    const state = eligibleState(config, { warmupMinutes: 150, cashGold: 200_000 });
    applyCommand(state, REQUEST, config, []);

    const blocked: Command[] = [
      { type: 'buyTable' },
      { type: 'hireDealer' },
      { type: 'hireServiceStaff' },
      { type: 'upgradeAmenity' },
      { type: 'buyPromotion' },
      { type: 'reserveSmallTournament', tableIds: ['T1', 'T2'] },
      { type: 'assignDealer', tableId: 'T1', staffId: 'D1' },
      { type: 'unassignDealer', tableId: 'T1' },
      { type: 'setStaffStandby', staffId: 'D1' },
      { type: 'requestRemodel' },
    ];
    for (const command of blocked) {
      const r = validateCommand(state, command, config);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('REMODEL_ACTIVE');
    }
  });

  it('거절된 명령이 공사 상태를 바꾸지 않는다', () => {
    const config = demandConfig;
    const state = eligibleState(config, { warmupMinutes: 150 });
    applyCommand(state, REQUEST, config, []);
    const before = serialize(state);

    const withCmd = tick(cloneState(state), config, [{ type: 'buyTable' }]);
    const withoutCmd = tick(cloneState(state), config, []);
    expect(serialize(state)).toBe(before);
    expect(serialize(withCmd.state)).toBe(serialize(withoutCmd.state));
  });
});

/* ------------------------------------------------------------------ */
/* 전환                                                                 */
/* ------------------------------------------------------------------ */

describe('R09~R13 전환', () => {
  it('R09/R11. 테이블·직원 ID와 배치, 자산·기록이 모두 보존된다', () => {
    const config = demandConfig;
    const state = eligibleState(config, { warmupMinutes: 150 });
    applyCommand(state, REQUEST, config, []);

    const before = {
      tables: state.tables.map((t) => `${t.id}:${t.spotIndex}:${t.floor}:${t.dealerId}`).sort(),
      staff: state.staff.map((s) => `${s.id}:${s.type}:${s.duty}:${s.assignedTableId}`).sort(),
      awareness: state.venue.awarenessMilli,
      satisfaction: state.venue.satisfactionMilli,
      unlocks: state.unlocks.map((u) => u.id).sort(),
      tournaments: JSON.stringify(state.records.completedTournaments),
      usedDays: [...state.records.usedTournamentDays],
      promoReady: state.records.promoReadyMinute,
      amenity: state.venue.amenityLevel,
      theme: state.venue.themeId,
    };

    const { state: done } = runUntilRemodelDone(state, config);

    expect(done.venue.stage).toBe(2);
    expect(done.tables.map((t) => `${t.id}:${t.spotIndex}:${t.floor}:${t.dealerId}`).sort()).toEqual(
      before.tables,
    );
    expect(done.staff.map((s) => `${s.id}:${s.type}:${s.duty}:${s.assignedTableId}`).sort()).toEqual(
      before.staff,
    );
    expect(done.venue.awarenessMilli).toBeGreaterThanOrEqual(before.awareness);
    expect(JSON.stringify(done.records.completedTournaments)).toBe(before.tournaments);
    expect(done.records.usedTournamentDays).toEqual(before.usedDays);
    expect(done.records.promoReadyMinute).toBe(before.promoReady);
    expect(done.venue.amenityLevel).toBe(before.amenity);
    expect(done.venue.themeId).toBe(before.theme); // 테마는 유지
    // 기존 해금이 사라지지 않았다
    for (const id of before.unlocks) expect(done.unlocks.map((u) => u.id)).toContain(id);
  });

  it('R10. 15,000G가 정확히 한 번 지출되고 잠금이 풀린다', () => {
    const config = demandConfig;
    const state = eligibleState(config, { warmupMinutes: 150 });
    const oneOffBefore = state.records.totalOneOffUnits;
    applyCommand(state, REQUEST, config, []);

    const { state: done } = runUntilRemodelDone(state, config);

    expect(done.venue.lockedCash).toBe(0);
    expect(done.records.totalOneOffUnits).toBe(oneOffBefore + gold(15_000));
    const entries = done.ledger.filter((l) => l.purpose.startsWith('remodel:'));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.amountUnits).toBe(-gold(15_000));
    expect(done.records.completedRemodels).toHaveLength(1);

    // 계속 돌려도 두 번 지출되지 않는다
    const later = run(done, 300, config);
    expect(later.records.totalOneOffUnits).toBe(oneOffBefore + gold(15_000));
    expect(later.records.completedRemodels).toHaveLength(1);
    expect(later.ledger.filter((l) => l.purpose.startsWith('remodel:'))).toHaveLength(1);
  });

  it('R12. 2단계 수요는 완료 다음 분부터 적용된다', () => {
    const config = DEFAULT_CONFIG; // 고정 수요가 아니라 실제 공식을 쓴다
    const state = eligibleState(config, { warmupMinutes: 150 });
    applyCommand(state, REQUEST, config, []);

    let cur = state;
    let completedAt = -1;
    for (let i = 0; i < 300; i += 1) {
      const r = tick(cur, config);
      cur = r.state;
      if (r.events.some((e) => e.type === 'remodelCompleted')) {
        completedAt = cur.time.minute;
        break;
      }
    }
    expect(completedAt).toBeGreaterThan(0);
    expect(cur.venue.stage).toBe(2);

    // 완료된 분에는 방문이 없다 (5단계가 공사 중 기준으로 계산됨)
    const carryAtCompletion = cur.time.arrivalCarry;
    const next = tick(cur, config);
    // 다음 분부터 2단계 기본 수요로 누적이 재개된다
    expect(next.state.time.arrivalCarry).not.toBe(carryAtCompletion);
    const base2 = config.demand.baseByStageMilli[2];
    const expectedNum =
      base2 * (10000 + cur.venue.awarenessMilli) * (150000 + cur.venue.satisfactionMilli);
    expect(next.state.time.arrivalCarry).toBe((carryAtCompletion + expectedNum) % 1.2e14);
  });

  it('R13. 테이블 상한과 대기 정원이 2단계 값으로 바뀐다', () => {
    const config = demandConfig;
    const state = eligibleState(config, { warmupMinutes: 150 });
    expect(canInstallMoreTables(state, config)).toBe(false); // 1단계 상한 6

    applyCommand(state, REQUEST, config, []);
    const { state: done } = runUntilRemodelDone(state, config);

    expect(canInstallMoreTables(done, config)).toBe(true); // 2단계 상한 18
    expect(config.queue.capacityByStage[done.venue.stage]).toBe(16);
  });

  it('두 번째 테마가 해금되고 중복되지 않는다', () => {
    const config = demandConfig;
    const state = eligibleState(config, { warmupMinutes: 150 });
    applyCommand(state, REQUEST, config, []);
    const { state: done } = runUntilRemodelDone(state, config);

    const later = run(done, 100, config);
    const secondTheme = later.unlocks.filter((u) => u.id === 'secondTheme');
    expect(secondTheme).toHaveLength(1);
  });

  it('리모델링을 두 번 요청할 수 없다', () => {
    const config = demandConfig;
    const state = eligibleState(config, { warmupMinutes: 150 });
    applyCommand(state, REQUEST, config, []);
    const { state: done } = runUntilRemodelDone(state, config);

    const r = validateCommand(done, REQUEST, config);
    expect(r.ok).toBe(false);
    // 2단계에서는 출발 단계 조건부터 맞지 않는다
    expect(r.reason).toBe('REMODEL_STAGE_NOT_ELIGIBLE');
  });
});

/* ------------------------------------------------------------------ */
/* 7번째 테이블                                                         */
/* ------------------------------------------------------------------ */

describe('R16~R17 7번째 테이블', () => {
  it('R16. 정상 영업으로 자금을 모아 7번째 테이블을 구매·배치·운영한다', () => {
    // 수요 40명/시간. 1단계 6테이블(각 8석, 세션 120분)의 처리량은 24명/시간이므로
    // 앞 번호 테이블이 포화된다. 그래야 새로 산 7번 테이블(spotIndex가 가장 큼)에
    // 실제로 손님이 앉는지 확인할 수 있다.
    const config = fixedDemandConfig(40);
    // 리모델링 직후 잔액이 테이블 값을 이미 넘고 있으면 "모아서 산다"를 검증할 수 없다.
    // 요청 시점 요건(비용 15,000G + 4게임시간 예비금)만 겨우 넘는 자금으로 시작한다.
    const state = eligibleState(config, { dealers: 6, cashGold: 18_000, warmupMinutes: 150 });
    applyCommand(state, REQUEST, config, []);
    const { state: done } = runUntilRemodelDone(state, config);

    // 7번째 테이블은 무료가 아니다
    const price = gold(tablePriceGold(7, config));
    expect(G(price)).toBe(16_000);

    // 6명이 모두 근무 중이므로 7번 테이블에 붙일 딜러도 따로 고용해야 한다.
    const hireCost = gold(config.hire.normalDealerGold);
    // 전제: 리모델링 직후 잔액으로는 아직 살 수 없다. 영업으로 모아야 한다.
    expect(availableCash(done)).toBeLessThan(price + hireCost);

    // 자금이 모일 때까지 정상 영업한다 (자금 주입 없음)
    let cur = done;
    let hired = false;
    let bought = false;
    for (let i = 0; i < 4000; i += 1) {
      if (!hired && availableCash(cur) >= price + hireCost) {
        cur = tick(cur, config, [{ type: 'hireDealer' }]).state;
        hired = true;
        continue;
      }
      if (hired && !bought && validateCommand(cur, { type: 'buyTable' }, config).ok) {
        cur = tick(cur, config, [{ type: 'buyTable' }]).state;
        bought = true;
        continue;
      }
      cur = tick(cur, config).state;
      if (bought && cur.sessions.some((s) => s.tableId === 'T7')) break;
    }

    expect(hired).toBe(true);
    expect(bought).toBe(true);
    // 모자란 돈은 영업 매출로 메웠다 — 긴급 지원을 받지 않았다.
    expect(cur.records.totalRevenueUnits).toBeGreaterThan(done.records.totalRevenueUnits);
    expect(cur.records.totalEmergencySupportUnits).toBe(0);
    // 일회성 지출 누계는 딱 테이블 값과 고용비만큼 늘었다 (다른 지출이 섞이지 않았다)
    expect(cur.records.totalOneOffUnits - done.records.totalOneOffUnits).toBe(price + hireCost);

    const t7 = cur.tables.find((t) => t.id === 'T7');
    expect(t7).toBeDefined();
    expect(t7!.spotIndex).toBe(7);
    expect(t7!.floor).toBe(2); // 2층 첫 설치 지점
    expect(t7!.status).toBe('operating');
    expect(t7!.dealerId).not.toBeNull();

    // 실제로 손님이 앉고 매출이 난다
    expect(cur.sessions.some((s) => s.tableId === 'T7')).toBe(true);
    const revenueBefore = cur.records.totalRevenueUnits;
    const later = run(cur, 200, config);
    expect(later.records.totalRevenueUnits).toBeGreaterThan(revenueBefore);
    expect(later.sessions.some((s) => s.tableId === 'T7')).toBe(true);
  });

  it('R17. 18번째까지 설치되고 19번째는 차단된다', () => {
    const config = demandConfig;
    const state = eligibleState(config, { warmupMinutes: 150 });
    applyCommand(state, REQUEST, config, []);
    const { state: done } = runUntilRemodelDone(state, config);

    const rich = cloneState(done);
    rich.venue.cash = gold(5_000_000);
    let cur = rich;
    for (let i = 7; i <= 18; i += 1) {
      expect(validateCommand(cur, { type: 'buyTable' }, config).ok).toBe(true);
      applyCommand(cur, { type: 'buyTable' }, config, []);
    }
    expect(cur.tables).toHaveLength(18);
    expect(validateCommand(cur, { type: 'buyTable' }, config).reason).toBe('TABLE_CAP_REACHED');
  });
});

/* ------------------------------------------------------------------ */
/* 긴급 운영 연결                                                        */
/* ------------------------------------------------------------------ */

describe('공사 중 긴급 운영 (B-1 결정 ①)', () => {
  /**
   * 공사 중 자금을 말려 긴급 운영을 발동시킨다.
   *
   * 워밍업 길이가 곧 "정리 기간에 들어올 매출"을 정한다. 워밍업 중 앉은 손님은
   * 공사 준비 기간에 차례로 정산되어 1인당 200G씩 들어오고, 그 합이 종료 기준액
   * (분당 비용 x 240)을 넘으면 공사 중에 긴급 운영이 정상 종료된다.
   * 종료 여부를 실제로 가르는 값이므로 테스트마다 명시해서 쓴다.
   */
  function starvedDuringRemodel(config: EconomyConfig, warmupMinutes = 20) {
    const state = eligibleState(config, { warmupMinutes });
    applyCommand(state, REQUEST, config, []);
    expect(state.remodel).not.toBeNull();
    expect(state.sessions.length).toBeGreaterThan(0);
    // 잠긴 15,000G는 그대로 두고 자기 자금만 말린다
    state.venue.cash = state.venue.lockedCash + minuteCosts(state, config).total - 1;
    return state;
  }

  it('재현 조건이 성립한다', () => {
    const state = starvedDuringRemodel(demandConfig);
    expect(state.venue.lockedCash).toBe(gold(15_000));
    expect(availableCash(state)).toBe(minuteCosts(state, demandConfig).total - 1);
    expect(state.tables.filter((t) => t.status === 'operating').length).toBeGreaterThan(1);
  });

  it('지원은 정상 처리하되 축소는 유예한다', () => {
    const config = demandConfig;
    const state = starvedDuringRemodel(config);
    const tablesBefore = state.tables.map((t) => `${t.id}:${t.status}:${t.dealerId}`).sort();
    const staffBefore = state.staff.map((s) => `${s.id}:${s.duty}:${s.assignedTableId}`).sort();

    const r = tick(state, config);
    expect(r.state.emergency).not.toBeNull();
    expect(r.state.records.totalEmergencySupportUnits).toBe(1); // 부족액만
    expect(r.events.some((e) => e.type === 'emergencyDownsizeDeferred')).toBe(true);

    // 축소가 일어나지 않았다
    expect(r.state.tables.map((t) => `${t.id}:${t.status}:${t.dealerId}`).sort()).toEqual(
      tablesBefore,
    );
    expect(r.state.staff.map((s) => `${s.id}:${s.duty}:${s.assignedTableId}`).sort()).toEqual(
      staffBefore,
    );
    expect(r.state.emergency!.keptTableId).toBeNull();

    // 잠긴 리모델링 비용은 운영비로 쓰이지 않았다
    expect(r.state.venue.lockedCash).toBe(gold(15_000));
    // 지원금이 리모델링 비용을 충당하지 않았다
    expect(r.state.records.totalEmergencySupportUnits).toBeLessThan(gold(15_000));
  });

  it('공사 중 세션은 중단되지 않고 정상 완료된다', () => {
    const config = demandConfig;
    const state = starvedDuringRemodel(config);
    const ids = state.sessions.map((s) => s.id);
    expect(ids.length).toBeGreaterThan(0);

    const settled = new Map<string, number>();
    let cur = state;
    for (let i = 0; i < 300; i += 1) {
      const r = tick(cur, config);
      cur = r.state;
      for (const e of r.events) {
        if (e.type === 'sessionCompleted') settled.set(e.sessionId, (settled.get(e.sessionId) ?? 0) + 1);
      }
      if (cur.remodel === null) break;
    }
    for (const id of ids) expect(settled.get(id)).toBe(1);
  });

  it('공사가 끝나도 긴급 운영을 임의로 종료하지 않고, 다음 분에 유예된 축소를 적용한다', () => {
    const config = noDemand; // 신규 매출이 없어 회복되지 않는다
    // 워밍업 6분 -> 진행 중 세션 2건. 정리 기간 매출 400G는 축소 완료 상태의
    // 종료 기준액 600G에 못 미치므로, 공사가 끝나도 긴급 운영이 이어진다.
    const state = starvedDuringRemodel(demandConfig, 6);

    let cur = state;
    let completedAt = -1;
    for (let i = 0; i < 400; i += 1) {
      const r = tick(cur, config);
      cur = r.state;
      if (r.events.some((e) => e.type === 'remodelCompleted')) {
        completedAt = cur.time.minute;
        break;
      }
    }
    expect(completedAt).toBeGreaterThan(0);
    expect(cur.venue.stage).toBe(2);

    // 완료된 분에는 긴급 운영이 살아 있고 축소도 아직 없다
    expect(cur.emergency).not.toBeNull();
    expect(cur.emergency!.keptTableId).toBeNull();
    const operatingAtCompletion = cur.tables.filter((t) => t.status === 'operating').length;
    expect(operatingAtCompletion).toBeGreaterThan(1);

    // 전제 확인: 자기 자금이 종료 기준액에 못 미친다. 회복해서 끝난 게 아니다.
    expect(availableCash(cur)).toBeLessThan(minuteCosts(cur, config).total * 240);

    // 다음 분에 유예된 축소가 적용된다
    const r = tick(cur, config);
    const next = r.state;
    expect(r.events.some((e) => e.type === 'emergencyKeptSelected')).toBe(true);
    expect(r.events.some((e) => e.type === 'emergencyDownsizeDeferred')).toBe(false);
    expect(next.emergency).not.toBeNull();
    expect(next.emergency!.keptTableId).not.toBeNull();
    expect(next.tables.filter((t) => t.status === 'operating')).toHaveLength(1);
    // 리모델링이 남긴 자산은 축소로도 사라지지 않는다
    expect(next.tables.map((t) => t.id)).toEqual(cur.tables.map((t) => t.id));
    expect(next.staff.map((s) => s.id)).toEqual(cur.staff.map((s) => s.id));
    expect(next.records.completedRemodels).toHaveLength(1);
  });

  it('공사 중 정상 종료 조건을 채우면 그 자리에서 끝나고 완료 후 축소가 없다', () => {
    const config = noDemand;
    // 워밍업 20분 -> 진행 중 세션 6건. 정리 기간에 들어오는 매출 1,200G가
    // B-3와 같은 기준액(축소했다면 남았을 배치의 4게임시간 운영비 600G)을 넘긴다.
    const state = starvedDuringRemodel(demandConfig, 20);

    let cur = state;
    let sawEmergency = false;
    let sawDeferred = false;
    let endedAt = -1;
    let completedAt = -1;
    let sawKeptSelected = false;
    for (let i = 0; i < 400; i += 1) {
      const r = tick(cur, config);
      cur = r.state;
      if (r.state.emergency !== null) sawEmergency = true;
      if (r.events.some((e) => e.type === 'emergencyDownsizeDeferred')) sawDeferred = true;
      if (r.events.some((e) => e.type === 'emergencyKeptSelected')) sawKeptSelected = true;
      if (endedAt < 0 && r.events.some((e) => e.type === 'emergencyEnded')) {
        endedAt = cur.time.minute;
      }
      if (r.events.some((e) => e.type === 'remodelCompleted')) {
        completedAt = cur.time.minute;
        break;
      }
    }

    // 공사 중에 긴급 운영이 발동했고 축소는 유예됐다
    expect(sawEmergency).toBe(true);
    expect(sawDeferred).toBe(true);
    expect(completedAt).toBeGreaterThan(0);
    expect(cur.venue.stage).toBe(2);

    // 자금 조건을 채운 시점(= 공사 중)에 이미 끝났다
    expect(endedAt).toBeGreaterThan(0);
    expect(endedAt).toBeLessThanOrEqual(completedAt);
    expect(cur.emergency).toBeNull();

    // 어느 시점에도 유지 대상을 고르지 않았다 — 축소 자체가 없었다
    expect(sawKeptSelected).toBe(false);
    expect(cur.tables.filter((t) => t.status === 'operating').length).toBeGreaterThan(1);

    // 완료 다음 분에도 뒤늦은 축소가 일어나지 않는다
    const next = tick(cur, config);
    expect(next.state.emergency).toBeNull();
    expect(next.events.some((e) => e.type === 'emergencyKeptSelected')).toBe(false);
    expect(next.state.tables.filter((t) => t.status === 'operating').length).toBeGreaterThan(1);
  });

  it('공사 중 자금이 회복되면 축소 없이 긴급 운영이 끝난다', () => {
    const config = demandConfig;
    const state = starvedDuringRemodel(config);
    const afterSupport = tick(state, config).state;
    expect(afterSupport.emergency).not.toBeNull();

    // 자기 자금을 회복시킨다 (잠긴 비용은 그대로)
    const recovered = cloneState(afterSupport);
    recovered.venue.cash =
      recovered.venue.lockedCash + minuteCosts(recovered, config).total * 240 * 2;

    const r = tick(recovered, config);
    expect(r.events.some((e) => e.type === 'emergencyEnded')).toBe(true);
    expect(r.state.emergency).toBeNull();
    // 불필요한 축소를 하지 않았다
    expect(r.state.tables.filter((t) => t.status === 'operating').length).toBeGreaterThan(1);
    expect(r.state.venue.lockedCash).toBe(gold(15_000));
  });

  it('공사 중 긴급 운영에서도 시간이 진행되고 저장·복원이 가능하다', () => {
    const config = demandConfig;
    const state = starvedDuringRemodel(config);
    const mid = run(state, 30, config);
    expect(mid.emergency).not.toBeNull();
    expect(mid.remodel).not.toBeNull();
    expect(mid.records.totalEmergencySupportUnits).toBeGreaterThan(0);

    const restored = deserialize(serialize(mid), config);
    expect(serialize(restored)).toBe(serialize(mid));
    expect(serialize(run(restored, 200, config))).toBe(serialize(run(mid, 200, config)));
  });
});

/* ------------------------------------------------------------------ */
/* 결정성·저장·예상치                                                    */
/* ------------------------------------------------------------------ */

describe('R14~R15, R18 결정성·저장·예상치', () => {
  it('R15. 시간 분할 결과가 같고 입력 상태가 불변이다', () => {
    const config = demandConfig;
    const base = eligibleState(config, { warmupMinutes: 150 });
    applyCommand(base, REQUEST, config, []);
    const before = serialize(base);

    const one = run(cloneState(base), 600, config);
    let many = cloneState(base);
    for (const chunk of [7, 1, 113, 279, 200]) many = run(many, chunk, config);

    expect(serialize(base)).toBe(before);
    expect(serialize(many)).toBe(serialize(one));
  });

  it('R14. 준비 중·완료 직후 저장 복원이 무중단 진행과 같다', () => {
    const config = demandConfig;
    const base = eligibleState(config, { warmupMinutes: 150 });
    applyCommand(base, REQUEST, config, []);

    const horizon = 600;
    const straight = run(cloneState(base), horizon, config);

    for (const cut of [10, 60, 130, 200]) {
      let broken = run(cloneState(base), cut, config);
      broken = deserialize(serialize(broken), config);
      broken = run(broken, horizon - cut, config);
      expect(serialize(broken)).toBe(serialize(straight));
    }
  });

  it('준비 상태가 직렬화 왕복을 견딘다', () => {
    const config = demandConfig;
    const state = eligibleState(config, { warmupMinutes: 150 });
    applyCommand(state, REQUEST, config, []);

    const restored = deserialize(serialize(state), config);
    expect(serialize(restored)).toBe(serialize(state));
    expect(restored.remodel!.id).toBe(state.remodel!.id);
    expect(restored.remodel!.costUnits).toBe(state.remodel!.costUnits);
    expect(restored.venue.lockedCash).toBe(state.venue.lockedCash);
  });

  it('R18. 공사 중 예상치는 명시적 미지원이다', () => {
    const config = demandConfig;
    const state = eligibleState(config, { warmupMinutes: 150 });
    applyCommand(state, REQUEST, config, []);

    const inv = forecast(state, { type: 'hireDealer' }, config);
    expect(inv.supported).toBe(false);
    if (inv.supported) throw new Error('unreachable');
    expect(inv.code).toBe('REMODEL_NOT_IMPLEMENTED');

    const tour = forecastSmallTournament(state, ['T1', 'T2'], config);
    expect(tour.supported).toBe(false);
    if (tour.supported) throw new Error('unreachable');
    expect(tour.code).toBe('REMODEL_NOT_IMPLEMENTED');
  });

  it('R18b. 리모델링 요청 명령의 예상치도 미지원이다', () => {
    const config = demandConfig;
    const state = eligibleState(config, { warmupMinutes: 150 });
    expect(validateCommand(state, REQUEST, config).ok).toBe(true);

    const r = forecast(state, REQUEST, config);
    expect(r.supported).toBe(false);
    if (r.supported) throw new Error('unreachable');
    expect(r.code).toBe('REMODEL_NOT_IMPLEMENTED');
  });

  it('공사가 끝나면 평범한 투자 예상치가 다시 동작한다', () => {
    const config = demandConfig;
    const state = eligibleState(config, { warmupMinutes: 150 });
    applyCommand(state, REQUEST, config, []);
    const { state: done } = runUntilRemodelDone(state, config);

    const r = forecast(done, { type: 'hireDealer' }, config);
    expect(r.supported).toBe(true);
  });

  it('v4 저장본이 현재 버전으로 마이그레이션된다', () => {
    const state = run(createInitialState(DEFAULT_CONFIG), 100, DEFAULT_CONFIG);
    const raw = JSON.parse(serialize(state)) as Record<string, unknown>;
    raw['saveVersion'] = 4;
    raw['rulesVersion'] = 'economy-0.2+b3-emergency';
    const rec = raw['records'] as Record<string, unknown>;
    delete rec['completedRemodels'];
    delete rec['nextRemodelSeq'];

    const migrated = deserialize(JSON.stringify(raw), DEFAULT_CONFIG);
    expect(migrated.saveVersion).toBe(SAVE_VERSION);
    expect(migrated.rulesVersion).toBe(RULES_VERSION);
    expect(migrated.remodel).toBeNull();
    expect(migrated.records.completedRemodels).toEqual([]);
    expect(migrated.records.nextRemodelSeq).toBe(1);
    expect(migrated.venue.cash).toBe(state.venue.cash);
    expect(migrated.records.completedGuests).toBe(state.records.completedGuests);
  });

  it('v4 저장본에 리모델링 작업이 들어 있으면 거절한다', () => {
    const state = createInitialState(DEFAULT_CONFIG);
    const raw = JSON.parse(serialize(state)) as Record<string, unknown>;
    raw['saveVersion'] = 4;
    raw['rulesVersion'] = 'economy-0.2+b3-emergency';
    raw['remodel'] = { id: 'RM1' };
    expect(() => deserialize(JSON.stringify(raw), DEFAULT_CONFIG)).toThrow(
      /v4 저장본에 리모델링 작업/,
    );
  });

  it('알 수 없는 규칙 버전의 v4 저장본을 거절한다', () => {
    const state = createInitialState(DEFAULT_CONFIG);
    const raw = JSON.parse(serialize(state)) as Record<string, unknown>;
    raw['saveVersion'] = 4;
    raw['rulesVersion'] = 'economy-9.9+unknown';
    expect(() => deserialize(JSON.stringify(raw), DEFAULT_CONFIG)).toThrow(/규칙 버전/);
  });
});
