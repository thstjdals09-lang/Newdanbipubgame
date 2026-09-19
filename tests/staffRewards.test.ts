/**
 * 특별 직원 지급 보상 (작업 B-2B) 검증.
 *
 *   숙련 딜러       테이블 3개 설치 -> 1명 (Economy §5, Progression §4)
 *   대회 전문 딜러  소규모 대회 1회 정상 완료 -> 1명
 *
 * 실제 엔진 동작을 검사한다. 기대값을 프로덕션 코드에 심어 통과시키지 않는다.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, SAVE_VERSION, gold, milli } from '../src/config/economy.js';
import type { EconomyConfig, StaffType } from '../src/config/economy.js';
import { applyCommand, validateCommand } from '../src/engine/commands.js';
import { cloneState, createInitialState, deserialize, serialize } from '../src/engine/state.js';
import {
  SKILLED_DEALER_REWARD_ID,
  TOURNAMENT_SPECIALIST_REWARD_ID,
  tick,
} from '../src/engine/tick.js';
import { tournamentDurationMinutes } from '../src/engine/tournament.js';
import type { Command, GameState, StaffState, TournamentPhase } from '../src/engine/types.js';
import { G, fixedDemandConfig, labState, run } from './helpers.js';

const SMALL = DEFAULT_CONFIG.tournament.small;
const demandConfig = fixedDemandConfig(20);
const RESERVE: Command = { type: 'reserveSmallTournament', tableIds: ['T1', 'T2'] };

const byType = (state: GameState, type: StaffType): StaffState[] =>
  state.staff.filter((s) => s.type === type);

const hasMarker = (state: GameState, id: string): boolean =>
  state.unlocks.some((u) => u.id === id);

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

function runUntilCompleted(start: GameState, config: EconomyConfig): GameState {
  let cur = start;
  for (let i = 0; i < 3000; i += 1) {
    const r = tick(cur, config);
    cur = r.state;
    if (r.events.some((e) => e.type === 'tournamentCompleted')) return cur;
  }
  throw new Error('대회가 완료되지 않았다');
}

/* ------------------------------------------------------------------ */
/* 보상 1 — 숙련 딜러                                                   */
/* ------------------------------------------------------------------ */

