/**
 * 소규모 대회 생애주기와 정산 (작업 B-2A) 검증.
 *
 * T01~T26. 실제 엔진 동작을 검사한다.
 * 기대값을 프로덕션 코드에 심어 통과시키지 않는다.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, SAVE_VERSION, gold, milli } from '../src/config/economy.js';
import type { EconomyConfig } from '../src/config/economy.js';
import { tournamentPrepCostUnits } from '../src/engine/cash.js';
import { applyCommand, validateCommand } from '../src/engine/commands.js';
import { forecast } from '../src/engine/forecast.js';
import { cloneState, createInitialState, deserialize, serialize } from '../src/engine/state.js';
import { tick } from '../src/engine/tick.js';
import { tournamentDurationMinutes } from '../src/engine/tournament.js';
import type { Command, EngineEvent, GameState, TournamentPhase } from '../src/engine/types.js';
import { G, fixedDemandConfig, labState, run } from './helpers.js';

const SMALL = DEFAULT_CONFIG.tournament.small;
const demandConfig = fixedDemandConfig(20); // 예상 참가자 = min(16, floor(20 x 2)) = 16
const RESERVE: Command = { type: 'reserveSmallTournament', tableIds: ['T1', 'T2'] };

/** 소규모 대회를 예약할 수 있는 최소 조건을 갖춘 상태 */
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
  state.venue.awarenessMilli = milli(10); // 해금 문턱
  return run(state, 1, config); // 해금 기록을 엔진이 부여하게 한다
}

/** 예약까지 마친 상태. warmupMinutes로 기존 세션을 만들 수 있다. */
function reserved(config: EconomyConfig, warmupMinutes = 0, opts = {}): GameState {
  let state = reservableState(config, opts);
  if (warmupMinutes > 0) state = run(state, warmupMinutes, config);
  applyCommand(state, RESERVE, config, []);
  return state;
}

function runUntilPhase(start: GameState, phase: TournamentPhase, config: EconomyConfig): GameState {
  let cur = start;
  for (let i = 0; i < 3000; i += 1) {
    if (cur.tournament?.phase === phase) return cur;
    cur = tick(cur, config).state;
  }
  throw new Error(`단계 ${phase}에 도달하지 못했다`);
}

interface CompletionRun {
  readonly state: GameState;
  readonly completedAtMinute: number;
  readonly completionEvents: number;
}

function runUntilCompleted(start: GameState, config: EconomyConfig): CompletionRun {
  let cur = start;
  for (let i = 0; i < 3000; i += 1) {
    const r = tick(cur, config);
    cur = r.state;
    const n = r.events.filter((e) => e.type === 'tournamentCompleted').length;
    if (n > 0) return { state: cur, completedAtMinute: cur.time.minute, completionEvents: n };
  }
  throw new Error('대회가 완료되지 않았다');
}

/* ------------------------------------------------------------------ */
/* 시작 타이밍                                                          */
/* ------------------------------------------------------------------ */

describe('T01 READY -> 시작 경계', () => {
  it('READY가 된 분에는 시작하지 않고 그다음 3단계 평가에서 시작한다', () => {
    const state = reserved(demandConfig);
    expect(state.tournament!.phase).toBe('RESERVED_DRAINING');

    let cur = state;
    let readyMinute = -1;
    let startMinute = -1;
    for (let i = 0; i < 50; i += 1) {
      const r = tick(cur, demandConfig);
      cur = r.state;
      for (const e of r.events) {
        if (e.type === 'tournamentReady') {
          readyMinute = cur.time.minute;
          // 준비가 끝난 바로 그 분에는 아직 시작 전이다
          expect(cur.tournament!.phase).toBe('RESERVED_READY');
          expect(cur.tournament!.startedAtMinute).toBeNull();
        }
        if (e.type === 'tournamentStarted') startMinute = cur.time.minute;
      }
      if (startMinute > 0) break;
    }

    expect(readyMinute).toBeGreaterThan(0);
    expect(startMinute).toBe(readyMinute + 1);
    expect(cur.tournament!.startedAtMinute).toBe(startMinute);
  });

  it('시작 시각과 종료 예정 시각이 상태에 기록된다', () => {
    const running = runUntilPhase(reserved(demandConfig), 'IN_PROGRESS', demandConfig);
    const t = running.tournament!;
    expect(t.startedAtMinute).not.toBeNull();
    expect(t.endsAtMinute).toBe(t.startedAtMinute! + SMALL.baseDurationMinutes);
  });
});

describe('T02 정리 중에는 시작하지 않는다', () => {
  it('예약 테이블에 일반 세션이 남아 있는 동안 DRAINING을 유지한다', () => {
    const state = reserved(demandConfig, 150);
    expect(state.sessions.some((s) => ['T1', 'T2'].includes(s.tableId))).toBe(true);

    let cur = state;
    for (let i = 0; i < 60; i += 1) {
      cur = tick(cur, demandConfig).state;
      const stillBusy = cur.sessions.some((s) => ['T1', 'T2'].includes(s.tableId));
      if (stillBusy) {
        expect(cur.tournament!.phase).toBe('RESERVED_DRAINING');
        expect(cur.tournament!.startedAtMinute).toBeNull();
      }
    }
  });
});

