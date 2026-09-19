/**
 * B-3 검수 재현 문제 3건의 회귀 검증.
 *
 *   1. 교체 예약 취소와 유지 대상 선택의 순서
 *   2. 손상된 현금을 지원금으로 정상화하는 문제
 *   3. v3 마이그레이션의 원본 규칙 버전 검사
 *
 * 필요한 상태에 도달했는지 먼저 단언한다. 조건이 안 맞으면 건너뛰어 통과하는
 * 테스트를 만들지 않는다.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, RULES_VERSION, SAVE_VERSION, gold } from '../src/config/economy.js';
import type { EconomyConfig } from '../src/config/economy.js';
import { applyCommand, validateCommand } from '../src/engine/commands.js';
import { minuteCosts } from '../src/engine/costs.js';
import { availableCash } from '../src/engine/derive.js';
import { selectKeptPair } from '../src/engine/emergency.js';
import { createInitialState, deserialize, serialize } from '../src/engine/state.js';
import { tick } from '../src/engine/tick.js';
import type { Command, GameState } from '../src/engine/types.js';
import { G, fixedDemandConfig, labState, run } from './helpers.js';

/** saveVersion 1~3이 함께 쓰던 유일한 계산 규칙 버전 */
const LEGACY_RULES_VERSION = 'economy-0.1+adopt-v1';

const demandConfig = fixedDemandConfig(20);
const noDemand = fixedDemandConfig(0);

/** 이번 분 비용을 1unit 못 내는 잔액으로 낮춘다 (잠긴 금액은 보존) */
function starve(state: GameState, config: EconomyConfig): GameState {
  state.venue.cash = state.venue.lockedCash + minuteCosts(state, config).total - 1;
  return state;
}

/* ------------------------------------------------------------------ */
/* 문제 1 — 교체 예약 취소가 유지 대상 선택보다 먼저 와야 한다             */
/* ------------------------------------------------------------------ */