describe('보상 1 — 숙련 딜러 (테이블 3개)', () => {
  const config = fixedDemandConfig(4);

  it('1. 테이블이 3개 미만이면 지급하지 않는다', () => {
    const state = run(labState({ tables: 2, dealers: 2 }, config), 500, config);
    expect(byType(state, 'skilled')).toHaveLength(0);
    expect(hasMarker(state, SKILLED_DEALER_REWARD_ID)).toBe(false);
    // 자격 해금 기록도 없다
    expect(hasMarker(state, 'skilledDealerGrant')).toBe(false);
  });

  it('2. 테이블 3개에서 대기 상태로 1명을 지급한다', () => {
    const state = run(labState({ tables: 3, dealers: 3 }, config), 1, config);

    const skilled = byType(state, 'skilled');
    expect(skilled).toHaveLength(1);
    expect(skilled[0]!.duty).toBe('standby');
    expect(skilled[0]!.assignedTableId).toBeNull();
    expect(hasMarker(state, SKILLED_DEALER_REWARD_ID)).toBe(true);
    // ID는 기존 단조 증가 규약을 따른다
    expect(skilled[0]!.id).toMatch(/^S\d+$/);
  });

  it('구매로 3개째 테이블이 생겨도 같은 분에 지급된다', () => {
    const rich = labState({ tables: 2, dealers: 2, cashGold: 50_000 }, config);
    const seeded = run(rich, 1, config);
    expect(byType(seeded, 'skilled')).toHaveLength(0);

    const after = tick(seeded, config, [{ type: 'buyTable' }]).state;
    expect(after.tables).toHaveLength(3);
    expect(byType(after, 'skilled')).toHaveLength(1);
  });

  it('3. 계속 틱을 돌려도 두 번 지급하지 않는다', () => {
    const state = run(labState({ tables: 3, dealers: 3 }, config), 2000, config);
    expect(byType(state, 'skilled')).toHaveLength(1);
    expect(state.unlocks.filter((u) => u.id === SKILLED_DEALER_REWARD_ID)).toHaveLength(1);
  });

  it('테이블을 더 사도 추가 지급하지 않는다', () => {
    const state = run(labState({ tables: 3, dealers: 3, cashGold: 100_000 }, config), 1, config);
    let cur = state;
    for (let i = 0; i < 3; i += 1) cur = tick(cur, config, [{ type: 'buyTable' }]).state;
    expect(cur.tables.length).toBeGreaterThan(3);
    expect(byType(cur, 'skilled')).toHaveLength(1);
  });

  it('8. 기존 테이블 배치를 빼앗지 않는다', () => {
    const before = run(labState({ tables: 3, dealers: 3 }, config), 1, config);
    const assignments = before.tables.map((t) => `${t.id}:${t.dealerId}:${t.status}`);

    const skilled = byType(before, 'skilled')[0]!;
    expect(before.tables.some((t) => t.dealerId === skilled.id)).toBe(false);

    const after = run(before, 300, config);
    expect(after.tables.map((t) => `${t.id}:${t.dealerId}:${t.status}`)).toEqual(assignments);
  });

  it('대기 상태이므로 급여가 붙지 않는다', () => {
    // 테이블 3개 + 딜러 3명. 숙련 딜러는 대기이므로 급여에 포함되지 않는다.
    const state = run(labState({ tables: 3, dealers: 3 }, config), 1, config);
    expect(byType(state, 'skilled')).toHaveLength(1);

    const before = state.records.totalWageUnits;
    const after = run(state, 60, config);
    expect(G(after.records.totalWageUnits - before)).toBe(3 * 80); // 근무 딜러 3명분만
  });

  it('플레이어가 명시적으로 배치하면 정상 동작한다', () => {
    const state = run(labState({ tables: 4, dealers: 3, cashGold: 50_000 }, config), 1, config);
    const skilled = byType(state, 'skilled')[0]!;

    // T4는 딜러가 없다. 자동 배치되지 않았음을 먼저 확인한다.
    expect(state.tables.find((t) => t.id === 'T4')?.dealerId).toBeNull();

    const cmd: Command = { type: 'assignDealer', tableId: 'T4', staffId: skilled.id };
    expect(validateCommand(state, cmd, config).ok).toBe(true);
    applyCommand(state, cmd, config, []);
    expect(state.tables.find((t) => t.id === 'T4')?.dealerId).toBe(skilled.id);
  });
});

/* ------------------------------------------------------------------ */
/* 보상 2 — 대회 전문 딜러                                               */
/* ------------------------------------------------------------------ */

