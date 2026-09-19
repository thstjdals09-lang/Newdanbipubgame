/**
 * 긴급 축소 운영 (작업 B-3) 검증.
 *
 * 실제 엔진 동작을 검사한다. 기대값을 프로덕션 코드에 심어 통과시키지 않는다.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, SAVE_VERSION, RULES_VERSION, gold, milli } from '../src/config/economy.js';
import type { EconomyConfig } from '../src/config/economy.js';
import { tournamentPrepCostUnits } from '../src/engine/cash.js';
import { applyCommand, validateCommand } from '../src/engine/commands.js';
import { minuteCosts } from '../src/engine/costs.js';
import { availableCash, theoreticalCapacityMilli } from '../src/engine/derive.js';
import { recoveryThresholdUnits, selectKeptPair } from '../src/engine/emergency.js';
import { forecast, forecastSmallTournament } from '../src/engine/forecast.js';
import { cloneState, createInitialState, deserialize, serialize } from '../src/engine/state.js';
import { tick } from '../src/engine/tick.js';
import type { Command, GameState, TournamentPhase } from '../src/engine/types.js';
import { G, fixedDemandConfig, labState, run } from './helpers.js';

const SMALL = DEFAULT_CONFIG.tournament.small;
const RESERVE: Command = { type: 'reserveSmallTournament', tableIds: ['T1', 'T2'] };

const noDemand = fixedDemandConfig(0);
const demandConfig = fixedDemandConfig(20);

function reservableState(
  config: EconomyConfig,
  opts: { tables?: number; dealers?: number; cashGold?: number } = {},
): GameState {
  const state = labState(
    {
      tables: opts.tables ?? 4,
      dealers: opts.dealers ?? 4,
      cashGold: opts.cashGold ?? 50_000,
    },
    config,
  );
  state.venue.awarenessMilli = milli(10);
  return run(state, 1, config);
}

function runUntilPhase(start: GameState, phase: TournamentPhase, config: EconomyConfig): GameState {
  let cur = start;
  for (let i = 0; i < 3000; i += 1) {
    if (cur.tournament?.phase === phase) return cur;
    cur = tick(cur, config).state;
  }
  throw new Error(`단계 ${phase}에 도달하지 못했다`);
}

interface Trace {
  readonly state: GameState;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly supports: readonly { minute: number; amount: number }[];
}

/** 지정한 분만큼 돌리며 긴급 운영 관련 사건을 기록한다 */
function trace(start: GameState, minutes: number, config: EconomyConfig): Trace {
  let cur = start;
  let startedAt = -1;
  let endedAt = -1;
  const supports: { minute: number; amount: number }[] = [];

  for (let i = 0; i < minutes; i += 1) {
    const r = tick(cur, config);
    cur = r.state;
    for (const e of r.events) {
      if (e.type === 'emergencyStarted' && startedAt < 0) startedAt = cur.time.minute;
      if (e.type === 'emergencySupportGranted') {
        supports.push({ minute: cur.time.minute, amount: e.amountUnits });
      }
      if (e.type === 'emergencyEnded') endedAt = cur.time.minute;
    }
  }
  return { state: cur, startedAt, endedAt, supports };
}

/** 긴급 운영이 시작된 직후 상태까지 진행한다 */
function runUntilEmergency(start: GameState, config: EconomyConfig, limit = 3000): GameState {
  let cur = start;
  for (let i = 0; i < limit; i += 1) {
    const r = tick(cur, config);
    cur = r.state;
    if (r.events.some((e) => e.type === 'emergencyStarted')) return cur;
  }
  throw new Error('긴급 운영이 발동하지 않았다');
}

/** 이번 분 비용을 1unit 못 내는 잔액으로 낮춘다 (잠긴 금액은 보존) */
function starve(state: GameState, config: EconomyConfig): GameState {
  state.venue.cash = state.venue.lockedCash + minuteCosts(state, config).total - 1;
  return state;
}

/* ------------------------------------------------------------------ */
/* 발동 경계와 지원금                                                    */
/* ------------------------------------------------------------------ */