describe('문제 1. 일반 교체 예약을 먼저 해제한 뒤 유지 대상을 고른다', () => {
  /**
   * 재현 조건을 정확히 만든다.
   *   T1  숙련 딜러 근무 + 일반 세션 진행 중
   *   T2  비어 있는 미운영 테이블
   *   SPARE  대기 일반 딜러가 T1의 교체 담당자로 예약됨
   */
  function reproState(config: EconomyConfig): GameState {
    // T1만 숙련 딜러로 운영, T2는 미운영으로 만든다
    const base = labState({ tables: 2, dealers: 1, dealerType: 'skilled' }, config);
    // 세션이 생길 때까지 진행
    const seeded = run(base, 150, config);

    seeded.staff.push({ id: 'SPARE', type: 'normal', duty: 'standby', assignedTableId: null });
    const assign: Command = { type: 'assignDealer', tableId: 'T1', staffId: 'SPARE' };
    expect(validateCommand(seeded, assign, config).ok).toBe(true);
    applyCommand(seeded, assign, config, []);
    return seeded;
  }

  it('재현 조건이 실제로 성립한다', () => {
    const state = reproState(demandConfig);

    const t1 = state.tables.find((t) => t.id === 'T1')!;
    const t2 = state.tables.find((t) => t.id === 'T2')!;
    const skilled = state.staff.find((s) => s.id === 'D1')!;
    const spare = state.staff.find((s) => s.id === 'SPARE')!;

    expect(skilled.type).toBe('skilled');
    expect(t1.dealerId).toBe('D1');
    expect(skilled.duty).toBe('working');
    expect(state.sessions.filter((s) => s.tableId === 'T1').length).toBeGreaterThan(0);

    expect(t2.status).toBe('idle');
    expect(t2.dealerId).toBeNull();
    expect(state.sessions.filter((s) => s.tableId === 'T2')).toHaveLength(0);

    expect(t1.pendingDealerId).toBe('SPARE');
    expect(spare.duty).toBe('standby');
    expect(spare.assignedTableId).toBeNull();
  });

  it('교체 예약이 남아 있는 동안에는 SPARE가 후보에서 빠진다 (수정 전 동작)', () => {
    const state = reproState(demandConfig);
    // 예약이 살아 있는 상태에서의 선택은 T1/숙련이다.
    // 긴급 운영은 이 시점의 선택을 쓰지 않는다 — 아래 테스트가 그것을 검증한다.
    expect(selectKeptPair(state, demandConfig)).toEqual({ tableId: 'T1', dealerId: 'D1' });
  });

  it('긴급 발동 시 예약을 먼저 해제하므로 더 저렴한 T2/SPARE를 고른다', () => {
    const config = demandConfig;
    const state = starve(reproState(config), config);

    const r = tick(state, config);
    const em = r.state.emergency;
    expect(em).not.toBeNull();

    // 유지비: T2+SPARE(일반) = 80+30 = 110 < T1+D1(숙련) = 110+30 = 140
    expect(em!.keptTableId).toBe('T2');
    expect(em!.keptDealerId).toBe('SPARE');

    const t2 = r.state.tables.find((t) => t.id === 'T2')!;
    expect(t2.status).toBe('operating');
    expect(t2.dealerId).toBe('SPARE');
    const spare = r.state.staff.find((s) => s.id === 'SPARE')!;
    expect(spare.duty).toBe('working');
    expect(spare.assignedTableId).toBe('T2');

    // 해제된 예약이 어디에도 남지 않는다
    for (const table of r.state.tables) expect(table.pendingDealerId).toBeUndefined();
  });

  it('T1의 기존 세션은 원래 숙련 딜러가 정상 완료한 뒤 대기로 전환된다', () => {
    const config = demandConfig;
    const state = starve(reproState(config), config);
    const before = state.sessions.filter((s) => s.tableId === 'T1');
    expect(before.length).toBeGreaterThan(0);
    const snapshot = before.map((s) => `${s.id}@${s.endsAtMinute}:${s.revenueUnits}`).sort();

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
      const t1 = cur.tables.find((t) => t.id === 'T1')!;
      if (t1.dealerId === null) break;
      // 정리 중에는 원래 숙련 딜러가 그대로 담당한다
      expect(t1.dealerId).toBe('D1');
    }

    // 완료 시각·매출이 그대로이고 정확히 한 번 정산됐다
    for (const entry of snapshot) {
      const id = entry.split('@')[0]!;
      expect(settled.get(id)).toBe(1);
    }

    const t1 = cur.tables.find((t) => t.id === 'T1')!;
    expect(t1.status).toBe('idle');
    expect(t1.dealerId).toBeNull();
    const skilled = cur.staff.find((s) => s.id === 'D1')!;
    expect(skilled.duty).toBe('standby');
    expect(skilled.assignedTableId).toBeNull();
  });

  it('이미 선택된 유지 대상을 긴급 운영이 끝날 때까지 교체하지 않는다', () => {
    const config = demandConfig;
    const state = starve(reproState(config), config);

    const first = tick(state, config);
    const em = first.state.emergency;
    expect(em).not.toBeNull();
    const pickedTable = em!.keptTableId;
    const pickedDealer = em!.keptDealerId;
    expect(pickedTable).toBe('T2');
    expect(pickedDealer).toBe('SPARE');

    // 정리 중 T1이 비고 더 저렴해 보이는 조합이 생겨도 바꾸지 않는다.
    // 긴급 운영이 살아 있는 매 분마다 확인한다.
    let cur = first.state;
    let checkedMinutes = 0;
    for (let i = 0; i < 600; i += 1) {
      cur = tick(cur, config).state;
      if (cur.emergency === null) break;
      expect(cur.emergency.keptTableId).toBe(pickedTable);
      expect(cur.emergency.keptDealerId).toBe(pickedDealer);
      checkedMinutes += 1;
    }
    expect(checkedMinutes).toBeGreaterThan(0);

    // 종료 후에도 유지하던 배치를 자동 복원하지 않는다
    expect(cur.emergency).toBeNull();
    expect(cur.tables.find((t) => t.id === 'T2')!.dealerId).toBe('SPARE');
    expect(cur.tables.filter((t) => t.status === 'operating')).toHaveLength(1);
  });

  it('대회 예약 자원은 해제 대상이 아니다', () => {
    const config = demandConfig;
    const state = labState({ tables: 4, dealers: 4, cashGold: 50_000 }, config);
    state.venue.awarenessMilli = 10_000;
    const seeded = run(state, 1, config);
    applyCommand(
      seeded,
      { type: 'reserveSmallTournament', tableIds: ['T1', 'T2'] },
      config,
      [],
    );
    const reserved = seeded.tournament!;
    starve(seeded, config);

    const r = tick(seeded, config);
    expect(r.state.emergency).not.toBeNull();
    // 대회 예약 테이블·딜러는 그대로다
    expect(r.state.tournament!.tableIds).toEqual(reserved.tableIds);
    expect(r.state.tournament!.dealerIds).toEqual(reserved.dealerIds);
    for (const id of reserved.tableIds) {
      expect(r.state.tables.find((t) => t.id === id)!.status).toBe('tournamentHeld');
    }
    // 유지 대상으로도 고르지 않는다
    expect(reserved.tableIds).not.toContain(r.state.emergency!.keptTableId);
  });
});