describe('보상 2 — 대회 전문 딜러 (첫 소규모 대회 완료)', () => {
  it('5. 예약·준비완료·시작 시점에는 지급하지 않는다', () => {
    const state = reservableState(demandConfig);
    applyCommand(state, RESERVE, demandConfig, []);
    expect(byType(state, 'tournament')).toHaveLength(0);

    const draining = state;
    expect(draining.tournament!.phase).toBe('RESERVED_DRAINING');
    expect(byType(draining, 'tournament')).toHaveLength(0);

    const ready = runUntilPhase(state, 'RESERVED_READY', demandConfig);
    expect(byType(ready, 'tournament')).toHaveLength(0);
    expect(hasMarker(ready, TOURNAMENT_SPECIALIST_REWARD_ID)).toBe(false);

    const running = runUntilPhase(ready, 'IN_PROGRESS', demandConfig);
    expect(byType(running, 'tournament')).toHaveLength(0);
    expect(hasMarker(running, TOURNAMENT_SPECIALIST_REWARD_ID)).toBe(false);

    // 종료 예정 분 직전까지도 지급되지 않는다
    let cur = running;
    const endsAt = running.tournament!.endsAtMinute!;
    while (cur.time.minute < endsAt - 1) cur = tick(cur, demandConfig).state;
    expect(byType(cur, 'tournament')).toHaveLength(0);
  });

  it('6. 첫 완료와 같은 분에 대기 상태로 1명을 지급한다', () => {
    const state = reservableState(demandConfig);
    applyCommand(state, RESERVE, demandConfig, []);

    let cur = state;
    let grantMinute = -1;
    let completeMinute = -1;
    for (let i = 0; i < 400; i += 1) {
      const r = tick(cur, demandConfig);
      cur = r.state;
      for (const e of r.events) {
        if (e.type === 'tournamentCompleted') completeMinute = cur.time.minute;
        if (e.type === 'staffGranted' && e.staffType === 'tournament') {
          grantMinute = cur.time.minute;
          expect(e.rewardId).toBe(TOURNAMENT_SPECIALIST_REWARD_ID);
        }
      }
      if (completeMinute > 0) break;
    }

    expect(completeMinute).toBeGreaterThan(0);
    expect(grantMinute).toBe(completeMinute); // 3단계 완료 -> 같은 분 9단계 지급

    const specialists = byType(cur, 'tournament');
    expect(specialists).toHaveLength(1);
    expect(specialists[0]!.duty).toBe('standby');
    expect(specialists[0]!.assignedTableId).toBeNull();
    expect(hasMarker(cur, TOURNAMENT_SPECIALIST_REWARD_ID)).toBe(true);
  });

  it('7. 두 번째 대회를 완료해도 추가 지급하지 않는다', () => {
    const first = runUntilCompleted(
      (() => {
        const s = reservableState(demandConfig, { tables: 5, dealers: 5 });
        applyCommand(s, RESERVE, demandConfig, []);
        return s;
      })(),
      demandConfig,
    );
    expect(byType(first, 'tournament')).toHaveLength(1);

    // 다음 게임일로 넘어가 두 번째 대회를 연다
    const nextDay = run(
      first,
      DEFAULT_CONFIG.time.minutesPerGameDay - first.time.minute + 1,
      demandConfig,
    );
    const second: Command = { type: 'reserveSmallTournament', tableIds: ['T3', 'T4'] };
    expect(validateCommand(nextDay, second, demandConfig).ok).toBe(true);
    applyCommand(nextDay, second, demandConfig, []);

    const done = runUntilCompleted(nextDay, demandConfig);
    expect(done.records.tournamentsDone).toBe(2);
    expect(byType(done, 'tournament')).toHaveLength(1); // 여전히 1명
    expect(done.unlocks.filter((u) => u.id === TOURNAMENT_SPECIALIST_REWARD_ID)).toHaveLength(1);
  });

  it('8. 기존 테이블 배치를 빼앗지 않는다', () => {
    const state = reservableState(demandConfig);
    applyCommand(state, RESERVE, demandConfig, []);
    const done = runUntilCompleted(state, demandConfig);

    const specialist = byType(done, 'tournament')[0]!;
    expect(done.tables.some((t) => t.dealerId === specialist.id)).toBe(false);
    // 예약 테이블은 원래 딜러를 유지한 채 복귀했다
    expect(done.tables.find((t) => t.id === 'T1')?.dealerId).toBe('D1');
    expect(done.tables.find((t) => t.id === 'T2')?.dealerId).toBe('D2');
  });

  it('수동 배치한 전문 딜러를 다른 테이블에서 자동으로 떼어내지 않는다', () => {
    const state = reservableState(demandConfig, { tables: 5, dealers: 4 });
    applyCommand(state, RESERVE, demandConfig, []);
    const done = runUntilCompleted(state, demandConfig);

    const specialist = byType(done, 'tournament')[0]!;
    applyCommand(done, { type: 'assignDealer', tableId: 'T5', staffId: specialist.id }, demandConfig, []);
    expect(done.tables.find((t) => t.id === 'T5')?.dealerId).toBe(specialist.id);

    const later = run(done, 500, demandConfig);
    expect(later.tables.find((t) => t.id === 'T5')?.dealerId).toBe(specialist.id);
    expect(later.staff.find((s) => s.id === specialist.id)?.duty).toBe('working');
    expect(byType(later, 'tournament')).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* 지급이 진행 시간에 미치는 영향                                         */
/* ------------------------------------------------------------------ */

describe('12. 전문 딜러는 명시적으로 배치·예약해야 진행 시간이 줄어든다', () => {
  it('지급만으로는 진행 시간이 변하지 않는다', () => {
    const state = reservableState(demandConfig, { tables: 5, dealers: 5 });
    applyCommand(state, RESERVE, demandConfig, []);

    // 첫 대회는 지급 전이므로 기본 시간
    const running = runUntilPhase(state, 'IN_PROGRESS', demandConfig);
    expect(running.tournament!.endsAtMinute! - running.tournament!.startedAtMinute!).toBe(
      SMALL.baseDurationMinutes,
    );

    const done = runUntilCompleted(running, demandConfig);
    const specialist = byType(done, 'tournament')[0]!;
    expect(specialist.assignedTableId).toBeNull();

    // 배치하지 않은 채 다음 대회를 열면 여전히 기본 시간이다 (R3)
    const nextDay = run(
      done,
      DEFAULT_CONFIG.time.minutesPerGameDay - done.time.minute + 1,
      demandConfig,
    );
    applyCommand(nextDay, { type: 'reserveSmallTournament', tableIds: ['T3', 'T4'] }, demandConfig, []);
    expect(tournamentDurationMinutes(nextDay, nextDay.tournament!, demandConfig)).toBe(
      SMALL.baseDurationMinutes,
    );
  });

  it('배치한 테이블을 예약하면 1.25 배율이 적용된다', () => {
    const state = reservableState(demandConfig, { tables: 5, dealers: 5 });
    applyCommand(state, RESERVE, demandConfig, []);
    const done = runUntilCompleted(state, demandConfig);
    const specialist = byType(done, 'tournament')[0]!;

    // T3의 딜러를 떼고 전문 딜러를 배치한다 (플레이어의 명시적 조작)
    applyCommand(done, { type: 'unassignDealer', tableId: 'T3' }, demandConfig, []);
    let cur = run(done, 200, demandConfig); // 정리 완료 대기
    expect(cur.tables.find((t) => t.id === 'T3')?.dealerId).toBeNull();

    applyCommand(cur, { type: 'assignDealer', tableId: 'T3', staffId: specialist.id }, demandConfig, []);
    expect(cur.tables.find((t) => t.id === 'T3')?.dealerId).toBe(specialist.id);

    // 다음 게임일에 T3을 포함해 예약한다
    cur = run(cur, DEFAULT_CONFIG.time.minutesPerGameDay - cur.time.minute + 1, demandConfig);
    applyCommand(cur, { type: 'reserveSmallTournament', tableIds: ['T3', 'T4'] }, demandConfig, []);

    const expected = Math.ceil(
      (SMALL.baseDurationMinutes * 1000) / DEFAULT_CONFIG.staff.tournament.tournamentSpeedMilli,
    );
    expect(expected).toBe(192);
    expect(tournamentDurationMinutes(cur, cur.tournament!, demandConfig)).toBe(expected);
  });
});

/* ------------------------------------------------------------------ */
/* 기존 v3 저장본                                                       */
/* ------------------------------------------------------------------ */

describe('4 / 10. 지급 마커가 없는 기존 v3 저장본', () => {
  /** 지급 마커와 보상 직원만 제거해 B-2B 이전 v3 저장본을 만든다 */
  function stripRewards(state: GameState): string {
    const raw = JSON.parse(serialize(state)) as GameState;
    const rewardIds = [SKILLED_DEALER_REWARD_ID, TOURNAMENT_SPECIALIST_REWARD_ID];
    const grantedIds = raw.staff
      .filter((s) => s.type === 'skilled' || s.type === 'tournament')
      .filter((s) => s.assignedTableId === null)
      .map((s) => s.id);
    raw.unlocks = raw.unlocks.filter((u) => !rewardIds.includes(u.id));
    raw.staff = raw.staff.filter((s) => !grantedIds.includes(s.id));
    return JSON.stringify(raw);
  }

  it('4. 숙련 딜러 자격 기록만 있고 직원이 없으면 한 번 지급한다', () => {
    const config = fixedDemandConfig(4);
    const state = run(labState({ tables: 3, dealers: 3 }, config), 10, config);
    const old = deserialize(stripRewards(state), config);

    // B-2B 이전 저장본의 모습: 자격 기록은 있고 지급 마커와 직원은 없다
    expect(old.saveVersion).toBe(SAVE_VERSION);
    expect(hasMarker(old, 'skilledDealerGrant')).toBe(true);
    expect(hasMarker(old, SKILLED_DEALER_REWARD_ID)).toBe(false);
    expect(byType(old, 'skilled')).toHaveLength(0);

    const after = run(old, 1, config);
    expect(byType(after, 'skilled')).toHaveLength(1);
    expect(byType(after, 'skilled')[0]!.duty).toBe('standby');
    expect(hasMarker(after, SKILLED_DEALER_REWARD_ID)).toBe(true);

    // 이후로는 더 지급되지 않는다
    const later = run(after, 500, config);
    expect(byType(later, 'skilled')).toHaveLength(1);
  });

  it('10. 완료된 대회가 있는데 전문 딜러가 없으면 한 번 지급한다', () => {
    const state = reservableState(demandConfig);
    applyCommand(state, RESERVE, demandConfig, []);
    const done = runUntilCompleted(state, demandConfig);

    const old = deserialize(stripRewards(done), demandConfig);
    expect(old.records.completedTournaments).toHaveLength(1);
    expect(hasMarker(old, TOURNAMENT_SPECIALIST_REWARD_ID)).toBe(false);
    expect(byType(old, 'tournament')).toHaveLength(0);

    const after = run(old, 1, demandConfig);
    expect(byType(after, 'tournament')).toHaveLength(1);
    expect(byType(after, 'tournament')[0]!.duty).toBe('standby');
    expect(hasMarker(after, TOURNAMENT_SPECIALIST_REWARD_ID)).toBe(true);

    const later = run(after, 500, demandConfig);
    expect(byType(later, 'tournament')).toHaveLength(1);
  });

  it('역사적 대회 기록을 고쳐 쓰지 않는다', () => {
    const state = reservableState(demandConfig);
    applyCommand(state, RESERVE, demandConfig, []);
    const done = runUntilCompleted(state, demandConfig);
    const record = JSON.stringify(done.records.completedTournaments);

    const old = deserialize(stripRewards(done), demandConfig);
    const after = run(old, 100, demandConfig);
    expect(JSON.stringify(after.records.completedTournaments)).toBe(record);
    expect(after.records.tournamentsDone).toBe(done.records.tournamentsDone);
  });

  it('기존 직원을 지우거나 바꾸지 않는다', () => {
    const config = fixedDemandConfig(4);
    const state = run(labState({ tables: 3, dealers: 3 }, config), 10, config);
    const old = deserialize(stripRewards(state), config);
    const beforeIds = old.staff.map((s) => `${s.id}:${s.type}:${s.assignedTableId}`);

    const after = run(old, 5, config);
    for (const entry of beforeIds) {
      expect(after.staff.map((s) => `${s.id}:${s.type}:${s.assignedTableId}`)).toContain(entry);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 결정성과 회계                                                        */
/* ------------------------------------------------------------------ */

describe('9 / 11. 결정성과 저장 복원', () => {
  it('9. 지급 전후로 저장·복원해도 직원과 마커가 중복·유실되지 않는다', () => {
    const config = fixedDemandConfig(4);
    const base = labState({ tables: 3, dealers: 3 }, config);

    const beforeGrant = base; // 아직 틱을 돌리지 않아 지급 전
    expect(byType(beforeGrant, 'skilled')).toHaveLength(0);
    const restoredBefore = deserialize(serialize(beforeGrant), config);
    const grantedFromRestore = run(restoredBefore, 1, config);
    expect(byType(grantedFromRestore, 'skilled')).toHaveLength(1);

    const afterGrant = run(base, 1, config);
    const restoredAfter = deserialize(serialize(afterGrant), config);
    expect(serialize(restoredAfter)).toBe(serialize(afterGrant));
    const later = run(restoredAfter, 300, config);
    expect(byType(later, 'skilled')).toHaveLength(1);
    expect(later.unlocks.filter((u) => u.id === SKILLED_DEALER_REWARD_ID)).toHaveLength(1);
  });

  it('대회 보상 전후로 저장·복원해도 중복되지 않는다', () => {
    const state = reservableState(demandConfig);
    applyCommand(state, RESERVE, demandConfig, []);
    const running = runUntilPhase(state, 'IN_PROGRESS', demandConfig);

    const beforeRestored = deserialize(serialize(running), demandConfig);
    const doneFromRestore = runUntilCompleted(beforeRestored, demandConfig);
    expect(byType(doneFromRestore, 'tournament')).toHaveLength(1);

    const afterRestored = deserialize(serialize(doneFromRestore), demandConfig);
    expect(serialize(afterRestored)).toBe(serialize(doneFromRestore));
    const later = run(afterRestored, 400, demandConfig);
    expect(byType(later, 'tournament')).toHaveLength(1);
  });

  it('11. 시간 분할과 연속 진행의 직렬화 결과가 같다', () => {
    const state = reservableState(demandConfig);
    applyCommand(state, RESERVE, demandConfig, []);

    const one = run(cloneState(state), 700, demandConfig);

    let many = cloneState(state);
    for (const chunk of [3, 97, 1, 240, 59, 300]) many = run(many, chunk, demandConfig);

    expect(serialize(many)).toBe(serialize(one));
  });
});

describe('13. 기존 회계는 변하지 않는다', () => {
  it('일반 매출 불변식과 대회 정산이 그대로다', () => {
    const state = reservableState(demandConfig);
    applyCommand(state, RESERVE, demandConfig, []);
    const done = runUntilCompleted(state, demandConfig);

    expect(done.records.totalRevenueUnits).toBe(done.records.completedGuests * gold(200));
    expect(done.records.totalTournamentRevenueUnits).toBe(gold(SMALL.entryFeeGold * 16));
    expect(done.venue.lockedCash).toBe(0);
    expect(done.records.tournamentsDone).toBe(1);
  });

  it('보상 직원이 반복 비용 누계를 바꾸지 않는다', () => {
    const config = fixedDemandConfig(4);
    // 같은 구성을 보상 있이/없이 돌려 반복 비용을 비교한다.
    const withReward = run(labState({ tables: 3, dealers: 3 }, config), 1, config);
    expect(byType(withReward, 'skilled')).toHaveLength(1);

    const withoutReward = cloneState(withReward);
    withoutReward.staff = withoutReward.staff.filter((s) => s.type !== 'skilled');

    const a = run(withReward, 300, config);
    const b = run(withoutReward, 300, config);

    expect(a.records.totalWageUnits).toBe(b.records.totalWageUnits);
    expect(a.records.totalFacilityUnits).toBe(b.records.totalFacilityUnits);
    expect(a.records.totalVenueCostUnits).toBe(b.records.totalVenueCostUnits);
    expect(a.records.totalRevenueUnits).toBe(b.records.totalRevenueUnits);
    expect(a.venue.cash).toBe(b.venue.cash);
  });

  it('보상은 현금을 쓰지 않는다 (고용비 없음)', () => {
    const config = fixedDemandConfig(4);
    const before = labState({ tables: 3, dealers: 3 }, config);
    const oneOffBefore = before.records.totalOneOffUnits;
    const ledgerBefore = before.ledger.length;

    const after = run(before, 1, config);
    expect(byType(after, 'skilled')).toHaveLength(1);
    expect(after.records.totalOneOffUnits).toBe(oneOffBefore);
    expect(after.ledger).toHaveLength(ledgerBefore);
  });

  it('예약 중 상태에서도 보상이 대회 소유권을 건드리지 않는다', () => {
    const state = reservableState(demandConfig);
    applyCommand(state, RESERVE, demandConfig, []);
    const t0 = JSON.stringify(state.tournament);

    const running = runUntilPhase(state, 'IN_PROGRESS', demandConfig);
    expect(running.tournament!.tableIds).toEqual(JSON.parse(t0).tableIds);
    expect(running.tournament!.dealerIds).toEqual(JSON.parse(t0).dealerIds);
    expect(running.tournament!.participants).toBe(JSON.parse(t0).participants);
  });
});