describe('1~3. 발동 경계', () => {
  it('1. 사용 가능 현금이 이번 분 비용과 같으면 발동하지 않는다', () => {
    const base = labState({ tables: 2, dealers: 2 }, noDemand);
    const costUnits = minuteCosts(base, noDemand).total;
    base.venue.cash = costUnits; // 정확히 같다

    const r = tick(base, noDemand);
    expect(r.state.emergency).toBeNull();
    expect(r.events.some((e) => e.type === 'emergencyStarted')).toBe(false);
    expect(r.state.records.totalEmergencySupportUnits).toBe(0);
    expect(r.state.venue.cash).toBe(0);
  });

  it('2. 1unit 모자라면 정확히 1unit만 지원한다', () => {
    const base = labState({ tables: 2, dealers: 2 }, noDemand);
    const costUnits = minuteCosts(base, noDemand).total;
    base.venue.cash = costUnits - 1;

    const r = tick(base, noDemand);
    expect(r.state.emergency).not.toBeNull();

    const grants = r.events.filter((e) => e.type === 'emergencySupportGranted');
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ amountUnits: 1 });
    expect(r.state.records.totalEmergencySupportUnits).toBe(1);
    expect(r.state.venue.cash).toBe(0);
  });

  it('3. 같은 분 세션 매출로 비용을 낼 수 있으면 발동하지 않는다', () => {
    // 세션이 정산되는 분(4단계)에 매출이 먼저 들어오고 8단계에서 비용을 낸다.
    const config = demandConfig;
    let state = labState({ tables: 1, dealers: 1 }, config);
    // 첫 세션 완료 직전까지 진행한 뒤, 그 분의 비용만 겨우 못 낼 잔액으로 낮춘다
    let cur = state;
    let completionMinute = -1;
    for (let i = 0; i < 200; i += 1) {
      const r = tick(cur, config);
      cur = r.state;
      if (r.events.some((e) => e.type === 'sessionCompleted')) {
        completionMinute = cur.time.minute;
        break;
      }
    }
    expect(completionMinute).toBeGreaterThan(0);

    state = run(labState({ tables: 1, dealers: 1 }, config), completionMinute - 1, config);
    const costUnits = minuteCosts(state, config).total;
    state.venue.cash = costUnits - 1; // 자기 자금만으로는 1unit 모자란다

    const r = tick(state, config);
    expect(r.events.some((e) => e.type === 'sessionCompleted')).toBe(true);
    // 매출이 먼저 들어왔으므로 지원이 필요 없다
    expect(r.state.emergency).toBeNull();
    expect(r.state.records.totalEmergencySupportUnits).toBe(0);
  });

  it('대회 수입이 들어온 분에도 불필요한 발동이 없다', () => {
    const config = demandConfig;
    const state = reservableState(config);
    applyCommand(state, RESERVE, config, []);
    const running = runUntilPhase(state, 'IN_PROGRESS', config);
    const endsAt = running.tournament!.endsAtMinute!;

    let cur = running;
    while (cur.time.minute < endsAt - 1) cur = tick(cur, config).state;
    // 완료 직전 분에 잔액을 비용 -1로 낮춘다. 참가비가 들어오므로 지원은 불필요하다.
    cur.venue.cash = cur.venue.lockedCash + minuteCosts(cur, config).total - 1;

    const r = tick(cur, config);
    expect(r.events.some((e) => e.type === 'tournamentCompleted')).toBe(true);
    expect(r.state.emergency).toBeNull();
    expect(r.state.records.totalEmergencySupportUnits).toBe(0);
  });
});

