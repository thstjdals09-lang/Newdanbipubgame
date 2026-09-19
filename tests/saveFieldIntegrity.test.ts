/**
 * 저장 필수 필드 무결성 검증.
 *
 * tournament / remodel / emergency는 작업 A(saveVersion 1)부터 모든 저장본에
 * 존재했다. 따라서 **값이 null인 것과 필드가 누락된 것은 다르다.**
 *
 * 누락을 null로 자동 복구하면 손상된 저장본이 정상 상태로 세탁된다.
 * 특히 대회 예약 중 tournament를 지우면 준비비 잠금과 tournamentHeld 테이블만
 * 남은 상태가 "대회 없음"으로 통과해 버린다.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, milli } from '../src/config/economy.js';
import type { EconomyConfig } from '../src/config/economy.js';
import { applyCommand } from '../src/engine/commands.js';
import { minuteCosts } from '../src/engine/costs.js';
import { cloneState, createInitialState, deserialize, serialize } from '../src/engine/state.js';
import { tick } from '../src/engine/tick.js';
import type { GameState } from '../src/engine/types.js';
import { fixedDemandConfig, labState, run } from './helpers.js';

const demandConfig = fixedDemandConfig(20);
const noDemand = fixedDemandConfig(0);
const REQUIRED = ['tournament', 'remodel', 'emergency'] as const;

/** 필드를 통째로 지운 저장본 JSON */
function withoutField(state: GameState, field: string): string {
  const raw = JSON.parse(serialize(state)) as Record<string, unknown>;
  expect(field in raw).toBe(true); // 원래는 있어야 한다
  delete raw[field];
  return JSON.stringify(raw);
}

/** 필드를 지운 런타임 상태 (직접 tick에 넣기 위한 것) */
function stripField(state: GameState, field: string): GameState {
  const copy = JSON.parse(serialize(state)) as GameState;
  delete (copy as unknown as Record<string, unknown>)[field];
  return copy;
}

/** 대회를 예약한 상태 */
function reservedState(config: EconomyConfig): GameState {
  const base = labState({ tables: 4, dealers: 4, cashGold: 50_000 }, config);
  base.venue.awarenessMilli = milli(10);
  const seeded = run(base, 1, config);
  applyCommand(seeded, { type: 'reserveSmallTournament', tableIds: ['T1', 'T2'] }, config, []);
  return seeded;
}

/** 긴급 운영이 살아 있는 상태 */
function emergencyState(config: EconomyConfig): GameState {
  const base = labState({ tables: 3, dealers: 3 }, config);
  base.venue.cash = minuteCosts(base, config).total - 1;
  const after = tick(base, config).state;
  expect(after.emergency).not.toBeNull();
  return after;
}

/* ------------------------------------------------------------------ */

