/**
 * 대회 자원 예약 (작업 B-1) 검증.
 *
 * T01~T18. 실제 엔진 동작을 검사한다.
 * 기대값을 프로덕션 코드에 심어 통과시키지 않는다.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, SAVE_VERSION, gold, milli } from '../src/config/economy.js';
import type { EconomyConfig } from '../src/config/economy.js';
import { expectedParticipants, tournamentPrepCostUnits } from '../src/engine/cash.js';
import { applyCommand, validateCommand } from '../src/engine/commands.js';
import { hourlyOperatingCostUnits, minuteCosts } from '../src/engine/costs.js';
import { availableCash, demandPerHourMilli, theoreticalCapacityMilli } from '../src/engine/derive.js';
import { forecast } from '../src/engine/forecast.js';
import { cloneState, createInitialState, deserialize, serialize } from '../src/engine/state.js';
import { tick } from '../src/engine/tick.js';
import {
  gameDayOf,
  isOperatingReserveAdopted,
  planSmallTournament,
  requiredOperatingReserveUnits,
} from '../src/engine/tournament.js';
import type { Command, EngineEvent, GameState } from '../src/engine/types.js';
import { UnsupportedStateError } from '../src/engine/types.js';
import { G, fixedDemandConfig, labState, run } from './helpers.js';

const SMALL = DEFAULT_CONFIG.tournament.small;

/**
 * 소규모 대회를 예약할 수 있는 최소 조건을 갖춘 상태.
 * 해금 기록은 실제 tick의 processUnlocks가 부여하도록 진행시킨다.
 */
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
  state.venue.awarenessMilli = milli(10); // 소규모 대회 해금 문턱
  // 해금 기록을 코드로 심지 않고 엔진이 부여하게 한다
  return run(state, 1, config);
}

/** 수요 20명/시간이면 예상 참가자 = min(16, floor(20 x 2)) = 16 */
const demandConfig = fixedDemandConfig(20);

const RESERVE: Command = { type: 'reserveSmallTournament', tableIds: ['T1', 'T2'] };

/** 지정한 단계에 도달할 때까지 진행한다. 도달하지 못하면 실패시킨다. */
function runUntilPhase(
  start: GameState,
  phase: 'RESERVED_DRAINING' | 'RESERVED_READY' | 'IN_PROGRESS',
  config: EconomyConfig,
  limit = 2000,
): GameState {
  let cur = start;
  for (let i = 0; i < limit; i += 1) {
    if (cur.tournament?.phase === phase) return cur;
    cur = tick(cur, config).state;
  }
  throw new Error(`단계 ${phase}에 도달하지 못했다`);
}

/** 대회가 완료될 때까지 진행한다. 완료 시점의 상태를 돌려준다. */
function runUntilCompleted(start: GameState, config: EconomyConfig, limit = 2000): GameState {
  let cur = start;
  for (let i = 0; i < limit; i += 1) {
    const r = tick(cur, config);
    cur = r.state;
    if (r.events.some((e) => e.type === 'tournamentCompleted')) return cur;
  }
  throw new Error('대회가 완료되지 않았다');
}

describe('T01 정상 예약', () => {
  it('예약이 하나의 명령으로 적용되고 필요한 정보가 모두 담긴다', () => {
    const state = reservableState(demandConfig);
    expect(validateCommand(state, RESERVE, demandConfig).ok).toBe(true);

    const events: EngineEvent[] = [];
    applyCommand(state, RESERVE, demandConfig, events);

    const t = state.tournament;
    expect(t).not.toBeNull();
    expect(t!.id).toBe('TN1');
    expect(t!.scale).toBe('small');
    expect(t!.phase).toBe('RESERVED_DRAINING');
    expect(t!.tableIds).toEqual(['T1', 'T2']);
    expect(t!.dealerIds).toEqual(['D1', 'D2']); // 선택 테이블의 현재 담당자에서 파생
    expect(t!.participants).toBe(16);
    expect(t!.prepCostUnits).toBe(tournamentPrepCostUnits(SMALL, 16));
    expect(t!.gameDay).toBe(gameDayOf(state.time.minute, demandConfig));
    expect(t!.reservedAtMinute).toBe(state.time.minute);
    expect(t!.readyAtMinute).toBeNull();

    expect(events.some((e) => e.type === 'tournamentReserved')).toBe(true);
    expect(state.tables.find((x) => x.id === 'T1')?.status).toBe('tournamentHeld');
    expect(state.tables.find((x) => x.id === 'T2')?.status).toBe('tournamentHeld');
  });

  it('참가자 수는 예약 시 수요로 확정되고 이후 수요 변화에 흔들리지 않는다', () => {
    const state = reservableState(demandConfig);
    const atReservation = expectedParticipants(demandPerHourMilli(state, demandConfig), SMALL);
    applyCommand(state, RESERVE, demandConfig, []);
    const fixed = state.tournament!.participants;
    expect(fixed).toBe(atReservation);

    const later = run(state, 200, demandConfig);
    expect(later.tournament!.participants).toBe(fixed);
  });

  it('예약 ID는 기존 단조 증가 카운터 규칙을 따른다', () => {
    const state = reservableState(demandConfig);
    expect(state.records.nextTournamentSeq).toBe(1);
    applyCommand(state, RESERVE, demandConfig, []);
    expect(state.tournament!.id).toBe('TN1');
    expect(state.records.nextTournamentSeq).toBe(2);
  });
});