describe('4. 잠긴 준비비는 지원 뒤에도 보존된다', () => {
  it('지원금은 cash만 늘리고 lockedCash를 건드리지 않는다', () => {
    const config = demandConfig;
    const state = reservableState(config, { tables: 3, dealers: 2 });
    const prep = tournamentPrepCostUnits(SMALL, 16);
    state.venue.cash = prep + minuteCosts(state, config).total * 240;
    applyCommand(state, RESERVE, config, []);
    expect(state.venue.lockedCash).toBe(prep);

    // 대회가 아직 끝나지 않은 시점(= 준비비가 잠겨 있는 동안)에 확인한다
    const atStart = runUntilEmergency(state, config);
    expect(atStart.tournament).not.toBeNull();
    expect(atStart.records.totalEmergencySupportUnits).toBeGreaterThan(0);
    // 잠긴 준비비는 한 단위도 쓰이지 않았다
    expect(atStart.venue.lockedCash).toBe(prep);
    expect(atStart.venue.cash).toBe(prep);
    expect(availableCash(atStart)).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* 대회와의 공존                                                        */
/* ------------------------------------------------------------------ */

describe('5~9. 대회와 긴급 운영의 공존', () => {
  /** 대회를 예약하고, 지정한 단계에서 자금을 바닥내는 상태를 만든다 */
  function starvedTournament(phase: TournamentPhase | 'AFTER_END', config: EconomyConfig) {
    const state = reservableState(config, { tables: 3, dealers: 2 });
    applyCommand(state, RESERVE, config, []);
    let cur = phase === 'AFTER_END' ? state : runUntilPhase(state, phase, config);
    if (phase === 'AFTER_END') {
      // 대회 완료까지 진행
      for (let i = 0; i < 600; i += 1) {
        const r = tick(cur, config);
        cur = r.state;
        if (r.events.some((e) => e.type === 'tournamentCompleted')) break;
      }
    }
    // 자기 자금을 이번 분 비용 -1로 낮춘다 (잠긴 금액은 그대로)
    cur.venue.cash = cur.venue.lockedCash + minuteCosts(cur, config).total - 1;
    return cur;
  }

  for (const phase of ['RESERVED_DRAINING', 'RESERVED_READY', 'IN_PROGRESS'] as const) {
    it(`6. ${phase} 상태에서 자금이 말라도 대회가 정상 완료된다`, () => {
      const config = demandConfig;
      const starved = starvedTournament(phase, config);
      expect(starved.tournament!.phase).toBe(phase);

      const t = trace(starved, 800, config);
      expect(t.startedAt).toBeGreaterThan(0); // 긴급 운영 발동
      expect(t.state.records.tournamentsDone).toBe(1); // 대회는 정상 완료
      expect(t.state.tournament).toBeNull();
      expect(t.state.venue.lockedCash).toBe(0);
    });
  }

  it('5. 대회 종료 전/종료 분/종료 후 모두 지원이 정상 동작한다', () => {
    const config = demandConfig;
    for (const phase of ['IN_PROGRESS', 'AFTER_END'] as const) {
      const starved = starvedTournament(phase, config);
      const r = tick(starved, config);
      expect(r.state.records.totalEmergencySupportUnits).toBeGreaterThan(0);
      expect(r.state.venue.cash).toBeGreaterThanOrEqual(r.state.venue.lockedCash);
    }
  });

  it('7. 준비비·참가비·인지도·실적이 각각 한 번만 정산된다', () => {
    const config = demandConfig;
    const starved = starvedTournament('IN_PROGRESS', config);
    const beforeAwareness = starved.venue.awarenessMilli;
    const prep = starved.tournament!.prepCostUnits;

    const t = trace(starved, 800, config);
    expect(t.state.records.tournamentsDone).toBe(1);
    expect(t.state.records.completedTournaments).toHaveLength(1);
    expect(t.state.records.totalTournamentRevenueUnits).toBe(gold(SMALL.entryFeeGold * 16));

    const record = t.state.records.completedTournaments[0]!;
    expect(record.prepCostUnits).toBe(prep);
    expect(t.state.venue.awarenessMilli).toBeGreaterThan(beforeAwareness);
    expect(t.state.ledger.filter((l) => l.purpose.endsWith(':prep'))).toHaveLength(1);
    expect(t.state.ledger.filter((l) => l.purpose.endsWith(':entryFee'))).toHaveLength(1);
  });

  it('8. 대회 종료로 operating이 된 테이블도 긴급 운영 중에는 손님을 받지 않는다', () => {
    const config = demandConfig;
    const starved = starvedTournament('IN_PROGRESS', config);

    let cur = starved;
    let completedAt = -1;
    for (let i = 0; i < 600; i += 1) {
      const r = tick(cur, config);
      cur = r.state;
      if (r.events.some((e) => e.type === 'tournamentCompleted')) {
        completedAt = cur.time.minute;
        break;
      }
    }
    expect(completedAt).toBeGreaterThan(0);

    if (cur.emergency !== null) {
      const kept = cur.emergency.keptTableId;
      // 유지 대상이 아닌 테이블에는 새 세션이 생기지 않는다
      const after = run(cur, 60, config);
      for (const s of after.sessions) {
        if (s.startedAtMinute > completedAt) expect(s.tableId).toBe(kept);
      }
    }
  });

  it('9. 기존 세션의 완료 시각과 매출이 유지된다', () => {
    const config = demandConfig;
    const state = run(labState({ tables: 3, dealers: 3 }, config), 150, config);
    const snapshot = state.sessions.map((s) => `${s.id}@${s.endsAtMinute}:${s.revenueUnits}`).sort();
    expect(snapshot.length).toBeGreaterThan(0);
    state.venue.cash = minuteCosts(state, config).total - 1;

    const r = tick(state, config);
    expect(r.state.emergency).not.toBeNull();
    const kept = r.state.sessions
      .filter((s) => snapshot.some((x) => x.startsWith(`${s.id}@`)))
      .map((s) => `${s.id}@${s.endsAtMinute}:${s.revenueUnits}`)
      .sort();
    for (const entry of kept) expect(snapshot).toContain(entry);

    // 발동한 분에 새로 착석한 손님도 소급 취소되지 않는다
    const seated = r.events.filter((e) => e.type === 'guestSeated');
    for (const e of seated) {
      expect(r.state.sessions.some((s) => s.id === (e as { sessionId: string }).sessionId)).toBe(
        true,
      );
    }
  });
});

/* ------------------------------------------------------------------ */
/* 유지 대상 선택                                                       */
/* ------------------------------------------------------------------ */

describe('10~12. 유지 대상 선택과 축소', () => {
  it('10. 같은 상태에서 항상 같은 조합을 고른다', () => {
    const state = labState({ tables: 4, dealers: 4 }, noDemand);
    const first = selectKeptPair(state, noDemand);
    for (let i = 0; i < 5; i += 1) {
      expect(selectKeptPair(cloneState(state), noDemand)).toEqual(first);
    }
    // 가장 싼 일반 딜러 조합 중 spotIndex가 가장 작은 것
    expect(first).toEqual({ tableId: 'T1', dealerId: 'D1' });
  });

  it('유지비가 낮은 조합을 먼저 고른다', () => {
    const state = labState({ tables: 2, dealers: 2 }, noDemand);
    // T1은 숙련(110G), T2는 일반(80G)
    const d1 = state.staff.find((s) => s.id === 'D1')!;
    state.staff[state.staff.indexOf(d1)] = { ...d1, type: 'skilled' };
    expect(selectKeptPair(state, noDemand)).toEqual({ tableId: 'T2', dealerId: 'D2' });
  });

  it('11. 모든 자원이 대회에 묶이면 대상을 비워 두고, 해제되면 고른다', () => {
    const config = demandConfig;
    // 테이블 2개가 전부 대회에 묶이고 딜러도 둘뿐인 구성
    const state = reservableState(config, { tables: 3, dealers: 2 });
    const prep = tournamentPrepCostUnits(SMALL, 16);
    state.venue.cash = prep + minuteCosts(state, config).total * 240;
    applyCommand(state, RESERVE, config, []);

    const atStart = runUntilEmergency(state, config);
    expect(atStart.tournament).not.toBeNull(); // 아직 대회 진행 중
    const em = atStart.emergency;
    expect(em).not.toBeNull();
    // 대회에 묶인 테이블·딜러는 절대 고르지 않는다.
    // B-2B가 지급한 숙련 딜러 + 빈 테이블 조합이 남아 있으면 그것을 고른다.
    if (em!.keptTableId !== null) {
      expect(['T1', 'T2']).not.toContain(em!.keptTableId);
      expect(['D1', 'D2']).not.toContain(em!.keptDealerId);
    }

    // 대회가 끝나면 자원이 풀리고 대회는 정상 완료된다
    const after = trace(atStart, 400, config);
    expect(after.state.records.tournamentsDone).toBe(1);
  });

  it('대상을 고르지 못하면 비워 둔 채 기존 업무를 계속한다', () => {
    const config = demandConfig;
    const state = reservableState(config, { tables: 2, dealers: 2 });
    // 테이블 2개 전부 대회에 넣고 대기 딜러도 없게 만든다
    state.staff = state.staff.filter((s) => s.id === 'D1' || s.id === 'D2');
    const prep = tournamentPrepCostUnits(SMALL, 16);
    state.venue.cash = prep + minuteCosts(state, config).total * 240;
    state.unlocks.push({ id: 'smallTournament', grantedAtMinute: 0 });
    if (validateCommand(state, RESERVE, config).ok) {
      applyCommand(state, RESERVE, config, []);
      const t = trace(state, 250, config);
      if (t.startedAt > 0 && t.state.emergency) {
        // 고를 수 있는 조합이 없으면 null로 남는다. 직원을 새로 만들지 않는다.
        expect(t.state.staff.filter((s) => s.type !== 'service').length).toBeLessThanOrEqual(3);
      }
    }
  });

  it('12. 딜러 교체 예약과 긴급 축소가 겹쳐도 중복 배치나 영구 예약이 없다', () => {
    const config = demandConfig;
    const state = run(labState({ tables: 3, dealers: 3 }, config), 150, config);
    state.staff.push({ id: 'SPARE', type: 'normal', duty: 'standby', assignedTableId: null });
    applyCommand(state, { type: 'assignDealer', tableId: 'T2', staffId: 'SPARE' }, config, []);
    expect(state.tables.find((t) => t.id === 'T2')?.pendingDealerId).toBe('SPARE');

    state.venue.cash = minuteCosts(state, config).total - 1;
    const t = trace(state, 600, config);
    expect(t.startedAt).toBeGreaterThan(0);

    // 배치 예약이 영구히 남지 않는다
    for (const table of t.state.tables) {
      expect(table.pendingDealerId).toBeUndefined();
    }
    // 한 딜러가 두 테이블에 동시에 배치되지 않는다
    const assigned = t.state.tables.map((x) => x.dealerId).filter((x) => x !== null);
    expect(new Set(assigned).size).toBe(assigned.length);
    // 배치된 딜러는 반드시 그 테이블을 가리킨다
    for (const table of t.state.tables) {
      if (table.dealerId === null) continue;
      const dealer = t.state.staff.find((s) => s.id === table.dealerId)!;
      expect(dealer.assignedTableId).toBe(table.id);
      expect(dealer.duty).toBe('working');
    }
  });

  it('선택한 대상을 매분 더 좋은 조합으로 교체하지 않는다', () => {
    const config = noDemand;
    const state = starve(labState({ tables: 3, dealers: 3 }, config), config);
    const atStart = runUntilEmergency(state, config);
    const picked = atStart.emergency!.keptTableId;
    expect(picked).not.toBeNull();

    // 매출이 없으므로 긴급 운영이 계속된다. 대상이 바뀌지 않아야 한다.
    const later = run(atStart, 300, config);
    expect(later.emergency).not.toBeNull();
    expect(later.emergency!.keptTableId).toBe(picked);
  });
});

/* ------------------------------------------------------------------ */
/* 축소·착석 제한·명령 제한                                              */
/* ------------------------------------------------------------------ */

describe('축소와 제한', () => {
  it('유지 대상 외 테이블은 신규 착석을 받지 않고 처리 능력에서도 빠진다', () => {
    const config = demandConfig;
    const state = starve(run(labState({ tables: 3, dealers: 3 }, config), 150, config), config);
    const atStart = runUntilEmergency(state, config);
    const kept = atStart.emergency!.keptTableId;
    expect(kept).not.toBeNull();

    // 착석 가능 좌석과 처리 능력이 유지 대상 하나로 일관되게 줄어든다
    expect(theoreticalCapacityMilli(atStart, config)).toBe(4000);
    const startedBefore = new Set(atStart.sessions.map((x) => x.id));
    const after = run(atStart, 200, config);
    for (const x of after.sessions) {
      if (startedBefore.has(x.id)) continue;
      expect(x.tableId).toBe(kept);
    }
  });

  it('서비스 직원은 발동한 분에 대기로 전환된다', () => {
    const config = noDemand;
    const state = starve(labState({ tables: 2, dealers: 2, serviceStaff: 2 }, config), config);
    expect(state.staff.filter((s) => s.type === 'service' && s.duty === 'working')).toHaveLength(2);

    const r = tick(state, config);
    expect(r.state.emergency).not.toBeNull();
    expect(r.state.staff.filter((s) => s.type === 'service' && s.duty === 'working')).toHaveLength(
      0,
    );
  });

  it('긴급 운영 중에는 확장·지출·수동 배치 명령을 사유와 함께 거절한다', () => {
    const config = noDemand;
    const state = starve(labState({ tables: 3, dealers: 3 }, config), config);
    const em = runUntilEmergency(state, config);
    expect(em.emergency).not.toBeNull();
    em.venue.cash = gold(100_000); // 돈이 많아도 막힌다

    const blocked: Command[] = [
      { type: 'buyTable' },
      { type: 'hireDealer' },
      { type: 'hireServiceStaff' },
      { type: 'upgradeAmenity' },
      { type: 'buyPromotion' },
      { type: 'reserveSmallTournament', tableIds: ['T1', 'T2'] },
      { type: 'assignDealer', tableId: 'T2', staffId: 'D2' },
      { type: 'unassignDealer', tableId: 'T1' },
      { type: 'setStaffStandby', staffId: 'D2' },
      { type: 'setServiceWorking', staffId: 'D2' },
    ];
    for (const command of blocked) {
      const r = validateCommand(em, command, config);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('EMERGENCY_ACTIVE');
      expect(r.detail).toMatch(/긴급 축소 운영/);
    }
  });

  it('거절된 명령은 긴급 운영 상태를 바꾸지 않는다', () => {
    const config = noDemand;
    const state = starve(labState({ tables: 3, dealers: 3 }, config), config);
    const em = runUntilEmergency(state, config);
    const before = serialize(em);

    const withCmd = tick(cloneState(em), config, [{ type: 'buyTable' }]);
    const withoutCmd = tick(cloneState(em), config, []);
    expect(serialize(em)).toBe(before);
    expect(serialize(withCmd.state)).toBe(serialize(withoutCmd.state));
    expect(withCmd.events.filter((e) => e.type === 'commandRejected')).toHaveLength(1);
  });

  it('해금과 특별 직원 보상은 긴급 운영 중에도 기존 조건대로 한 번 지급된다', () => {
    const config = noDemand;
    const state = starve(labState({ tables: 3, dealers: 3 }, config), config);
    const t = trace(state, 50, config);
    expect(t.startedAt).toBeGreaterThan(0);
    // 테이블 3개 조건이므로 숙련 딜러가 지급된다
    expect(t.state.staff.filter((s) => s.type === 'skilled')).toHaveLength(1);
    expect(t.state.staff.filter((s) => s.type === 'skilled')[0]!.duty).toBe('standby');
    // 보상을 이유로 자동 확장하지 않는다
    expect(t.state.tables.filter((x) => x.status === 'operating').length).toBeLessThanOrEqual(1);
  });
});

/* ------------------------------------------------------------------ */
/* 종료                                                                 */
/* ------------------------------------------------------------------ */

describe('13~15. 복구 종료', () => {
  it('13. 축소만 끝나고 자금이 모자라면 종료하지 않는다', () => {
    const config = noDemand; // 매출이 없어 자금이 회복되지 않는다
    const state = labState({ tables: 3, dealers: 3, cashGold: 100 }, config);
    const t = trace(state, 500, config);

    expect(t.state.emergency).not.toBeNull();
    expect(t.state.emergency!.phase).toBe('RECOVERING'); // 축소는 끝났다
    expect(t.endedAt).toBe(-1); // 자금 조건 미달로 종료하지 않았다
    expect(availableCash(t.state)).toBeLessThan(recoveryThresholdUnits(t.state, config));
  });

  it('종료 기준액이 축소 완료 배치의 4게임시간 운영비다', () => {
    const config = noDemand;
    const state = labState({ tables: 3, dealers: 3, cashGold: 100 }, config);
    const t = trace(state, 400, config);
    expect(t.state.emergency!.phase).toBe('RECOVERING');
    // 일반 딜러 1명 + 테이블 1개 + 매장 = 150 units/분 x 240 = 600G
    expect(G(recoveryThresholdUnits(t.state, config))).toBe(600);
  });

  it('숙련 딜러만 남으면 기준액이 720G가 된다', () => {
    const config = noDemand;
    const state = labState({ tables: 1, dealers: 1, dealerType: 'skilled', cashGold: 100 }, config);
    const t = trace(state, 10, config);
    expect(G(recoveryThresholdUnits(t.state, config))).toBe(720);
  });

  it('15. 정상 수요에서는 실제로 회복하고 종료한다', () => {
    const config = demandConfig;
    const state = labState({ tables: 3, dealers: 3, cashGold: 100 }, config);
    const t = trace(state, 1200, config);

    expect(t.startedAt).toBeGreaterThan(0);
    expect(t.endedAt).toBeGreaterThan(t.startedAt);
    expect(t.state.emergency).toBeNull();
    expect(availableCash(t.state)).toBeGreaterThan(0);
  });

  it('14. 종료 후 이전 배치를 자동 복원하지 않는다', () => {
    const config = demandConfig;
    const state = labState({ tables: 3, dealers: 3, cashGold: 100 }, config);
    const t = trace(state, 1200, config);
    expect(t.state.emergency).toBeNull();

    // 유지하던 1개 테이블만 영업 중이다
    expect(t.state.tables.filter((x) => x.status === 'operating')).toHaveLength(1);
    expect(t.state.staff.filter((s) => s.duty === 'working')).toHaveLength(1);

    // 더 진행해도 자동으로 늘지 않는다
    const later = run(t.state, 600, config);
    expect(later.tables.filter((x) => x.status === 'operating')).toHaveLength(1);
  });

  it('종료하면 명령 제한이 풀린다', () => {
    const config = demandConfig;
    const state = labState({ tables: 3, dealers: 3, cashGold: 100 }, config);
    const t = trace(state, 1200, config);
    expect(t.state.emergency).toBeNull();

    const r = validateCommand(t.state, { type: 'hireDealer' }, config);
    expect(r.reason).not.toBe('EMERGENCY_ACTIVE');
  });
});

/* ------------------------------------------------------------------ */
/* 결정성·저장·예상치                                                    */
/* ------------------------------------------------------------------ */

describe('16~18. 저장·결정성·예상치', () => {
  it('17. 시간 분할 결과가 같고 입력 상태가 불변이다', () => {
    const config = demandConfig;
    const base = labState({ tables: 3, dealers: 3, cashGold: 100 }, config);
    const before = serialize(base);

    const one = run(cloneState(base), 900, config);
    let many = cloneState(base);
    for (const chunk of [7, 1, 193, 400, 299]) many = run(many, chunk, config);

    expect(serialize(base)).toBe(before);
    expect(serialize(many)).toBe(serialize(one));
  });

  it('16. 정리·지원·대회 종료·회복 중 저장 복원이 무중단 진행과 같다', () => {
    const config = demandConfig;
    const base = reservableState(config, { tables: 3, dealers: 2 });
    const prep = tournamentPrepCostUnits(SMALL, 16);
    base.venue.cash = prep + minuteCosts(base, config).total * 240;
    applyCommand(base, RESERVE, config, []);

    const horizon = 900;
    const straight = run(cloneState(base), horizon, config);

    for (const cut of [100, 241, 243, 400, 700]) {
      let broken = run(cloneState(base), cut, config);
      broken = deserialize(serialize(broken), config);
      broken = run(broken, horizon - cut, config);
      expect(serialize(broken)).toBe(serialize(straight));
    }
  });

  it('저장 복원이 지원금을 중복 지급하지 않는다', () => {
    const config = noDemand;
    const state = starve(labState({ tables: 2, dealers: 2 }, config), config);
    const em = run(runUntilEmergency(state, config), 20, config);
    expect(em.emergency).not.toBeNull();

    const restored = deserialize(serialize(em), config);
    expect(serialize(restored)).toBe(serialize(em));
    expect(restored.records.totalEmergencySupportUnits).toBe(
      em.records.totalEmergencySupportUnits,
    );
    expect(restored.emergency!.id).toBe(em.emergency!.id);
    expect(restored.emergency!.supportUnits).toBe(em.emergency!.supportUnits);

    // 이어서 진행해도 중복 지급이 없다
    const straight = run(em, 50, config);
    const viaSave = run(restored, 50, config);
    expect(serialize(viaSave)).toBe(serialize(straight));
  });

  it('v3 저장본이 v4로 마이그레이션된다', () => {
    const state = run(createInitialState(DEFAULT_CONFIG), 100, DEFAULT_CONFIG);
    const raw = JSON.parse(serialize(state)) as Record<string, unknown>;
    raw['saveVersion'] = 3;
    raw['rulesVersion'] = 'economy-0.1+adopt-v1';
    const rec = raw['records'] as Record<string, unknown>;
    delete rec['totalEmergencySupportUnits'];
    delete rec['emergencyMinutes'];
    delete rec['nextEmergencySeq'];
    // v3에도 emergency 필드는 있었다(항상 null). 지우지 않는다.
    raw['emergency'] = null;

    const migrated = deserialize(JSON.stringify(raw), DEFAULT_CONFIG);
    expect(migrated.saveVersion).toBe(SAVE_VERSION);
    expect(migrated.rulesVersion).toBe(RULES_VERSION);
    expect(migrated.emergency).toBeNull();
    expect(migrated.records.totalEmergencySupportUnits).toBe(0);
    expect(migrated.records.emergencyMinutes).toBe(0);
    expect(migrated.records.nextEmergencySeq).toBe(1);
    // 기존 누계와 현금은 그대로다
    expect(migrated.venue.cash).toBe(state.venue.cash);
    expect(migrated.records.totalRevenueUnits).toBe(state.records.totalRevenueUnits);
    expect(migrated.records.completedGuests).toBe(state.records.completedGuests);
  });

  it('v3 저장본에 긴급 상태가 들어 있으면 거절한다', () => {
    const state = createInitialState(DEFAULT_CONFIG);
    const raw = JSON.parse(serialize(state)) as Record<string, unknown>;
    raw['saveVersion'] = 3;
    raw['rulesVersion'] = 'economy-0.1+adopt-v1'; // 실제 v3 저장본의 규칙 버전
    raw['emergency'] = { id: 'EM1' };
    expect(() => deserialize(JSON.stringify(raw), DEFAULT_CONFIG)).toThrow(
      /v3 저장본에 긴급 운영 상태/,
    );
  });

  it('18. 예상치가 실제 진행과 일치하고 지원금을 수익으로 오인하지 않는다', () => {
    const config = noDemand;
    const state = labState({ tables: 3, dealers: 3, cashGold: 500 }, config);

    const r = forecast(state, { type: 'hireDealer' }, config, 300);
    expect(r.supported).toBe(true);
    if (!r.supported) throw new Error('unreachable');

    // 기준 분기를 실제로 돌린 결과와 같다
    const actual = run(state, 300, config);
    expect(r.baseline.endCashUnits).toBe(actual.venue.cash);
    expect(r.baseline.emergencySupportUnits).toBe(
      actual.records.totalEmergencySupportUnits - state.records.totalEmergencySupportUnits,
    );
    expect(r.baseline.emergencyMinutes).toBe(actual.records.emergencyMinutes);
    expect(r.baseline.emergencyActiveAtEnd).toBe(actual.emergency !== null);

    // 지원금은 매출·순이익에 섞이지 않는다
    expect(r.baseline.emergencySupportUnits).toBeGreaterThan(0);
    expect(r.baseline.operatingNetUnits).toBe(
      r.baseline.revenueUnits - r.baseline.recurringCostUnits,
    );
    expect(r.baseline.revenueUnits).toBe(0); // 수요 0이므로 매출이 없다
    expect(r.baseline.operatingNetUnits).toBeLessThan(0);
  });

  it('대회 예상치가 한쪽 분기만 긴급 운영인 경우를 비교한다', () => {
    const config = demandConfig;
    const state = reservableState(config, { tables: 3, dealers: 2 });
    const prep = tournamentPrepCostUnits(SMALL, 16);
    state.venue.cash = prep + minuteCosts(state, config).total * 240;
    const before = serialize(state);

    const r = forecastSmallTournament(state, ['T1', 'T2'], config, 900);
    expect(serialize(state)).toBe(before); // 원본 불변
    expect(r.supported).toBe(true);
    if (!r.supported) throw new Error('unreachable');

    // 대회 분기에서만 자금이 마른다
    expect(r.tournament.emergencyTriggered).toBe(true);
    expect(r.baseline.emergencyTriggered).toBe(false);
    expect(r.delta.emergencySupportUnits).toBe(r.tournament.emergencySupportUnits);

    // 현금 차이가 지원금을 포함한 정합식과 맞는다
    const reconciled =
      r.delta.ordinaryRevenueUnits +
      r.delta.tournamentRevenueUnits +
      r.delta.emergencySupportUnits -
      r.delta.recurringCostUnits -
      r.delta.oneOffExpenseUnits;
    expect(reconciled).toBe(r.delta.endCashUnits);
  });
});