describe('T03 기존 일반 세션은 시작 전에 정확히 한 번 정산된다', () => {
  it('예약 시점 세션이 모두 1회 정산되고 시작은 그 뒤다', () => {
    const state = reserved(demandConfig, 150);
    const preExisting = new Set(
      state.sessions.filter((s) => ['T1', 'T2'].includes(s.tableId)).map((s) => s.id),
    );
    expect(preExisting.size).toBeGreaterThan(0);

    const settled = new Map<string, number>();
    let cur = state;
    let startMinute = -1;
    let lastSettleMinute = -1;
    for (let i = 0; i < 600; i += 1) {
      const r = tick(cur, demandConfig);
      cur = r.state;
      for (const e of r.events) {
        if (e.type === 'sessionCompleted' && preExisting.has(e.sessionId)) {
          settled.set(e.sessionId, (settled.get(e.sessionId) ?? 0) + 1);
          lastSettleMinute = cur.time.minute;
        }
        if (e.type === 'tournamentStarted') startMinute = cur.time.minute;
      }
      if (startMinute > 0) break;
    }

    for (const id of preExisting) expect(settled.get(id)).toBe(1);
    expect(startMinute).toBeGreaterThan(lastSettleMinute);
  });
});

describe('T04 예약 내용은 시작 뒤에도 고정된다', () => {
  it('참가자 수와 테이블·딜러 ID가 변하지 않는다', () => {
    const state = reserved(demandConfig);
    const t0 = state.tournament!;
    const running = runUntilPhase(state, 'IN_PROGRESS', demandConfig);
    const t1 = running.tournament!;

    expect(t1.id).toBe(t0.id);
    expect(t1.participants).toBe(t0.participants);
    expect(t1.tableIds).toEqual(t0.tableIds);
    expect(t1.dealerIds).toEqual(t0.dealerIds);
    expect(t1.prepCostUnits).toBe(t0.prepCostUnits);
  });
});

/* ------------------------------------------------------------------ */
/* 진행 시간 — 채택 R3                                                  */
/* ------------------------------------------------------------------ */

describe('T05~T08 진행 시간과 대회 전문 딜러 (R3)', () => {
  /** 지정한 테이블의 담당 딜러를 대회 전문 딜러로 바꾼다 */
  function makeSpecialist(state: GameState, tableId: string): void {
    const table = state.tables.find((t) => t.id === tableId)!;
    const dealer = state.staff.find((s) => s.id === table.dealerId)!;
    const idx = state.staff.indexOf(dealer);
    state.staff[idx] = { ...dealer, type: 'tournament' };
  }

  it('T05. 기본 진행 시간은 설정값을 그대로 쓴다', () => {
    const state = reserved(demandConfig);
    expect(tournamentDurationMinutes(state, state.tournament!, demandConfig)).toBe(
      SMALL.baseDurationMinutes,
    );
    expect(SMALL.baseDurationMinutes).toBe(240); // 설정 출처 확인
  });

  it('T06. 예약된 대회 전문 딜러는 1.25 배율을 적용한다', () => {
    const base = reservableState(demandConfig);
    makeSpecialist(base, 'T1');
    applyCommand(base, RESERVE, demandConfig, []);

    const expected = Math.ceil(
      (SMALL.baseDurationMinutes * 1000) / DEFAULT_CONFIG.staff.tournament.tournamentSpeedMilli,
    );
    expect(expected).toBe(192);
    expect(tournamentDurationMinutes(base, base.tournament!, demandConfig)).toBe(expected);

    const running = runUntilPhase(base, 'IN_PROGRESS', demandConfig);
    expect(running.tournament!.endsAtMinute! - running.tournament!.startedAtMinute!).toBe(expected);
  });

  it('T07. 예약되지 않은 전문 딜러는 효과가 없다', () => {
    const base = reservableState(demandConfig);
    // T3(예약 대상이 아님)의 딜러만 전문 딜러로 만든다
    makeSpecialist(base, 'T3');
    applyCommand(base, RESERVE, demandConfig, []);

    expect(base.tournament!.dealerIds).toEqual(['D1', 'D2']);
    expect(tournamentDurationMinutes(base, base.tournament!, demandConfig)).toBe(
      SMALL.baseDurationMinutes,
    );
  });

  it('T08. 전문 딜러가 여럿이어도 중첩되지 않는다', () => {
    const one = reservableState(demandConfig);
    makeSpecialist(one, 'T1');
    applyCommand(one, RESERVE, demandConfig, []);

    const two = reservableState(demandConfig);
    makeSpecialist(two, 'T1');
    makeSpecialist(two, 'T2');
    applyCommand(two, RESERVE, demandConfig, []);

    expect(tournamentDurationMinutes(two, two.tournament!, demandConfig)).toBe(
      tournamentDurationMinutes(one, one.tournament!, demandConfig),
    );
  });

  it('일반 세션 시간과 딜러 속도는 그대로다', () => {
    expect(DEFAULT_CONFIG.time.baseSessionMinutes).toBe(120);
    expect(DEFAULT_CONFIG.staff.normal.tableSpeedMilli).toBe(1000);
    expect(DEFAULT_CONFIG.staff.tournament.tableSpeedMilli).toBe(1000);
  });
});