/* ------------------------------------------------------------------ */
/* 문제 2 — 손상된 현금을 지원금으로 덮지 않는다                          */
/* ------------------------------------------------------------------ */

describe('문제 2. 손상된 입력 현금은 지원 전에 거절한다', () => {
  const corrupted: { label: string; mutate: (s: GameState) => void; match: RegExp }[] = [
    {
      label: 'cash < 0',
      mutate: (s) => {
        s.venue.cash = -gold(1);
      },
      match: /보유 현금이 음수/,
    },
    {
      label: 'lockedCash < 0',
      mutate: (s) => {
        s.venue.lockedCash = -1;
      },
      match: /잠금 금액이 음수/,
    },
    {
      label: 'lockedCash > cash',
      mutate: (s) => {
        s.venue.cash = gold(10);
        s.venue.lockedCash = gold(20);
      },
      match: /잠금 금액이 보유 현금을 초과/,
    },
  ];

  for (const { label, mutate, match } of corrupted) {
    it(`${label}: tick이 지원 없이 거절한다`, () => {
      const state = createInitialState(DEFAULT_CONFIG);
      mutate(state);
      const before = serialize(state);

      expect(() => tick(state, DEFAULT_CONFIG)).toThrow(match);
      // 거절 시 원본 상태를 변경하지 않는다
      expect(serialize(state)).toBe(before);
      // 지원금이 지급되지 않았다
      expect(state.records.totalEmergencySupportUnits).toBe(0);
      expect(state.emergency).toBeNull();
    });

    it(`${label}: 저장 복원도 거절한다`, () => {
      const state = createInitialState(DEFAULT_CONFIG);
      mutate(state);
      expect(() => deserialize(serialize(state), DEFAULT_CONFIG)).toThrow(match);
    });
  }

  it('재현 사례: cash = -1G 저장본이 통과해 3.5G를 지원받지 않는다', () => {
    const state = createInitialState(DEFAULT_CONFIG);
    state.venue.cash = -60; // -1G
    const json = serialize(state);

    // 수정 전에는 deserialize가 통과하고 tick이 210units를 지원했다.
    expect(() => deserialize(json, DEFAULT_CONFIG)).toThrow(/보유 현금이 음수/);
    expect(() => tick(state, DEFAULT_CONFIG)).toThrow(/보유 현금이 음수/);
  });

  it('정상 경계는 계속 지원한다 — 잔액 0', () => {
    const config = noDemand;
    const state = labState({ tables: 2, dealers: 2 }, config);
    state.venue.cash = 0;
    const cost = minuteCosts(state, config).total;

    const r = tick(state, config);
    expect(r.state.emergency).not.toBeNull();
    expect(r.state.records.totalEmergencySupportUnits).toBe(cost);
    expect(r.state.venue.cash).toBe(0);
  });

  it('정상 경계는 계속 지원한다 — 비용과 같은 잔액이면 지원 없음', () => {
    const config = noDemand;
    const state = labState({ tables: 2, dealers: 2 }, config);
    state.venue.cash = minuteCosts(state, config).total;

    const r = tick(state, config);
    expect(r.state.emergency).toBeNull();
    expect(r.state.records.totalEmergencySupportUnits).toBe(0);
  });

  it('정상 경계는 계속 지원한다 — 1unit 부족이면 1unit만', () => {
    const config = noDemand;
    const state = labState({ tables: 2, dealers: 2 }, config);
    state.venue.cash = minuteCosts(state, config).total - 1;

    const r = tick(state, config);
    expect(r.state.emergency).not.toBeNull();
    expect(r.state.records.totalEmergencySupportUnits).toBe(1);
  });

  it('잠긴 준비비가 있어도 정상 지원 경로는 그대로다', () => {
    const config = demandConfig;
    const state = labState({ tables: 4, dealers: 4, cashGold: 50_000 }, config);
    state.venue.awarenessMilli = 10_000;
    const seeded = run(state, 1, config);
    applyCommand(seeded, { type: 'reserveSmallTournament', tableIds: ['T1', 'T2'] }, config, []);
    const prep = seeded.venue.lockedCash;
    expect(prep).toBeGreaterThan(0);
    starve(seeded, config);

    const r = tick(seeded, config);
    expect(r.state.records.totalEmergencySupportUnits).toBe(1);
    expect(r.state.venue.lockedCash).toBe(prep); // 준비비 보존
    expect(availableCash(r.state)).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* 문제 3 — v3 마이그레이션의 원본 규칙 버전 검사                         */
/* ------------------------------------------------------------------ */

describe('문제 3. 마이그레이션이 원본 규칙 버전 조합을 검사한다', () => {
  /** 현재 상태를 지정한 (saveVersion, rulesVersion) 조합의 과거 저장본으로 되돌린다 */
  function asLegacySave(state: GameState, saveVersion: number, rulesVersion: string): string {
    const raw = JSON.parse(serialize(state)) as Record<string, unknown>;
    raw['saveVersion'] = saveVersion;
    raw['rulesVersion'] = rulesVersion;
    const rec = raw['records'] as Record<string, unknown>;
    delete rec['totalEmergencySupportUnits'];
    delete rec['emergencyMinutes'];
    delete rec['nextEmergencySeq'];
    // tournament/remodel/emergency는 모든 버전에 있었다(값만 null). 지우지 않는다.
    raw['emergency'] = null;
    if (saveVersion <= 2) {
      delete rec['totalTournamentRevenueUnits'];
      delete rec['completedTournaments'];
    }
    if (saveVersion <= 1) {
      // v1에 실제로 없던 필드는 nextTournamentSeq뿐이다.
      // tournament/remodel/emergency는 작업 A부터 항상 직렬화됐다.
      delete rec['nextTournamentSeq'];
    }
    return JSON.stringify(raw);
  }

  it('알 수 없는 규칙 버전의 v3 저장본을 거절한다', () => {
    const state = run(createInitialState(DEFAULT_CONFIG), 50, DEFAULT_CONFIG);
    const json = asLegacySave(state, 3, 'economy-9.9+unknown');

    expect(() => deserialize(json, DEFAULT_CONFIG)).toThrow(/규칙 버전/);
  });

  it('현재 규칙 버전을 붙인 v3 저장본도 거절한다', () => {
    // saveVersion 3과 현재 규칙 버전은 실제로 존재한 적 없는 조합이다.
    const state = run(createInitialState(DEFAULT_CONFIG), 50, DEFAULT_CONFIG);
    const json = asLegacySave(state, 3, RULES_VERSION);

    expect(() => deserialize(json, DEFAULT_CONFIG)).toThrow(/규칙 버전/);
  });

  it('v1·v2 저장본도 규칙 버전이 맞지 않으면 거절한다', () => {
    const state = run(createInitialState(DEFAULT_CONFIG), 50, DEFAULT_CONFIG);
    for (const version of [1, 2]) {
      const json = asLegacySave(state, version, 'economy-9.9+unknown');
      expect(() => deserialize(json, DEFAULT_CONFIG)).toThrow(/규칙 버전/);
    }
  });

  it('정상 v1 -> v2 -> v3 -> v4 경로는 자산·누계를 보존한 채 통과한다', () => {
    const config = DEFAULT_CONFIG;
    const state = run(createInitialState(config), 300, config);
    expect(state.records.completedGuests).toBeGreaterThan(0);

    for (const version of [1, 2, 3]) {
      const migrated = deserialize(asLegacySave(state, version, LEGACY_RULES_VERSION), config);

      expect(migrated.saveVersion).toBe(SAVE_VERSION);
      expect(migrated.rulesVersion).toBe(RULES_VERSION);
      expect(migrated.emergency).toBeNull();
      expect(migrated.records.totalEmergencySupportUnits).toBe(0);
      expect(migrated.records.emergencyMinutes).toBe(0);
      expect(migrated.records.nextEmergencySeq).toBe(1);

      // 기존 자산·누계가 그대로다
      expect(migrated.venue.cash).toBe(state.venue.cash);
      expect(migrated.venue.lockedCash).toBe(state.venue.lockedCash);
      expect(migrated.records.completedGuests).toBe(state.records.completedGuests);
      expect(migrated.records.totalRevenueUnits).toBe(state.records.totalRevenueUnits);
      expect(migrated.tables).toHaveLength(state.tables.length);
      expect(migrated.staff).toHaveLength(state.staff.length);
    }
  });

  it('v3 저장본의 대회·보상·누계가 보존된다', () => {
    const config = demandConfig;
    const base = labState({ tables: 4, dealers: 4, cashGold: 50_000 }, config);
    base.venue.awarenessMilli = 10_000;
    const seeded = run(base, 1, config);
    applyCommand(seeded, { type: 'reserveSmallTournament', tableIds: ['T1', 'T2'] }, config, []);
    const withTournament = run(seeded, 400, config);

    expect(withTournament.records.tournamentsDone).toBe(1);
    expect(withTournament.records.completedTournaments).toHaveLength(1);
    expect(withTournament.staff.filter((s) => s.type === 'tournament')).toHaveLength(1);

    const migrated = deserialize(asLegacySave(withTournament, 3, LEGACY_RULES_VERSION), config);
    expect(migrated.records.tournamentsDone).toBe(1);
    expect(migrated.records.completedTournaments).toEqual(
      withTournament.records.completedTournaments,
    );
    expect(migrated.records.totalTournamentRevenueUnits).toBe(
      withTournament.records.totalTournamentRevenueUnits,
    );
    expect(migrated.unlocks).toEqual(withTournament.unlocks);
    expect(migrated.staff.filter((s) => s.type === 'tournament')).toHaveLength(1);
  });

  it('현재 버전 저장본은 마이그레이션 없이 그대로 읽힌다', () => {
    const state = run(createInitialState(DEFAULT_CONFIG), 100, DEFAULT_CONFIG);
    const restored = deserialize(serialize(state), DEFAULT_CONFIG);
    expect(serialize(restored)).toBe(serialize(state));
  });
});