describe('T02 운영 가능한 테이블이 2개 미만', () => {
  it('테이블이 1개뿐이면 개수 부족으로 거절한다', () => {
    const state = reservableState(demandConfig, { tables: 3, dealers: 3 });
    const r = validateCommand(
      state,
      { type: 'reserveSmallTournament', tableIds: ['T1'] },
      demandConfig,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('TOURNAMENT_TABLE_COUNT');
  });

  it('존재하지 않는 테이블을 고르면 거절한다', () => {
    const state = reservableState(demandConfig, { tables: 3, dealers: 3 });
    const r = validateCommand(
      state,
      { type: 'reserveSmallTournament', tableIds: ['T1', 'T99'] },
      demandConfig,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('TABLE_NOT_FOUND');
  });

  it('운영 중이 아닌 테이블(idle)은 거절한다', () => {
    const state = reservableState(demandConfig, { tables: 4, dealers: 1 });
    const r = validateCommand(
      state,
      { type: 'reserveSmallTournament', tableIds: ['T1', 'T2'] },
      demandConfig,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('TOURNAMENT_TABLE_NOT_OPERATING');
  });
});

describe('T03 담당 딜러 없음 / 변경 대기 중', () => {
  it('딜러가 없는 테이블은 거절한다', () => {
    const state = reservableState(demandConfig, { tables: 4, dealers: 4 });
    // T2의 딜러를 떼어내되 status는 operating으로 두어 딜러 검사만 걸리게 한다
    const t2 = state.tables.find((x) => x.id === 'T2')!;
    t2.dealerId = null;
    const r = validateCommand(state, RESERVE, demandConfig);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('TOURNAMENT_TABLE_NO_DEALER');
  });

  it('딜러 변경이 예약된 테이블은 거절한다', () => {
    const state = reservableState(demandConfig, { tables: 4, dealers: 4 });
    state.staff.push({ id: 'SPARE', type: 'normal', duty: 'standby', assignedTableId: null });
    const t2 = state.tables.find((x) => x.id === 'T2')!;
    t2.pendingDealerId = 'SPARE';
    const r = validateCommand(state, RESERVE, demandConfig);
    expect(r.ok).toBe(false);
    // closing으로 바뀌지 않은 채 pending만 걸린 경우도 잡아낸다
    expect(['TOURNAMENT_TABLE_DEALER_PENDING', 'TOURNAMENT_TABLE_NOT_OPERATING']).toContain(
      r.reason,
    );
  });

  it('딜러가 대기(standby) 상태면 거절한다', () => {
    const state = reservableState(demandConfig, { tables: 4, dealers: 4 });
    state.staff.find((x) => x.id === 'D2')!.duty = 'standby';
    const r = validateCommand(state, RESERVE, demandConfig);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('TOURNAMENT_TABLE_NO_DEALER');
  });
});

describe('T04 테이블 ID 중복', () => {
  it('같은 테이블을 두 번 고르면 거절한다', () => {
    const state = reservableState(demandConfig);
    const r = validateCommand(
      state,
      { type: 'reserveSmallTournament', tableIds: ['T1', 'T1'] },
      demandConfig,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('TOURNAMENT_TABLE_DUPLICATE');
  });
});

describe('T05 딜러 중복', () => {
  it('서로 다른 테이블이 같은 딜러를 가리키면 거절한다', () => {
    const state = reservableState(demandConfig, { tables: 4, dealers: 4 });
    // 정상 경로로는 만들 수 없는 조합이지만, 방어 검사가 살아 있는지 확인한다
    state.tables.find((x) => x.id === 'T2')!.dealerId = 'D1';
    const r = validateCommand(state, RESERVE, demandConfig);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('TOURNAMENT_DEALER_DUPLICATE');
  });
});

describe('T06 다른 테이블의 딜러를 자동으로 빼오지 않는다 (05 R9)', () => {
  it('예약은 선택한 테이블의 담당자만 쓰고 나머지 배치를 건드리지 않는다', () => {
    const state = reservableState(demandConfig, { tables: 4, dealers: 4 });
    const beforeAssignments = state.staff.map((s) => `${s.id}:${s.assignedTableId}:${s.duty}`);

    applyCommand(state, RESERVE, demandConfig, []);

    const afterAssignments = state.staff.map((s) => `${s.id}:${s.assignedTableId}:${s.duty}`);
    expect(afterAssignments).toEqual(beforeAssignments);
    // T3, T4는 그대로 영업 중
    expect(state.tables.find((x) => x.id === 'T3')?.status).toBe('operating');
    expect(state.tables.find((x) => x.id === 'T4')?.status).toBe('operating');
  });

  it('대기 딜러가 있어도 자동 배치하지 않는다', () => {
    const state = reservableState(demandConfig, { tables: 4, dealers: 4 });
    state.staff.push({ id: 'SPARE', type: 'normal', duty: 'standby', assignedTableId: null });
    applyCommand(state, RESERVE, demandConfig, []);
    const spare = state.staff.find((s) => s.id === 'SPARE')!;
    expect(spare.duty).toBe('standby');
    expect(spare.assignedTableId).toBeNull();
  });

  it('예약된 딜러는 다른 테이블에 배치할 수 없다', () => {
    const state = reservableState(demandConfig, { tables: 5, dealers: 4 });
    applyCommand(state, RESERVE, demandConfig, []);
    const r = validateCommand(
      state,
      { type: 'assignDealer', tableId: 'T5', staffId: 'D1' },
      demandConfig,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('STAFF_ALREADY_ASSIGNED');
  });

  it('예약된 딜러를 대기로 돌릴 수 없다', () => {
    const state = reservableState(demandConfig);
    applyCommand(state, RESERVE, demandConfig, []);
    const r = validateCommand(state, { type: 'setStaffStandby', staffId: 'D1' }, demandConfig);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('STAFF_HAS_ACTIVE_TABLE');
  });

  it('예약 테이블에는 딜러를 새로 붙이거나 뗄 수 없다', () => {
    const state = reservableState(demandConfig);
    state.staff.push({ id: 'SPARE', type: 'normal', duty: 'standby', assignedTableId: null });
    applyCommand(state, RESERVE, demandConfig, []);

    expect(
      validateCommand(state, { type: 'assignDealer', tableId: 'T1', staffId: 'SPARE' }, demandConfig)
        .reason,
    ).toBe('TABLE_NOT_AVAILABLE');
    expect(
      validateCommand(state, { type: 'unassignDealer', tableId: 'T1' }, demandConfig).reason,
    ).toBe('TABLE_NOT_AVAILABLE');
  });
});

describe('T07 예약 테이블에 신규 착석이 없다', () => {
  it('예약 후 예약 테이블에서 새 세션이 시작되지 않는다', () => {
    const state = reservableState(demandConfig);
    applyCommand(state, RESERVE, demandConfig, []);
    const startedBefore = new Set(state.sessions.map((s) => s.id));

    // 대회 완료(분 243) 전 구간만 본다. 완료 뒤 테이블이 일반 영업으로 돌아오는 것은
    // B-2A가 의도한 동작이며 T16/T26이 따로 검증한다.
    const later = run(state, 200, demandConfig);
    expect(later.tournament).not.toBeNull();
    for (const s of later.sessions) {
      if (startedBefore.has(s.id)) continue;
      expect(['T1', 'T2']).not.toContain(s.tableId);
    }
  });

  it('예약 테이블은 이론 처리 능력에서 빠진다', () => {
    const state = reservableState(demandConfig);
    const before = theoreticalCapacityMilli(state, demandConfig);
    applyCommand(state, RESERVE, demandConfig, []);
    const after = theoreticalCapacityMilli(state, demandConfig);
    expect(before - after).toBe(2 * 4000); // 일반 딜러 테이블 2개분
  });
});

describe('T08 기존 세션은 정상 완료되고 정확히 한 번 정산된다', () => {
  it('예약 시점의 진행 중 세션이 원래 시각·금액 그대로 끝난다', () => {
    const config = demandConfig;
    // 좌석이 찰 때까지 진행한 뒤 예약한다
    let state = reservableState(config);
    state = run(state, 150, config);
    const onReserved = state.sessions.filter((s) => s.tableId === 'T1' || s.tableId === 'T2');
    expect(onReserved.length).toBeGreaterThan(0);
    const snapshot = onReserved.map((s) => ({
      id: s.id,
      endsAtMinute: s.endsAtMinute,
      revenueUnits: s.revenueUnits,
    }));

    applyCommand(state, RESERVE, config, []);

    // 세션이 끝날 때까지 진행하며 정산 이벤트를 센다
    const settled = new Map<string, number>();
    let cur = state;
    for (let i = 0; i < 400; i += 1) {
      const r = tick(cur, config);
      cur = r.state;
      for (const e of r.events) {
        if (e.type === 'sessionCompleted') {
          settled.set(e.sessionId, (settled.get(e.sessionId) ?? 0) + 1);
        }
      }
    }

    for (const s of snapshot) {
      expect(settled.get(s.id)).toBe(1); // 정확히 한 번
    }
    // 예약 중에도 누적 매출 = 완료 이용객 x 200G 가 유지된다
    expect(cur.records.totalRevenueUnits).toBe(cur.records.completedGuests * gold(200));
  });

  it('예약 테이블은 정리 중에도 시설비를 계속 낸다', () => {
    const config = demandConfig;
    const state = reservableState(config);
    applyCommand(state, RESERVE, config, []);
    const before = state.records.totalFacilityUnits;
    const after = run(state, 60, config);
    // 4개 테이블 전부 시설비 대상 (예약 2개 포함)
    expect(G(after.records.totalFacilityUnits - before)).toBe(4 * 30);
  });

  it('예약된 딜러의 급여도 계속 나간다', () => {
    const config = demandConfig;
    const state = reservableState(config);
    applyCommand(state, RESERVE, config, []);
    const before = state.records.totalWageUnits;
    const after = run(state, 60, config);
    expect(G(after.records.totalWageUnits - before)).toBe(4 * 80);
  });
});

describe('T09 준비비 잠금과 사용 가능 현금', () => {
  it('cash는 그대로이고 lockedCash만 늘며 사용 가능 현금이 줄어든다', () => {
    const state = reservableState(demandConfig);
    const cashBefore = state.venue.cash;
    const availBefore = availableCash(state);

    applyCommand(state, RESERVE, demandConfig, []);

    const prep = tournamentPrepCostUnits(SMALL, 16);
    expect(G(prep)).toBe(16 * 60 + 16 * 20 + 600); // 상금 + 운영비 + 개최비 = 1,880G
    expect(state.venue.cash).toBe(cashBefore); // 차감하지 않는다
    expect(state.venue.lockedCash).toBe(prep);
    expect(availableCash(state)).toBe(availBefore - prep);
    expect(state.tournament!.prepCostUnits).toBe(prep);
  });

  it('참가비 수입·상금 지출·완료 보상을 인식하지 않는다', () => {
    const state = reservableState(demandConfig);
    const revenueBefore = state.records.totalRevenueUnits;
    const oneOffBefore = state.records.totalOneOffUnits;
    const awarenessBefore = state.venue.awarenessMilli;
    const doneBefore = state.records.tournamentsDone;

    applyCommand(state, RESERVE, demandConfig, []);

    expect(state.records.totalRevenueUnits).toBe(revenueBefore);
    expect(state.records.totalOneOffUnits).toBe(oneOffBefore); // settleLocked를 부르지 않는다
    expect(state.venue.awarenessMilli).toBe(awarenessBefore);
    expect(state.records.tournamentsDone).toBe(doneBefore);
  });

  it('잠긴 금액은 다른 구매에 쓸 수 없다', () => {
    const config = demandConfig;
    // 5번째 테이블 7,000G를 총보유현금으로는 살 수 있지만
    // 준비비가 잠긴 뒤 사용 가능 현금으로는 살 수 없는 잔액을 만든다
    const state = reservableState(config, { cashGold: 8000 });
    const availBefore = availableCash(state);
    expect(validateCommand(state, { type: 'buyTable' }, config).ok).toBe(true);

    applyCommand(state, RESERVE, config, []);

    // 가용 현금이 정확히 준비비만큼 줄어든다 (예비금은 잠기지 않는다)
    expect(availableCash(state)).toBe(availBefore - gold(1880));

    const fifthTablePrice = gold(7000);
    expect(state.venue.cash).toBeGreaterThan(fifthTablePrice); // 총액만 보면 가능
    expect(availableCash(state)).toBeLessThan(fifthTablePrice); // 가용으로는 불가능
    expect(validateCommand(state, { type: 'buyTable' }, config).reason).toBe('INSUFFICIENT_CASH');
  });

  it('C. 성공한 예약은 준비비만 잠근다 — 예비금은 잠기지 않는다', () => {
    const config = demandConfig;
    const state = reservableState(config);
    const reserveUnits = requiredOperatingReserveUnits(state, config);
    expect(reserveUnits).toBeGreaterThan(0);

    applyCommand(state, RESERVE, config, []);

    const prep = tournamentPrepCostUnits(SMALL, 16);
    expect(state.venue.lockedCash).toBe(prep);
    expect(state.venue.lockedCash).not.toBe(prep + reserveUnits); // 이중 잠금 아님
    // 예비금은 여전히 사용 가능 현금 안에 남아 있다
    expect(availableCash(state)).toBeGreaterThanOrEqual(reserveUnits);
  });
});

describe('T10 거절된 명령은 자산과 소유권을 보존한다', () => {
  const rejections: { label: string; make: (c: EconomyConfig) => GameState; command: Command }[] = [
    {
      label: '해금 전',
      make: (c) => labState({ tables: 4, dealers: 4, cashGold: 50_000 }, c),
      command: RESERVE,
    },
    {
      label: '테이블 중복',
      make: (c) => reservableState(c),
      command: { type: 'reserveSmallTournament', tableIds: ['T1', 'T1'] },
    },
    {
      label: '현금 부족',
      make: (c) => reservableState(c, { cashGold: 100 }),
      command: RESERVE,
    },
    {
      label: '참가자 부족',
      make: () => reservableState(fixedDemandConfig(1)),
      command: RESERVE,
    },
  ];

  for (const { label, make, command } of rejections) {
    it(`${label}: 상태가 전혀 바뀌지 않는다`, () => {
      const config = label === '참가자 부족' ? fixedDemandConfig(1) : demandConfig;
      const state = make(config);
      expect(validateCommand(state, command, config).ok).toBe(false);

      const before = serialize(state);
      const result = tick(cloneState(state), config, [command]);
      expect(result.events.filter((e) => e.type === 'commandRejected')).toHaveLength(1);

      // 원본 불변
      expect(serialize(state)).toBe(before);
      // 돈을 잠그지 않았고, 개최권을 쓰지 않았고, 예약도 없다
      expect(result.state.venue.lockedCash).toBe(0);
      expect(result.state.tournament).toBeNull();
      expect(result.state.records.usedTournamentDays).toEqual([]);
      expect(result.state.records.nextTournamentSeq).toBe(1);
      // 테이블 상태와 직원 배치가 그대로
      expect(result.state.tables.map((t) => t.status)).toEqual(
        run(state, 1, config).tables.map((t) => t.status),
      );

      // 거절된 명령은 시간 경과 외에 어떤 차이도 만들지 않는다
      const clean = tick(cloneState(state), config, []);
      expect(serialize(result.state)).toBe(serialize(clean.state));
    });
  }
});

describe('T11 중복 예약은 돈을 두 번 잠그거나 개최권을 또 쓰지 않는다', () => {
  it('두 번째 예약 명령은 거절되고 잠금·개최권이 그대로다', () => {
    const state = reservableState(demandConfig, { tables: 5, dealers: 5 });
    applyCommand(state, RESERVE, demandConfig, []);

    const lockedAfterFirst = state.venue.lockedCash;
    const daysAfterFirst = [...state.records.usedTournamentDays];
    const idAfterFirst = state.tournament!.id;

    const second = validateCommand(
      state,
      { type: 'reserveSmallTournament', tableIds: ['T3', 'T4'] },
      demandConfig,
    );
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('TOURNAMENT_ALREADY_RESERVED');

    const after = tick(state, demandConfig, [
      { type: 'reserveSmallTournament', tableIds: ['T3', 'T4'] },
    ]).state;
    expect(after.venue.lockedCash).toBe(lockedAfterFirst);
    expect(after.records.usedTournamentDays).toEqual(daysAfterFirst);
    expect(after.tournament!.id).toBe(idAfterFirst);
    expect(after.tables.find((t) => t.id === 'T3')?.status).toBe('operating');
  });

  it('같은 게임일에는 개최권을 한 번만 쓴다', () => {
    const state = reservableState(demandConfig, { tables: 5, dealers: 5 });
    applyCommand(state, RESERVE, demandConfig, []);
    expect(state.records.usedTournamentDays).toEqual([0]);

    // 예약을 인위적으로 지워도 같은 게임일은 다시 쓸 수 없다
    const cleared = cloneState(state);
    cleared.tournament = null;
    cleared.venue.lockedCash = 0;
    for (const t of cleared.tables) if (t.status === 'tournamentHeld') t.status = 'operating';

    const r = validateCommand(
      cleared,
      { type: 'reserveSmallTournament', tableIds: ['T3', 'T4'] },
      demandConfig,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('TOURNAMENT_DAY_USED');
  });
});

describe('T12 예약 소유권이 저장·복원을 견딘다', () => {
  it('복원 후 대회 ID·테이블·딜러·잠금·개최권이 모두 같다', () => {
    const config = demandConfig;
    let state = reservableState(config);
    state = run(state, 100, config);
    applyCommand(state, RESERVE, config, []);
    state = run(state, 50, config);

    const restored = deserialize(serialize(state), config);
    expect(serialize(restored)).toBe(serialize(state));

    expect(restored.tournament!.id).toBe(state.tournament!.id);
    expect(restored.tournament!.tableIds).toEqual(state.tournament!.tableIds);
    expect(restored.tournament!.dealerIds).toEqual(state.tournament!.dealerIds);
    expect(restored.venue.lockedCash).toBe(state.venue.lockedCash);
    expect(restored.records.usedTournamentDays).toEqual(state.records.usedTournamentDays);
    // 대회·테이블·딜러·돈이 새로 생기지 않았다
    expect(restored.tables).toHaveLength(state.tables.length);
    expect(restored.staff).toHaveLength(state.staff.length);
    expect(restored.venue.cash).toBe(state.venue.cash);
    expect(restored.records.nextTournamentSeq).toBe(state.records.nextTournamentSeq);
  });

  it('기존 일반 세션의 완료 시각이 복원 후에도 같다', () => {
    const config = demandConfig;
    let state = reservableState(config);
    state = run(state, 150, config);
    applyCommand(state, RESERVE, config, []);
    const ends = state.sessions.map((s) => `${s.id}@${s.endsAtMinute}`).sort();

    const restored = deserialize(serialize(state), config);
    expect(restored.sessions.map((s) => `${s.id}@${s.endsAtMinute}`).sort()).toEqual(ends);
  });

  it('복원 후 이어서 진행한 결과가 중단 없이 진행한 것과 같다', () => {
    const config = demandConfig;
    let base = reservableState(config);
    applyCommand(base, RESERVE, config, []);

    const straight = run(cloneState(base), 800, config);

    let broken = run(cloneState(base), 313, config);
    broken = deserialize(serialize(broken), config);
    broken = run(broken, 487, config);

    expect(serialize(broken)).toBe(serialize(straight));
  });

  it('saveVersion은 3이고 v1 저장본은 v1->v2->v3 체인으로 읽힌다', () => {
    expect(SAVE_VERSION).toBe(3);
    const state = run(createInitialState(DEFAULT_CONFIG), 50, DEFAULT_CONFIG);
    const v1 = JSON.parse(serialize(state)) as Record<string, unknown>;
    v1['saveVersion'] = 1;
    const rec = v1['records'] as Record<string, unknown>;
    delete rec['nextTournamentSeq'];
    delete rec['totalTournamentRevenueUnits'];
    delete rec['completedTournaments'];
    delete v1['tournament'];

    const migrated = deserialize(JSON.stringify(v1), DEFAULT_CONFIG);
    expect(migrated.saveVersion).toBe(3);
    expect(migrated.tournament).toBeNull();
    expect(migrated.records.nextTournamentSeq).toBe(1);
    expect(migrated.records.totalTournamentRevenueUnits).toBe(0);
    expect(migrated.records.completedTournaments).toEqual([]);
    expect(migrated.venue.cash).toBe(state.venue.cash); // 돈이 생기지 않았다
  });

  it('정의되지 않은 버전은 조용히 받아들이지 않는다', () => {
    const state = createInitialState(DEFAULT_CONFIG);
    const tampered = JSON.parse(serialize(state));
    tampered.saveVersion = 99;
    expect(() => deserialize(JSON.stringify(tampered), DEFAULT_CONFIG)).toThrow(
      /저장 스키마 버전 불일치/,
    );
  });

  it('예약 레코드와 실제 자원이 어긋난 저장본은 거부된다', () => {
    const config = demandConfig;
    const state = reservableState(config);
    applyCommand(state, RESERVE, config, []);

    const tampered = JSON.parse(serialize(state));
    tampered.tables.find((t: { id: string }) => t.id === 'T1').status = 'operating';
    expect(() => deserialize(JSON.stringify(tampered), config)).toThrow(/상태가 operating/);
  });
});

describe('T13 준비 -> 완료 전환에서도 소유권이 유지된다', () => {
  it('세션이 모두 끝나면 RESERVED_READY가 되고 테이블·딜러는 그대로다', () => {
    const config = demandConfig;
    let state = reservableState(config);
    state = run(state, 150, config);
    applyCommand(state, RESERVE, config, []);
    expect(state.tournament!.phase).toBe('RESERVED_DRAINING');

    let cur = state;
    let readyAt: number | null = null;
    for (let i = 0; i < 400; i += 1) {
      const r = tick(cur, config);
      cur = r.state;
      if (r.events.some((e) => e.type === 'tournamentReady')) {
        readyAt = cur.time.minute;
        break;
      }
    }

    expect(readyAt).not.toBeNull();
    expect(cur.tournament!.phase).toBe('RESERVED_READY');
    expect(cur.tournament!.readyAtMinute).toBe(readyAt);
    // 소유권 유지
    expect(cur.tournament!.tableIds).toEqual(['T1', 'T2']);
    expect(cur.tournament!.dealerIds).toEqual(['D1', 'D2']);
    expect(cur.tables.find((t) => t.id === 'T1')?.status).toBe('tournamentHeld');
    expect(cur.tables.find((t) => t.id === 'T1')?.dealerId).toBe('D1');
    expect(cur.staff.find((s) => s.id === 'D1')?.duty).toBe('working');
    expect(cur.staff.find((s) => s.id === 'D1')?.assignedTableId).toBe('T1');
    // 잠금은 그대로. 정산하지 않는다.
    expect(cur.venue.lockedCash).toBe(state.tournament!.prepCostUnits);
  });

  it('준비 완료는 마지막 세션이 정산된 다음 분에 확인된다 (Economy §10)', () => {
    const config = demandConfig;
    let state = reservableState(config);
    state = run(state, 150, config);
    applyCommand(state, RESERVE, config, []);

    let cur = state;
    let lastSettleMinute = -1;
    let readyMinute = -1;
    const reservedSessionIds = new Set(
      state.sessions.filter((s) => s.tableId === 'T1' || s.tableId === 'T2').map((s) => s.id),
    );

    for (let i = 0; i < 400; i += 1) {
      const r = tick(cur, config);
      cur = r.state;
      for (const e of r.events) {
        if (e.type === 'sessionCompleted' && reservedSessionIds.has(e.sessionId)) {
          lastSettleMinute = cur.time.minute;
        }
        if (e.type === 'tournamentReady') readyMinute = cur.time.minute;
      }
      if (readyMinute > 0) break;
    }

    expect(lastSettleMinute).toBeGreaterThan(0);
    expect(readyMinute).toBe(lastSettleMinute + 1);
  });

  it('RESERVED_READY는 완료된 대회가 아니다', () => {
    const config = demandConfig;
    const state = reservableState(config);
    applyCommand(state, RESERVE, config, []);
    // 예약 직후에는 세션이 없으므로 다음 분에 READY가 된다.
    // 시작은 그 다음 분이므로 이 시점은 여전히 "시작 전"이다.
    const ready = run(state, 1, config);

    expect(ready.tournament!.phase).toBe('RESERVED_READY');
    expect(ready.records.tournamentsDone).toBe(0);
    expect(ready.venue.lockedCash).toBe(state.tournament!.prepCostUnits);
    expect(ready.records.totalOneOffUnits).toBe(state.records.totalOneOffUnits);
    // 자원이 자동으로 풀리지 않는다
    expect(ready.tables.find((t) => t.id === 'T1')?.status).toBe('tournamentHeld');
  });

  it('딜러 변경 전환 코드가 예약 테이블을 건드리지 않는다', () => {
    const config = demandConfig;
    const state = reservableState(config, { tables: 4, dealers: 4 });
    applyCommand(state, RESERVE, config, []);
    // T3에 진짜 딜러 변경을 걸어 closing 경로를 동시에 돌린다
    state.staff.push({ id: 'SPARE', type: 'normal', duty: 'standby', assignedTableId: null });
    applyCommand(state, { type: 'assignDealer', tableId: 'T3', staffId: 'SPARE' }, config, []);

    // 대회 완료(분 243) 전 구간에서 확인한다.
    const after = run(state, 100, config);
    expect(after.tournament).not.toBeNull();
    // T3은 전환 완료
    expect(after.tables.find((t) => t.id === 'T3')?.dealerId).toBe('SPARE');
    // 예약 테이블은 딜러가 풀리지 않았다
    expect(after.tables.find((t) => t.id === 'T1')?.status).toBe('tournamentHeld');
    expect(after.tables.find((t) => t.id === 'T1')?.dealerId).toBe('D1');
    expect(after.tables.find((t) => t.id === 'T2')?.dealerId).toBe('D2');
  });
});

describe('T14 선택되지 않은 테이블은 계속 영업한다', () => {
  it('예약 중에도 나머지 테이블이 손님을 받고 매출을 낸다', () => {
    const config = demandConfig;
    const state = reservableState(config, { tables: 4, dealers: 4 });
    applyCommand(state, RESERVE, config, []);
    const revenueBefore = state.records.totalRevenueUnits;

    // 대회 완료 전 구간. 완료 뒤 복귀는 T16/T26이 검증한다.
    const after = run(state, 200, config);
    expect(after.tournament).not.toBeNull();
    expect(after.records.totalRevenueUnits).toBeGreaterThan(revenueBefore);

    const activeTables = new Set(after.sessions.map((s) => s.tableId));
    expect(activeTables.has('T3') || activeTables.has('T4')).toBe(true);
    expect(activeTables.has('T1')).toBe(false);
    expect(activeTables.has('T2')).toBe(false);
  });

  it('수요·만족도·급여 계산은 예약과 무관하게 계속 돈다', () => {
    const config = demandConfig;
    const state = reservableState(config, { tables: 4, dealers: 4 });
    applyCommand(state, RESERVE, config, []);
    const after = run(state, 400, config);

    expect(after.window.sumArrivals).toBeGreaterThan(0);
    expect(after.records.totalWageUnits).toBeGreaterThan(state.records.totalWageUnits);
    expect(after.records.totalVenueCostUnits).toBeGreaterThan(state.records.totalVenueCostUnits);
    expect(after.venue.satisfactionMilli).toBeGreaterThan(0);
  });
});

describe('T15 예약 상태의 예상치는 지어내지 않는다', () => {
  it('예약이 있으면 24시간 예측 대신 미지원을 돌려준다', () => {
    const config = demandConfig;
    const state = reservableState(config, { tables: 5, dealers: 5 });
    applyCommand(state, RESERVE, config, []);

    const result = forecast(state, { type: 'hireDealer' }, config);
    expect(result.supported).toBe(false);
    if (result.supported) throw new Error('unreachable');
    expect(result.code).toBe('TOURNAMENT_NOT_IMPLEMENTED');
    expect(result.detail).toMatch(/B-2/);
  });

  it('RESERVED_READY에서도 미지원이다', () => {
    const config = demandConfig;
    const state = reservableState(config, { tables: 5, dealers: 5 });
    applyCommand(state, RESERVE, config, []);
    const ready = run(state, 1, config);
    expect(ready.tournament!.phase).toBe('RESERVED_READY');

    const result = forecast(ready, { type: 'hireDealer' }, config);
    expect(result.supported).toBe(false);
    if (result.supported) throw new Error('unreachable');
    expect(result.code).toBe('TOURNAMENT_NOT_IMPLEMENTED');
  });

  it('예약이 없으면 예상치는 평소대로 동작한다', () => {
    const config = demandConfig;
    const state = reservableState(config, { tables: 4, dealers: 3 });
    state.staff.push({ id: 'SPARE', type: 'normal', duty: 'standby', assignedTableId: null });
    const result = forecast(
      state,
      { type: 'assignDealer', tableId: 'T4', staffId: 'SPARE' },
      config,
    );
    expect(result.supported).toBe(true);
  });
});

describe('T17 운영 현금 부족은 잘못된 상태를 만들지 않는다', () => {
  it('E. 매출이 없으면 예비금이 정확히 4게임시간 버티고, 그다음 분에 명시적으로 멈춘다', () => {
    const config = demandConfig;
    // 테이블 3개(해금 조건) 중 딜러는 2명뿐 -> 두 테이블을 예약하면 영업 테이블이 0이 된다.
    // 매출이 전혀 없으므로 예비금이 버티는 시간을 정확히 셀 수 있다.
    const state = reservableState(config, { tables: 3, dealers: 2 });
    expect(state.sessions).toHaveLength(0);

    const hourly = hourlyOperatingCostUnits(state, config);
    const reserveUnits = requiredOperatingReserveUnits(state, config);
    expect(reserveUnits).toBe(hourly * 4);

    const prep = tournamentPrepCostUnits(SMALL, 16);
    state.venue.cash = prep + reserveUnits; // 자격 경계에 정확히 맞춘다

    expect(validateCommand(state, RESERVE, config).ok).toBe(true);
    applyCommand(state, RESERVE, config, []);
    expect(state.venue.lockedCash).toBe(prep);
    expect(availableCash(state)).toBe(reserveUnits);

    // 예약 테이블 2개가 전부이므로 이후 신규 착석도 매출도 없다
    let cur = state;
    let survived = 0;
    let thrown: unknown = null;
    for (let i = 0; i < 500; i += 1) {
      try {
        cur = tick(cur, config).state;
        survived += 1;
      } catch (e) {
        thrown = e;
        break;
      }
    }

    expect(cur.records.totalRevenueUnits).toBe(0);
    // 4게임시간 = 240분을 정확히 버틴 뒤 241분째에 멈춘다
    expect(survived).toBe(240);
    expect(availableCash(cur)).toBe(0);

    expect(thrown).toBeInstanceOf(UnsupportedStateError);
    expect((thrown as UnsupportedStateError).code).toBe('EMERGENCY_NOT_IMPLEMENTED');
    // 잠긴 돈을 쓰지 않았고 음수를 잘라내지도 않았다
    expect(cur.venue.lockedCash).toBe(prep);
    expect(cur.venue.cash).toBe(prep);
  });

  it('잠긴 자금이 없을 때의 기존 동작은 그대로다', () => {
    const config = fixedDemandConfig(0);
    let state = labState({ tables: 5, dealers: 5, cashGold: 10 }, config);
    let sawNegative = false;
    for (let i = 0; i < 10; i += 1) {
      const r = tick(state, config);
      state = r.state;
      if (r.events.some((e) => e.type === 'cashNegative')) sawNegative = true;
    }
    expect(sawNegative).toBe(true);
    expect(state.venue.cash).toBeLessThan(0);
  });
});

describe('T18 예약은 해금·참가자·기존 대회·리모델링 제약을 우회하지 못한다', () => {
  it('해금 전에는 예약할 수 없다', () => {
    const config = demandConfig;
    const state = labState({ tables: 4, dealers: 4, cashGold: 50_000 }, config);
    expect(state.unlocks).toHaveLength(0);
    const r = validateCommand(state, RESERVE, config);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('TOURNAMENT_LOCKED');
  });

  it('테이블 3개 + 인지도 10을 채워야 해금된다', () => {
    const config = demandConfig;
    const notEnoughTables = run(
      (() => {
        const s = labState({ tables: 2, dealers: 2, cashGold: 50_000 }, config);
        s.venue.awarenessMilli = milli(10);
        return s;
      })(),
      1,
      config,
    );
    expect(validateCommand(notEnoughTables, RESERVE, config).reason).toBe('TOURNAMENT_LOCKED');

    const notEnoughAwareness = run(labState({ tables: 4, dealers: 4, cashGold: 50_000 }, config), 1, config);
    expect(validateCommand(notEnoughAwareness, RESERVE, config).reason).toBe('TOURNAMENT_LOCKED');
  });

  it('예상 참가자가 최소치에 못 미치면 거절한다', () => {
    const low = fixedDemandConfig(3); // floor(3 x 2) = 6 < 8
    const state = reservableState(low);
    expect(expectedParticipants(demandPerHourMilli(state, low), SMALL)).toBeLessThan(
      SMALL.minParticipants,
    );
    const r = validateCommand(state, RESERVE, low);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('TOURNAMENT_PARTICIPANTS_TOO_FEW');
  });

  it('리모델링이 진행 중이면 거절한다 (P08)', () => {
    const config = demandConfig;
    const state = reservableState(config);
    (state as { remodel: unknown }).remodel = { id: 'RM1' };
    const r = validateCommand(state, RESERVE, config);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('REMODEL_IN_PROGRESS');
  });

  it('준비비를 못 내면 거절한다 (P09)', () => {
    const config = demandConfig;
    const state = reservableState(config, { cashGold: 1000 }); // 준비비 1,880G
    const r = validateCommand(state, RESERVE, config);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('INSUFFICIENT_CASH');
  });
});

describe('운영 예비금 — 채택된 규칙 (05 R10, 잠정)', () => {
  it('기본 설정이 4게임시간을 채택하고 있다', () => {
    expect(DEFAULT_CONFIG.tournamentOperatingReserveHours).toBe(4);
    expect(isOperatingReserveAdopted(DEFAULT_CONFIG)).toBe(true);
  });

  it('예비금은 기존 시간당 운영비 파생값 하나만 쓴다 — 두 번째 계산이 없다', () => {
    const config = demandConfig;
    const state = reservableState(config);

    // hourlyOperatingCostUnits는 기존 minuteCosts에서 파생된다
    expect(hourlyOperatingCostUnits(state, config)).toBe(minuteCosts(state, config).total * 60);
    // 예비금은 그 값 x 4 그대로다
    expect(requiredOperatingReserveUnits(state, config)).toBe(
      hourlyOperatingCostUnits(state, config) * 4,
    );
  });

  it('A. 필요 금액과 정확히 같으면 예약할 수 있다', () => {
    const config = demandConfig;
    const state = reservableState(config);
    const required = tournamentPrepCostUnits(SMALL, 16) + requiredOperatingReserveUnits(state, config);

    state.venue.cash = required;
    expect(availableCash(state)).toBe(required);

    const r = validateCommand(state, RESERVE, config);
    expect(r.ok).toBe(true);
  });

  it('B. 내부 단위로 1 모자라면 거절한다', () => {
    const config = demandConfig;
    const state = reservableState(config);
    const required = tournamentPrepCostUnits(SMALL, 16) + requiredOperatingReserveUnits(state, config);

    state.venue.cash = required - 1;
    const r = validateCommand(state, RESERVE, config);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('TOURNAMENT_RESERVE_SHORTFALL');
  });

  it('준비비는 낼 수 있지만 예비금이 모자라는 구간을 구분해 거절한다', () => {
    const config = demandConfig;
    const state = reservableState(config);
    const prep = tournamentPrepCostUnits(SMALL, 16);
    const reserve = requiredOperatingReserveUnits(state, config);
    expect(reserve).toBeGreaterThan(0);

    // 준비비만 겨우 되는 잔액: 준비비 검사는 통과, 예비금 검사에서 걸린다
    state.venue.cash = prep;
    const r = validateCommand(state, RESERVE, config);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('TOURNAMENT_RESERVE_SHORTFALL');

    // 준비비조차 안 되면 사유가 다르다
    state.venue.cash = prep - 1;
    expect(validateCommand(state, RESERVE, config).reason).toBe('INSUFFICIENT_CASH');
  });

  it('D. 예비금 부족으로 거절되면 자산과 소유권이 그대로다', () => {
    const config = demandConfig;
    const state = reservableState(config);
    const required = tournamentPrepCostUnits(SMALL, 16) + requiredOperatingReserveUnits(state, config);
    state.venue.cash = required - 1;

    const before = serialize(state);
    const result = tick(cloneState(state), config, [RESERVE]);

    const rejected = result.events.filter((e) => e.type === 'commandRejected');
    expect(rejected).toHaveLength(1);
    expect(serialize(state)).toBe(before); // 원본 불변

    expect(result.state.venue.lockedCash).toBe(0);
    expect(result.state.tournament).toBeNull();
    expect(result.state.records.usedTournamentDays).toEqual([]);
    expect(result.state.records.nextTournamentSeq).toBe(1);
    expect(result.state.tables.every((t) => t.status !== 'tournamentHeld')).toBe(true);
    expect(result.state.staff.map((x) => `${x.id}:${x.assignedTableId}:${x.duty}`)).toEqual(
      state.staff.map((x) => `${x.id}:${x.assignedTableId}:${x.duty}`),
    );

    // 시간 경과 외에는 아무 차이도 없다
    const clean = tick(cloneState(state), config, []);
    expect(serialize(result.state)).toBe(serialize(clean.state));
  });

  it('예비금 요구는 대회 예약에만 적용된다 — 일반 구매는 그대로다', () => {
    const config = demandConfig;
    const state = reservableState(config);
    const prep = tournamentPrepCostUnits(SMALL, 16);
    state.venue.cash = prep; // 대회는 예비금 부족

    expect(validateCommand(state, RESERVE, config).reason).toBe('TOURNAMENT_RESERVE_SHORTFALL');
    // 같은 잔액에서 일반 구매는 예비금을 요구하지 않는다 (Progression §3은 경고일 뿐)
    expect(validateCommand(state, { type: 'hireDealer' }, config).ok).toBe(true);
    expect(validateCommand(state, { type: 'hireServiceStaff' }, config).ok).toBe(true);
  });

  it('G. 예약·준비 완료 상태가 저장·복원에서 결정적이다', () => {
    const config = demandConfig;
    let state = reservableState(config);
    state = run(state, 150, config);
    applyCommand(state, RESERVE, config, []);

    // 준비 중(DRAINING) 저장·복원
    expect(state.tournament!.phase).toBe('RESERVED_DRAINING');
    const drainingRestored = deserialize(serialize(state), config);
    expect(serialize(drainingRestored)).toBe(serialize(state));

    // 준비 완료(READY)까지 진행한 뒤 저장·복원
    const ready = runUntilPhase(state, 'RESERVED_READY', config);
    expect(ready.tournament!.phase).toBe('RESERVED_READY');
    const readyRestored = deserialize(serialize(ready), config);
    expect(serialize(readyRestored)).toBe(serialize(ready));

    // 진행 중(IN_PROGRESS)에서도 같다
    const running = runUntilPhase(ready, 'IN_PROGRESS', config);
    const runningRestored = deserialize(serialize(running), config);
    expect(serialize(runningRestored)).toBe(serialize(running));

    // 복원 지점을 바꿔도 이어서 진행한 결과가 같다
    const straight = run(cloneState(state), 600, config);
    let broken = run(cloneState(state), 211, config);
    broken = deserialize(serialize(broken), config);
    broken = run(broken, 389, config);
    expect(serialize(broken)).toBe(serialize(straight));
  });
});

describe('planSmallTournament는 상태를 수정하지 않는다', () => {
  it('판정만으로는 어떤 필드도 바뀌지 않는다', () => {
    const state = reservableState(demandConfig);
    const before = serialize(state);
    planSmallTournament(state, ['T1', 'T2'], demandConfig);
    planSmallTournament(state, ['T1', 'T1'], demandConfig);
    planSmallTournament(state, ['T9'], demandConfig);
    expect(serialize(state)).toBe(before);
  });
});