/* ------------------------------------------------------------------ */
/* 완료와 정산                                                          */
/* ------------------------------------------------------------------ */

describe('T09 예정 시각 전에는 완료되지 않는다', () => {
  it('종료 예정 분 직전까지 IN_PROGRESS를 유지하고 그 분에 완료된다', () => {
    const running = runUntilPhase(reserved(demandConfig), 'IN_PROGRESS', demandConfig);
    const endsAt = running.tournament!.endsAtMinute!;

    let cur = running;
    while (cur.time.minute < endsAt - 1) {
      cur = tick(cur, demandConfig).state;
      expect(cur.tournament).not.toBeNull();
      expect(cur.tournament!.phase).toBe('IN_PROGRESS');
    }

    const r = tick(cur, demandConfig); // 종료 예정 분
    expect(r.state.time.minute).toBe(endsAt);
    expect(r.events.some((e) => e.type === 'tournamentCompleted')).toBe(true);
    expect(r.state.tournament).toBeNull();
  });
});

describe('T10~T15 정산 회계', () => {
  it('T10. 준비비를 정확히 한 번만 비용으로 확정한다', () => {
    const state = reserved(demandConfig);
    const prep = state.tournament!.prepCostUnits;
    expect(prep).toBe(tournamentPrepCostUnits(SMALL, 16));
    expect(state.venue.lockedCash).toBe(prep);

    const oneOffBefore = state.records.totalOneOffUnits;
    const { state: done } = runUntilCompleted(state, demandConfig);

    expect(done.venue.lockedCash).toBe(0);
    expect(done.records.totalOneOffUnits).toBe(oneOffBefore + prep);
    const prepEntries = done.ledger.filter((l) => l.purpose.endsWith(':prep'));
    expect(prepEntries).toHaveLength(1);
    expect(prepEntries[0]!.amountUnits).toBe(-prep);
  });

  it('T11. 참가비 수입을 정확히 한 번 인식한다', () => {
    const state = reserved(demandConfig);
    const { state: done } = runUntilCompleted(state, demandConfig);

    const expectedFee = gold(SMALL.entryFeeGold * 16);
    expect(G(expectedFee)).toBe(16 * 180);
    expect(done.records.totalTournamentRevenueUnits).toBe(expectedFee);

    const feeEntries = done.ledger.filter((l) => l.purpose.endsWith(':entryFee'));
    expect(feeEntries).toHaveLength(1);
    expect(feeEntries[0]!.amountUnits).toBe(expectedFee);
  });

  it('현금 변화가 정확히 참가비 - 준비비 - 그 분의 반복 비용이다', () => {
    const running = runUntilPhase(reserved(demandConfig), 'IN_PROGRESS', demandConfig);
    const endsAt = running.tournament!.endsAtMinute!;
    let cur = running;
    while (cur.time.minute < endsAt - 1) cur = tick(cur, demandConfig).state;

    const before = cur.venue.cash;
    const recurringBefore =
      cur.records.totalWageUnits + cur.records.totalFacilityUnits + cur.records.totalVenueCostUnits;
    const revenueBefore = cur.records.totalRevenueUnits;

    const after = tick(cur, demandConfig).state;
    const recurringDelta =
      after.records.totalWageUnits +
      after.records.totalFacilityUnits +
      after.records.totalVenueCostUnits -
      recurringBefore;
    const ordinaryDelta = after.records.totalRevenueUnits - revenueBefore;

    const expected =
      before + gold(SMALL.entryFeeGold * 16) - tournamentPrepCostUnits(SMALL, 16) + ordinaryDelta - recurringDelta;
    expect(after.venue.cash).toBe(expected);
  });

  it('T12. 정산이 전역 급여·시설비를 중복으로 빼지 않는다', () => {
    // 같은 구간을 대회 있이/없이 돌려 반복 비용 누계를 비교한다.
    const withT = reserved(demandConfig);
    const withoutT = cloneState(withT);
    withoutT.tournament = null;
    withoutT.venue.lockedCash = 0;
    for (const t of withoutT.tables) if (t.status === 'tournamentHeld') t.status = 'operating';

    const minutes = 300;
    const a = run(withT, minutes, demandConfig);
    const b = run(withoutT, minutes, demandConfig);

    // 테이블 수·딜러 수가 같으므로 급여와 시설비 누계가 완전히 같아야 한다.
    expect(a.records.totalWageUnits).toBe(b.records.totalWageUnits);
    expect(a.records.totalFacilityUnits).toBe(b.records.totalFacilityUnits);
    expect(a.records.totalVenueCostUnits).toBe(b.records.totalVenueCostUnits);
    // 대회 쪽에서만 일회성 준비비가 잡힌다
    expect(a.records.totalOneOffUnits - b.records.totalOneOffUnits).toBe(
      tournamentPrepCostUnits(SMALL, 16),
    );
  });

  it('T13. 참가자는 일반 완료 이용객·일반 매출에 섞이지 않는다', () => {
    const state = reserved(demandConfig);
    const guestsBefore = state.records.completedGuests;

    const { state: done, completedAtMinute } = runUntilCompleted(state, demandConfig);

    // 일반 매출 불변식이 그대로 유지된다
    expect(done.records.totalRevenueUnits).toBe(done.records.completedGuests * gold(200));
    // 참가비는 별도 계정
    expect(done.records.totalTournamentRevenueUnits).toBe(gold(SMALL.entryFeeGold * 16));
    // 참가자 16명이 완료 이용객으로 더해지지 않았다
    const ordinaryGained = done.records.completedGuests - guestsBefore;
    expect(ordinaryGained).toBeGreaterThan(0); // 다른 테이블 영업은 계속됐다
    expect(done.records.completedTournaments[0]!.participants).toBe(16);

    // 완료된 분에 일반 세션 정산 이벤트가 참가자 수만큼 튀어나오지 않는다
    let cur = state;
    while (cur.time.minute < completedAtMinute - 1) cur = tick(cur, demandConfig).state;
    const r = tick(cur, demandConfig);
    const sessionEvents = r.events.filter((e) => e.type === 'sessionCompleted');
    expect(sessionEvents.length).toBeLessThan(16);
  });

  it('T14. 인지도 보상은 상한 100을 넘지 않는다', () => {
    const state = reserved(demandConfig);
    state.venue.awarenessMilli = milli(95); // 보상 +12면 107이 될 자리

    // 완료 직전까지 진행한다. 그 사이 일반 세션도 인지도를 올리므로
    // 기대값을 고정하지 않고 완료 직전 값에서 계산한다.
    const running = runUntilPhase(state, 'IN_PROGRESS', demandConfig);
    const endsAt = running.tournament!.endsAtMinute!;
    let cur = running;
    while (cur.time.minute < endsAt - 1) cur = tick(cur, demandConfig).state;

    const beforeCompletion = cur.venue.awarenessMilli;
    expect(beforeCompletion + SMALL.awarenessRewardMilli).toBeGreaterThan(milli(100));

    const done = tick(cur, demandConfig).state;
    expect(done.venue.awarenessMilli).toBe(milli(100)); // 상한에서 멈춘다
    // 기록에는 실제로 반영된 증가분만 남는다
    const record = done.records.completedTournaments[0]!;
    expect(record.awarenessGainedMilli).toBeLessThan(SMALL.awarenessRewardMilli);
    expect(record.awarenessGainedMilli).toBeGreaterThanOrEqual(0);
  });

  it('인지도 여유가 있으면 보상 전액이 반영된다', () => {
    const state = reserved(demandConfig);
    const before = state.venue.awarenessMilli;
    const { state: done } = runUntilCompleted(state, demandConfig);
    const record = done.records.completedTournaments[0]!;
    // 대회 보상 외에 일반 세션 인지도도 오르므로 보상분만 따로 확인한다
    expect(record.awarenessGainedMilli).toBe(SMALL.awarenessRewardMilli);
    expect(done.venue.awarenessMilli).toBeGreaterThan(before);
  });

  it('T15. 개최 실적이 정확히 1 증가한다', () => {
    const state = reserved(demandConfig);
    expect(state.records.tournamentsDone).toBe(0);
    const { state: done, completionEvents } = runUntilCompleted(state, demandConfig);
    expect(done.records.tournamentsDone).toBe(1);
    expect(completionEvents).toBe(1);
    expect(done.records.completedTournaments).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* 자원 복귀                                                            */
/* ------------------------------------------------------------------ */

describe('T16~T17 자원 복귀와 나머지 테이블', () => {
  it('T16. 완료 시 예약 테이블이 담당 딜러를 유지한 채 일반 영업으로 돌아온다', () => {
    const state = reserved(demandConfig);
    const { state: done } = runUntilCompleted(state, demandConfig);

    for (const [i, tableId] of ['T1', 'T2'].entries()) {
      const table = done.tables.find((t) => t.id === tableId)!;
      expect(table.status).toBe('operating');
      expect(table.dealerId).toBe(['D1', 'D2'][i]);
      expect(table.pendingDealerId).toBeUndefined(); // closing 경로를 쓰지 않았다
      const dealer = done.staff.find((s) => s.id === table.dealerId)!;
      expect(dealer.duty).toBe('working');
      expect(dealer.assignedTableId).toBe(tableId);
    }
    // 테이블은 생기거나 사라지지 않았다
    expect(done.tables).toHaveLength(state.tables.length);

    // 기존 직원은 한 명도 사라지거나 바뀌지 않았다
    for (const before of state.staff) {
      const after = done.staff.find((s) => s.id === before.id);
      expect(after).toBeDefined();
      expect(after!.type).toBe(before.type);
    }

    // 늘어난 직원은 B-2B의 대회 전문 딜러 보상 1명뿐이다.
    // 완료 트랜잭션 자체가 직원을 만든 것이 아니라 9단계 보상이 지급한 것이다.
    const added = done.staff.filter((s) => !state.staff.some((b) => b.id === s.id));
    expect(added).toHaveLength(1);
    expect(added[0]!.type).toBe('tournament');
    expect(added[0]!.duty).toBe('standby');
    expect(added[0]!.assignedTableId).toBeNull();
  });

  it('완료 뒤 예약 딜러를 다시 배치할 수 있다', () => {
    const state = reserved(demandConfig, 0, { tables: 5, dealers: 4 });
    const { state: done } = runUntilCompleted(state, demandConfig);
    // T5는 딜러가 없는 상태. 이제 D1을 떼어내 옮길 수 있어야 한다.
    expect(validateCommand(done, { type: 'unassignDealer', tableId: 'T1' }, demandConfig).ok).toBe(
      true,
    );
  });

  it('T26. 완료는 렌더링 이벤트나 사용자 입력 없이 일어난다', () => {
    // 명령을 한 번도 주지 않고 tick만 돌린다.
    const state = reserved(demandConfig);
    let cur = state;
    let completed = false;
    for (let i = 0; i < 400; i += 1) {
      const r = tick(cur, demandConfig); // commands 인자 없음
      cur = r.state;
      if (r.events.some((e) => e.type === 'tournamentCompleted')) completed = true;
    }
    expect(completed).toBe(true);
    expect(cur.tournament).toBeNull();
    expect(cur.tables.find((t) => t.id === 'T1')?.status).toBe('operating');
  });

  it('T17. 선택되지 않은 테이블은 대회 내내 영업을 계속한다', () => {
    const state = reserved(demandConfig);
    let cur = state;
    let sawOtherTableSession = false;

    const running = runUntilPhase(state, 'IN_PROGRESS', demandConfig);
    cur = running;
    const endsAt = cur.tournament!.endsAtMinute!;
    // 완료 분(endsAt)에는 테이블이 일반 영업으로 돌아와 다시 착석이 일어난다.
    // 여기서는 "진행 중" 구간만 본다.
    while (cur.time.minute < endsAt - 1) {
      cur = tick(cur, demandConfig).state;
      expect(cur.tournament!.phase).toBe('IN_PROGRESS');
      if (cur.sessions.some((s) => ['T3', 'T4'].includes(s.tableId))) sawOtherTableSession = true;
      // 진행 중에도 예약 테이블에는 세션이 없다
      expect(cur.sessions.some((s) => ['T1', 'T2'].includes(s.tableId))).toBe(false);
    }

    expect(sawOtherTableSession).toBe(true);
    expect(cur.records.totalRevenueUnits).toBeGreaterThan(state.records.totalRevenueUnits);
  });
});

/* ------------------------------------------------------------------ */
/* 중복 정산·저장 복원                                                  */
/* ------------------------------------------------------------------ */

describe('T18 중복 정산 방지', () => {
  it('완료 뒤 계속 돌려도 보상과 정산이 한 번뿐이다', () => {
    const { state: done } = runUntilCompleted(reserved(demandConfig), demandConfig);
    const snapshot = {
      tournamentsDone: done.records.tournamentsDone,
      tournamentRevenue: done.records.totalTournamentRevenueUnits,
      oneOff: done.records.totalOneOffUnits,
      completed: done.records.completedTournaments.length,
    };

    const later = run(done, 600, demandConfig);
    expect(later.records.tournamentsDone).toBe(snapshot.tournamentsDone);
    expect(later.records.totalTournamentRevenueUnits).toBe(snapshot.tournamentRevenue);
    expect(later.records.totalOneOffUnits).toBe(snapshot.oneOff);
    expect(later.records.completedTournaments).toHaveLength(snapshot.completed);
    expect(later.venue.lockedCash).toBe(0);
  });

  it('저장·복원을 거쳐도 중복 정산이 없다', () => {
    const { state: done } = runUntilCompleted(reserved(demandConfig), demandConfig);
    const restored = deserialize(serialize(done), demandConfig);

    expect(serialize(restored)).toBe(serialize(done));
    const later = run(restored, 400, demandConfig);
    expect(later.records.tournamentsDone).toBe(1);
    expect(later.records.totalTournamentRevenueUnits).toBe(gold(SMALL.entryFeeGold * 16));
    expect(later.records.completedTournaments).toHaveLength(1);
  });

  it('이미 완료된 대회를 활성 예약으로 되돌린 상태는 거부된다', () => {
    const { state: done } = runUntilCompleted(reserved(demandConfig), demandConfig);
    const record = done.records.completedTournaments[0]!;

    const tampered = JSON.parse(serialize(done));
    tampered.tournament = {
      id: record.id,
      scale: 'small',
      phase: 'IN_PROGRESS',
      participants: record.participants,
      tableIds: [...record.tableIds],
      dealerIds: [...record.dealerIds],
      prepCostUnits: record.prepCostUnits,
      gameDay: record.gameDay,
      reservedAtMinute: 1,
      readyAtMinute: 2,
      startedAtMinute: 3,
      endsAtMinute: 4,
    };
    expect(() => deserialize(JSON.stringify(tampered), demandConfig)).toThrow(
      /이미 완료 기록이 있는 대회/,
    );
  });
});

describe('T19~T20 게임일 개최권', () => {
  it('T19. 완료된 대회도 같은 게임일 재예약을 막는다', () => {
    const { state: done } = runUntilCompleted(
      reserved(demandConfig, 0, { tables: 5, dealers: 5 }),
      demandConfig,
    );
    expect(done.tournament).toBeNull(); // 예약 슬롯은 비었다
    expect(done.time.minute).toBeLessThan(DEFAULT_CONFIG.time.minutesPerGameDay);

    const r = validateCommand(
      done,
      { type: 'reserveSmallTournament', tableIds: ['T3', 'T4'] },
      demandConfig,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('TOURNAMENT_DAY_USED');
  });

  it('T20. 다음 게임일에는 새 예약이 가능하다', () => {
    const { state: done } = runUntilCompleted(
      reserved(demandConfig, 0, { tables: 5, dealers: 5 }),
      demandConfig,
    );

    // 다음 게임일까지 진행한다
    const nextDayStart = DEFAULT_CONFIG.time.minutesPerGameDay;
    const next = run(done, nextDayStart - done.time.minute + 1, demandConfig);
    expect(next.tournament).toBeNull();

    const r = validateCommand(
      next,
      { type: 'reserveSmallTournament', tableIds: ['T3', 'T4'] },
      demandConfig,
    );
    expect(r.ok).toBe(true);

    // 두 번째 대회 ID가 이어진다
    applyCommand(next, { type: 'reserveSmallTournament', tableIds: ['T3', 'T4'] }, demandConfig, []);
    expect(next.tournament!.id).toBe('TN2');
    expect(next.records.usedTournamentDays).toHaveLength(2);
  });

  it('완료된 준비비는 자동 환불되지 않는다', () => {
    const state = reserved(demandConfig);
    const prep = state.tournament!.prepCostUnits;
    const cashBefore = state.venue.cash;
    const { state: done } = runUntilCompleted(state, demandConfig);

    // 준비비는 실제 지출로 확정됐다. 돌려받지 않는다.
    expect(done.records.totalOneOffUnits).toBe(state.records.totalOneOffUnits + prep);
    expect(done.venue.cash).not.toBe(cashBefore);
  });
});

/* ------------------------------------------------------------------ */
/* 결정성                                                               */
/* ------------------------------------------------------------------ */

describe('T21~T22 결정성', () => {
  it('T21. 시간 분할이 직렬화 결과를 바꾸지 않는다', () => {
    const base = reserved(demandConfig, 150);

    const one = run(cloneState(base), 600, demandConfig);

    let many = cloneState(base);
    for (const chunk of [7, 113, 60, 220, 1, 199]) many = run(many, chunk, demandConfig);

    expect(serialize(many)).toBe(serialize(one));
  });

  it('T22. DRAINING / READY / IN_PROGRESS 각각에서 저장·복원해도 최종 상태가 같다', () => {
    const base = reserved(demandConfig, 150);
    const horizon = 700;
    const straight = run(cloneState(base), horizon, demandConfig);

    const draining = cloneState(base);
    expect(draining.tournament!.phase).toBe('RESERVED_DRAINING');

    const ready = runUntilPhase(cloneState(base), 'RESERVED_READY', demandConfig);
    const running = runUntilPhase(cloneState(base), 'IN_PROGRESS', demandConfig);

    for (const checkpoint of [draining, ready, running]) {
      const elapsed = checkpoint.time.minute - base.time.minute;
      const restored = deserialize(serialize(checkpoint), demandConfig);
      expect(serialize(restored)).toBe(serialize(checkpoint));
      const finished = run(restored, horizon - elapsed, demandConfig);
      expect(serialize(finished)).toBe(serialize(straight));
    }
  });

  it('완료 순간에 저장·복원해도 이어지는 결과가 같다', () => {
    const base = reserved(demandConfig);
    const straight = run(cloneState(base), 500, demandConfig);

    const { state: atCompletion } = runUntilCompleted(cloneState(base), demandConfig);
    const elapsed = atCompletion.time.minute - base.time.minute;
    const restored = deserialize(serialize(atCompletion), demandConfig);
    const finished = run(restored, 500 - elapsed, demandConfig);

    expect(serialize(finished)).toBe(serialize(straight));
  });
});

/* ------------------------------------------------------------------ */
/* 저장 마이그레이션과 무결성                                            */
/* ------------------------------------------------------------------ */

describe('T23 v2 저장본 마이그레이션', () => {
  /** 현재 상태를 v2 저장본으로 되돌린다 (B-2A 필드 제거) */
  function toV2(state: GameState): string {
    const raw = JSON.parse(serialize(state)) as Record<string, never>;
    const obj = raw as unknown as {
      saveVersion: number;
      rulesVersion: string;
      tournament: Record<string, unknown> | null;
      records: Record<string, unknown>;
    };
    obj.saveVersion = 2;
    // 실제 v2 저장본은 당시 규칙 버전을 달고 있었다.
    // B-3의 마이그레이션은 (저장 구조, 규칙) 조합을 검사하므로 그대로 흉내 낸다.
    obj.rulesVersion = 'economy-0.1+adopt-v1';
    delete obj.records['totalTournamentRevenueUnits'];
    delete obj.records['completedTournaments'];
    delete obj.records['totalEmergencySupportUnits'];
    delete obj.records['emergencyMinutes'];
    delete obj.records['nextEmergencySeq'];
    // emergency 필드 자체는 v2에도 있었다(항상 null). 지우지 않는다.
    (obj as unknown as Record<string, unknown>)['emergency'] = null;
    if (obj.tournament) {
      delete obj.tournament['startedAtMinute'];
      delete obj.tournament['endsAtMinute'];
    }
    return JSON.stringify(obj);
  }

  it('대회가 없는 v2 저장본이 그대로 올라온다', () => {
    const state = run(createInitialState(DEFAULT_CONFIG), 100, DEFAULT_CONFIG);
    const migrated = deserialize(toV2(state), DEFAULT_CONFIG);

    expect(migrated.saveVersion).toBe(SAVE_VERSION);
    expect(migrated.tournament).toBeNull();
    expect(migrated.records.totalTournamentRevenueUnits).toBe(0);
    expect(migrated.records.completedTournaments).toEqual([]);
    expect(migrated.venue.cash).toBe(state.venue.cash);
  });

  it('DRAINING 예약이 자원과 잠금을 잃지 않는다', () => {
    const state = reserved(demandConfig, 150);
    expect(state.tournament!.phase).toBe('RESERVED_DRAINING');

    const migrated = deserialize(toV2(state), demandConfig);
    expect(migrated.tournament!.id).toBe(state.tournament!.id);
    expect(migrated.tournament!.phase).toBe('RESERVED_DRAINING');
    expect(migrated.tournament!.tableIds).toEqual(state.tournament!.tableIds);
    expect(migrated.tournament!.dealerIds).toEqual(state.tournament!.dealerIds);
    expect(migrated.venue.lockedCash).toBe(state.venue.lockedCash);
    expect(migrated.records.usedTournamentDays).toEqual(state.records.usedTournamentDays);
    expect(migrated.tournament!.startedAtMinute).toBeNull();
  });

  it('READY 예약이 완료로 오인되지 않고 READY에서 이어진다', () => {
    const ready = runUntilPhase(reserved(demandConfig), 'RESERVED_READY', demandConfig);
    const migrated = deserialize(toV2(ready), demandConfig);

    expect(migrated.tournament!.phase).toBe('RESERVED_READY');
    expect(migrated.records.tournamentsDone).toBe(0);
    expect(migrated.records.completedTournaments).toEqual([]);
    expect(migrated.venue.lockedCash).toBe(ready.venue.lockedCash);

    // 이어서 돌리면 정상적으로 시작하고 완료된다
    const { state: done } = runUntilCompleted(migrated, demandConfig);
    expect(done.records.tournamentsDone).toBe(1);
  });

  it('v2가 표현할 수 없는 단계는 거부한다', () => {
    const running = runUntilPhase(reserved(demandConfig), 'IN_PROGRESS', demandConfig);
    const raw = JSON.parse(toV2(running));
    raw.tournament.phase = 'IN_PROGRESS';
    expect(() => deserialize(JSON.stringify(raw), demandConfig)).toThrow(
      /v2 저장본이 표현할 수 없는 대회 단계/,
    );
  });
});

describe('T24 잘못된 대회 상태는 명시적으로 거부한다', () => {
  it('진행 중인데 시작 시각이 없으면 거부한다', () => {
    const running = runUntilPhase(reserved(demandConfig), 'IN_PROGRESS', demandConfig);
    const raw = JSON.parse(serialize(running));
    raw.tournament.startedAtMinute = null;
    expect(() => deserialize(JSON.stringify(raw), demandConfig)).toThrow(/시작·종료 시각이 없다/);
  });

  it('시작 전인데 종료 시각이 채워져 있으면 거부한다', () => {
    const state = reserved(demandConfig);
    const raw = JSON.parse(serialize(state));
    raw.tournament.endsAtMinute = 999;
    expect(() => deserialize(JSON.stringify(raw), demandConfig)).toThrow(
      /시작 전인데 시작·종료 시각이 채워져 있다/,
    );
  });

  it('종료 시각이 시작 시각보다 앞서면 거부한다', () => {
    const running = runUntilPhase(reserved(demandConfig), 'IN_PROGRESS', demandConfig);
    const raw = JSON.parse(serialize(running));
    raw.tournament.endsAtMinute = raw.tournament.startedAtMinute;
    expect(() => deserialize(JSON.stringify(raw), demandConfig)).toThrow(
      /종료 시각이 시작 시각보다 앞선다/,
    );
  });

  it('완료 기록에 중복 ID가 있으면 거부한다', () => {
    const { state: done } = runUntilCompleted(reserved(demandConfig), demandConfig);
    const raw = JSON.parse(serialize(done));
    raw.records.completedTournaments.push({ ...raw.records.completedTournaments[0] });
    expect(() => deserialize(JSON.stringify(raw), demandConfig)).toThrow(/중복 ID/);
  });

  it('진행 중 대회의 테이블 소유권이 어긋나면 거부한다', () => {
    const running = runUntilPhase(reserved(demandConfig), 'IN_PROGRESS', demandConfig);
    const raw = JSON.parse(serialize(running));
    raw.tables.find((t: { id: string }) => t.id === 'T1').status = 'operating';
    expect(() => deserialize(JSON.stringify(raw), demandConfig)).toThrow(/상태가 operating/);
  });
});

/* ------------------------------------------------------------------ */
/* 예상치 경계                                                          */
/* ------------------------------------------------------------------ */

describe('T25 예상치 경계는 그대로다', () => {
  it('IN_PROGRESS 상태의 예상치는 여전히 미지원이다', () => {
    const running = runUntilPhase(
      reserved(demandConfig, 0, { tables: 5, dealers: 5 }),
      'IN_PROGRESS',
      demandConfig,
    );
    const result = forecast(running, { type: 'hireDealer' }, demandConfig);
    expect(result.supported).toBe(false);
    if (result.supported) throw new Error('unreachable');
    expect(result.code).toBe('TOURNAMENT_NOT_IMPLEMENTED');
  });

  it('유효한 예약 명령의 예상치도 여전히 미지원이다', () => {
    const state = reservableState(demandConfig);
    expect(validateCommand(state, RESERVE, demandConfig).ok).toBe(true);
    const result = forecast(state, RESERVE, demandConfig);
    expect(result.supported).toBe(false);
    if (result.supported) throw new Error('unreachable');
    expect(result.code).toBe('TOURNAMENT_NOT_IMPLEMENTED');
  });

  it('대회가 끝난 뒤에는 평범한 투자 예상치가 다시 동작한다', () => {
    const { state: done } = runUntilCompleted(
      reserved(demandConfig, 0, { tables: 5, dealers: 4 }),
      demandConfig,
    );
    done.staff.push({ id: 'SPARE', type: 'normal', duty: 'standby', assignedTableId: null });

    const result = forecast(
      done,
      { type: 'assignDealer', tableId: 'T5', staffId: 'SPARE' },
      demandConfig,
    );
    expect(result.supported).toBe(true);
  });

  it('대회가 없는 평범한 투자 예상치는 변하지 않았다', () => {
    const config = fixedDemandConfig(20);
    const state = labState({ tables: 4, dealers: 3, cashGold: 50_000 }, config);
    state.staff.push({ id: 'SPARE', type: 'normal', duty: 'standby', assignedTableId: null });
    const result = forecast(
      state,
      { type: 'assignDealer', tableId: 'T4', staffId: 'SPARE' },
      config,
    );
    expect(result.supported).toBe(true);
    if (!result.supported) throw new Error('unreachable');
    expect(result.deltaCompletedGuests).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* 명령 안전성                                                          */
/* ------------------------------------------------------------------ */

describe('진행 중 명령 안전성', () => {
  it('진행 중에는 다른 대회를 예약할 수 없다', () => {
    const running = runUntilPhase(
      reserved(demandConfig, 0, { tables: 5, dealers: 5 }),
      'IN_PROGRESS',
      demandConfig,
    );
    const r = validateCommand(
      running,
      { type: 'reserveSmallTournament', tableIds: ['T3', 'T4'] },
      demandConfig,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('TOURNAMENT_ALREADY_RESERVED');
  });

  it('진행 중 예약 딜러를 옮기거나 대기시킬 수 없다', () => {
    const running = runUntilPhase(
      reserved(demandConfig, 0, { tables: 5, dealers: 4 }),
      'IN_PROGRESS',
      demandConfig,
    );
    expect(
      validateCommand(running, { type: 'assignDealer', tableId: 'T5', staffId: 'D1' }, demandConfig)
        .reason,
    ).toBe('STAFF_ALREADY_ASSIGNED');
    expect(
      validateCommand(running, { type: 'setStaffStandby', staffId: 'D1' }, demandConfig).reason,
    ).toBe('STAFF_HAS_ACTIVE_TABLE');
    expect(
      validateCommand(running, { type: 'unassignDealer', tableId: 'T1' }, demandConfig).reason,
    ).toBe('TABLE_NOT_AVAILABLE');
  });

  it('거절된 명령은 대회 상태를 바꾸지 않는다', () => {
    const running = runUntilPhase(
      reserved(demandConfig, 0, { tables: 5, dealers: 5 }),
      'IN_PROGRESS',
      demandConfig,
    );
    const before = serialize(running);
    const bad: Command = { type: 'reserveSmallTournament', tableIds: ['T3', 'T4'] };

    const withCmd = tick(cloneState(running), demandConfig, [bad]);
    const withoutCmd = tick(cloneState(running), demandConfig, []);

    expect(serialize(running)).toBe(before);
    expect(serialize(withCmd.state)).toBe(serialize(withoutCmd.state));
    const rejected: EngineEvent[] = withCmd.events.filter((e) => e.type === 'commandRejected');
    expect(rejected).toHaveLength(1);
  });
});