describe('현재 버전에서 필수 필드 누락은 명확한 오류로 거절한다', () => {
  for (const field of REQUIRED) {
    it(`${field} 누락: deserialize가 거절한다`, () => {
      const state = run(createInitialState(DEFAULT_CONFIG), 50, DEFAULT_CONFIG);
      const json = withoutField(state, field);

      expect(() => deserialize(json, DEFAULT_CONFIG)).toThrow(
        new RegExp(`필수 필드 ${field}가 없다`),
      );
    });

    it(`${field} 누락: 직접 tick도 TypeError 대신 무결성 오류로 거절한다`, () => {
      const state = run(createInitialState(DEFAULT_CONFIG), 50, DEFAULT_CONFIG);
      const broken = stripField(state, field);

      let thrown: unknown = null;
      try {
        tick(broken, DEFAULT_CONFIG);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(TypeError);
      expect((thrown as Error).message).toMatch(new RegExp(`필수 필드 ${field}가 없다`));
    });

    it(`${field} 누락: cloneState가 null로 바꿔 숨기지 않는다`, () => {
      const state = run(createInitialState(DEFAULT_CONFIG), 50, DEFAULT_CONFIG);
      const broken = stripField(state, field);

      expect(() => cloneState(broken)).toThrow(new RegExp(`필수 필드 ${field}가 없다`));
    });

    it(`${field}가 undefined인 경우도 거절한다`, () => {
      const state = run(createInitialState(DEFAULT_CONFIG), 50, DEFAULT_CONFIG);
      const broken = JSON.parse(serialize(state)) as GameState;
      (broken as unknown as Record<string, unknown>)[field] = undefined;

      expect(() => tick(broken, DEFAULT_CONFIG)).toThrow(/필수 필드/);
    });
  }
});

describe('대회 예약 중 tournament 누락은 어떤 경로로도 우회할 수 없다', () => {
  it('재현 조건이 성립한다', () => {
    const state = reservedState(demandConfig);
    expect(state.tournament).not.toBeNull();
    expect(state.venue.lockedCash).toBeGreaterThan(0);
    expect(state.tables.filter((t) => t.status === 'tournamentHeld')).toHaveLength(2);
  });

  it('deserialize -> cloneState -> tick 경로 전체에서 막힌다', () => {
    const state = reservedState(demandConfig);
    const json = withoutField(state, 'tournament');

    // 1) 복원 단계
    expect(() => deserialize(json, demandConfig)).toThrow(/필수 필드 tournament가 없다/);

    // 2) 복원을 건너뛰고 런타임 상태를 직접 망가뜨려도 복제에서 막힌다
    const broken = stripField(state, 'tournament');
    expect(() => cloneState(broken)).toThrow(/필수 필드 tournament가 없다/);

    // 3) tick 진입에서도 막힌다
    expect(() => tick(broken, demandConfig)).toThrow(/필수 필드 tournament가 없다/);
  });

  it('잠금과 tournamentHeld만 남은 상태가 "대회 없음"으로 통과하지 않는다', () => {
    const state = reservedState(demandConfig);
    const broken = stripField(state, 'tournament');

    // 손상 증거가 그대로 남아 있다 — 이 상태가 정상으로 세탁되면 안 된다
    expect(broken.venue.lockedCash).toBeGreaterThan(0);
    expect(broken.tables.filter((t) => t.status === 'tournamentHeld')).toHaveLength(2);
    expect('tournament' in (broken as unknown as Record<string, unknown>)).toBe(false);

    expect(() => tick(broken, demandConfig)).toThrow(/필수 필드 tournament가 없다/);
  });

  it('명시적 null(대회 없음)은 정상이다 — 누락과 구분된다', () => {
    const state = run(createInitialState(DEFAULT_CONFIG), 50, DEFAULT_CONFIG);
    expect(state.tournament).toBeNull();
    const restored = deserialize(serialize(state), DEFAULT_CONFIG);
    expect(restored.tournament).toBeNull();
    expect(serialize(restored)).toBe(serialize(state));
    expect(() => tick(restored, DEFAULT_CONFIG)).not.toThrow();
  });
});

describe('정상 상태의 저장 복원은 그대로 유지된다', () => {
  it('대회 없음 / 긴급 없음', () => {
    const state = run(createInitialState(DEFAULT_CONFIG), 300, DEFAULT_CONFIG);
    const restored = deserialize(serialize(state), DEFAULT_CONFIG);
    expect(serialize(restored)).toBe(serialize(state));
    expect(serialize(run(restored, 100, DEFAULT_CONFIG))).toBe(
      serialize(run(state, 100, DEFAULT_CONFIG)),
    );
  });

  it('활성 대회 예약', () => {
    const state = reservedState(demandConfig);
    const restored = deserialize(serialize(state), demandConfig);
    expect(serialize(restored)).toBe(serialize(state));
    expect(restored.tournament!.id).toBe(state.tournament!.id);
    expect(restored.venue.lockedCash).toBe(state.venue.lockedCash);
    expect(serialize(run(restored, 400, demandConfig))).toBe(
      serialize(run(state, 400, demandConfig)),
    );
  });

  it('활성 긴급 운영', () => {
    const state = emergencyState(noDemand);
    const restored = deserialize(serialize(state), noDemand);
    expect(serialize(restored)).toBe(serialize(state));
    expect(restored.emergency!.id).toBe(state.emergency!.id);
    expect(restored.emergency!.phase).toBe(state.emergency!.phase);
    expect(serialize(run(restored, 200, noDemand))).toBe(serialize(run(state, 200, noDemand)));
  });
});

describe('지원하는 과거 버전 마이그레이션은 유지된다', () => {
  const LEGACY = 'economy-0.1+adopt-v1';

  /** 과거 버전 저장본. 그 버전에 실제로 없던 필드만 제거한다. */
  function asLegacy(state: GameState, saveVersion: number): string {
    const raw = JSON.parse(serialize(state)) as Record<string, unknown>;
    raw['saveVersion'] = saveVersion;
    raw['rulesVersion'] = LEGACY;
    const rec = raw['records'] as Record<string, unknown>;

    // v4에서 추가된 필드
    delete rec['totalEmergencySupportUnits'];
    delete rec['emergencyMinutes'];
    delete rec['nextEmergencySeq'];
    if (saveVersion <= 2) {
      // v3에서 추가된 필드
      delete rec['totalTournamentRevenueUnits'];
      delete rec['completedTournaments'];
    }
    if (saveVersion <= 1) {
      // v2에서 추가된 필드
      delete rec['nextTournamentSeq'];
    }
    // tournament/remodel/emergency는 어느 버전에서도 빠진 적이 없다
    return JSON.stringify(raw);
  }

  for (const version of [1, 2, 3]) {
    it(`v${version} -> v4 마이그레이션이 통과한다`, () => {
      const state = run(createInitialState(DEFAULT_CONFIG), 300, DEFAULT_CONFIG);
      const migrated = deserialize(asLegacy(state, version), DEFAULT_CONFIG);

      expect(migrated.saveVersion).toBe(4);
      expect(migrated.tournament).toBeNull();
      expect(migrated.emergency).toBeNull();
      expect(migrated.records.nextTournamentSeq).toBe(1);
      expect(migrated.records.totalEmergencySupportUnits).toBe(0);
      // 자산·누계 보존
      expect(migrated.venue.cash).toBe(state.venue.cash);
      expect(migrated.records.completedGuests).toBe(state.records.completedGuests);
    });

    it(`v${version} 저장본에서 필수 필드가 빠지면 마이그레이션 전에 거절한다`, () => {
      const state = run(createInitialState(DEFAULT_CONFIG), 100, DEFAULT_CONFIG);
      for (const field of REQUIRED) {
        const raw = JSON.parse(asLegacy(state, version)) as Record<string, unknown>;
        delete raw[field];
        expect(() => deserialize(JSON.stringify(raw), DEFAULT_CONFIG)).toThrow(
          new RegExp(`필수 필드 ${field}가 없다`),
        );
      }
    });
  }

  it('마이그레이션이 누락된 필수 필드를 null로 메우지 않는다', () => {
    // v1 경로에서도 tournament 누락은 복구되지 않는다.
    const state = run(createInitialState(DEFAULT_CONFIG), 100, DEFAULT_CONFIG);
    const raw = JSON.parse(asLegacy(state, 1)) as Record<string, unknown>;
    delete raw['tournament'];

    expect(() => deserialize(JSON.stringify(raw), DEFAULT_CONFIG)).toThrow(
      /필수 필드 tournament가 없다/,
    );
  });
});
