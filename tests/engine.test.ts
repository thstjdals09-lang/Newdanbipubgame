/**
 * 엔진 핵심 규칙 검증.
 *
 * 사용자 지정 확인 항목:
 *   - 세션별 매출이 정확히 한 번 정산됨
 *   - 처리 능력이 실제 운영 가능한 테이블에서 파생됨
 *   - 잘못된 행동 요청은 원본 상태를 변경하지 않음
 *   - 저장 복원 후 결과가 동일함
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, gold, milli } from '../src/config/economy.js';
import { lock, release, settleLocked, spend, tournamentPrepCostUnits, tournamentNetUnits, expectedParticipants } from '../src/engine/cash.js';
import { applyCommand, validateCommand } from '../src/engine/commands.js';
import {
  availableCash,
  operatingTableCount,
  theoreticalCapacityMilli,
} from '../src/engine/derive.js';
import { cloneState, createInitialState, deserialize, serialize } from '../src/engine/state.js';
import { tick } from '../src/engine/tick.js';
import type { Command, EngineEvent } from '../src/engine/types.js';
import { G, fixedDemandConfig, labState, run } from './helpers.js';

describe('세션 매출의 단일 정산', () => {
  it('완료 이용객 수 x 200G 가 정확히 누적 매출과 같다', () => {
    const config = fixedDemandConfig(20);
    const end = run(labState({ tables: 5, dealers: 4 }, config), 48 * 60, config);
    expect(end.records.totalRevenueUnits).toBe(end.records.completedGuests * gold(200));
  });

  it('같은 세션 ID의 sessionCompleted 이벤트가 두 번 나오지 않는다', () => {
    const config = fixedDemandConfig(20);
    let state = labState({ tables: 3, dealers: 3 }, config);
    const seen = new Set<string>();

    for (let m = 0; m < 24 * 60; m += 1) {
      const result = tick(state, config);
      state = result.state;
      for (const e of result.events) {
        if (e.type !== 'sessionCompleted') continue;
        expect(seen.has(e.sessionId)).toBe(false);
        seen.add(e.sessionId);
      }
    }
    expect(seen.size).toBe(state.records.completedGuests);
  });

  it('정산된 세션은 활성 목록에 남지 않는다', () => {
    const config = fixedDemandConfig(20);
    const end = run(labState({ tables: 2, dealers: 2 }, config), 12 * 60, config);
    expect(end.sessions.every((s) => !s.settled)).toBe(true);
  });

  it('세션의 금액과 시간은 착석 시점에 확정되고 이후 딜러가 바뀌어도 변하지 않는다', () => {
    const config = DEFAULT_CONFIG;
    let state = run(createInitialState(config), 20, config);
    const session = state.sessions[0];
    expect(session).toBeDefined();
    const fixedEnd = session?.endsAtMinute;
    const fixedRevenue = session?.revenueUnits;

    // 숙련 딜러를 고용해 교체를 예약한다
    state.staff.push({ id: 'SK', type: 'skilled', duty: 'standby', assignedTableId: null });
    const cmd: Command = { type: 'assignDealer', tableId: 'T1', staffId: 'SK' };
    expect(validateCommand(state, cmd, config).ok).toBe(true);
    const events: EngineEvent[] = [];
    applyCommand(state, cmd, config, events);

    state = run(state, 10, config);
    const still = state.sessions.find((s) => s.id === session?.id);
    expect(still?.endsAtMinute).toBe(fixedEnd);
    expect(still?.revenueUnits).toBe(fixedRevenue);
  });
});

describe('처리 능력은 실제 운영 테이블에서 파생된다 (P02)', () => {
  it('딜러 없는 테이블은 처리 능력에 포함되지 않는다', () => {
    const config = DEFAULT_CONFIG;
    const state = labState({ tables: 5, dealers: 3 }, config);
    expect(operatingTableCount(state)).toBe(3);
    expect(theoreticalCapacityMilli(state, config)).toBe(3 * 4000);
  });

  it('테이블만 사면 능력이 늘지 않는다 — 딜러를 붙여야 는다', () => {
    const config = DEFAULT_CONFIG;
    const state = labState({ tables: 1, dealers: 1, cashGold: 100_000 }, config);
    const before = theoreticalCapacityMilli(state, config);

    const events: EngineEvent[] = [];
    applyCommand(state, { type: 'buyTable' }, config, events);
    // 대기 중인 일반 딜러가 없으므로 자동 배치되지 않는다
    expect(theoreticalCapacityMilli(state, config)).toBe(before);
    expect(state.tables[1]?.status).toBe('idle');

    applyCommand(state, { type: 'hireDealer' }, config, events);
    const newTable = state.tables[1];
    const newStaff = state.staff[state.staff.length - 1];
    applyCommand(
      state,
      { type: 'assignDealer', tableId: newTable!.id, staffId: newStaff!.id },
      config,
      events,
    );
    expect(theoreticalCapacityMilli(state, config)).toBe(before + 4000);
  });

  it('숙련 딜러 테이블은 4.8명/시간이다', () => {
    const config = DEFAULT_CONFIG;
    const state = labState({ tables: 1, dealers: 1, dealerType: 'skilled' }, config);
    expect(theoreticalCapacityMilli(state, config)).toBe(4800);
  });

  it('미운영 테이블은 시설비를 내지 않는다', () => {
    const config = fixedDemandConfig(0);
    const three = run(labState({ tables: 5, dealers: 3 }, config), 60, config);
    const five = run(labState({ tables: 5, dealers: 5 }, config), 60, config);
    // 3개 운영 vs 5개 운영 -> 시설비 차이는 2개분
    expect(G(five.records.totalFacilityUnits - three.records.totalFacilityUnits)).toBe(2 * 30);
  });
});

describe('잘못된 행동 요청은 상태를 변경하지 않는다 (P09)', () => {
  const config = DEFAULT_CONFIG;

  // 각 명령이 실제로 거절되는 상태를 만든다. cashGold를 지정하면 그 값으로 낮춘다.
  const rejected: { command: Command; cashGold?: number }[] = [
    { command: { type: 'buyTable' }, cashGold: 100 },
    { command: { type: 'hireDealer' }, cashGold: 100 },
    { command: { type: 'hireServiceStaff' }, cashGold: 100 },
    { command: { type: 'assignDealer', tableId: 'T999', staffId: 'S1' } },
    { command: { type: 'unassignDealer', tableId: 'T999' } },
    { command: { type: 'setServiceWorking', staffId: 'S1' } }, // S1은 딜러
    { command: { type: 'upgradeAmenity' } }, // 테이블 2개 미설치
    { command: { type: 'buyPromotion' }, cashGold: 100 },
  ];

  for (const { command, cashGold } of rejected) {
    it(`${command.type} 거절 시 상태가 그대로다`, () => {
      const state = run(createInitialState(config), 200, config);
      if (cashGold !== undefined) state.venue.cash = gold(cashGold);
      expect(validateCommand(state, command, config).ok).toBe(false);
      const snapshot = serialize(state);
      const result = tick(cloneState(state), config, [command]);

      const rejectedEvents = result.events.filter((e) => e.type === 'commandRejected');
      expect(rejectedEvents.length).toBe(1);

      // 원본은 손대지 않았다
      expect(serialize(state)).toBe(snapshot);

      // 거절된 명령은 틱의 나머지 처리에도 영향을 주지 않는다
      const clean = tick(cloneState(state), config, []);
      expect(serialize(result.state)).toBe(serialize(clean.state));
    });
  }

  it('거절 사유가 구체적으로 나온다', () => {
    const state = createInitialState(config);
    expect(validateCommand(state, { type: 'buyTable' }, config).reason).toBe('INSUFFICIENT_CASH');
    expect(validateCommand(state, { type: 'upgradeAmenity' }, config).reason).toBe('AMENITY_LOCKED');
    expect(
      validateCommand(state, { type: 'assignDealer', tableId: 'T1', staffId: 'S1' }, config).reason,
    ).toBe('TABLE_ALREADY_HAS_DEALER');
  });

  it('딜러를 두 테이블에 동시에 배치할 수 없다', () => {
    const state = labState({ tables: 2, dealers: 1 }, DEFAULT_CONFIG);
    const r = validateCommand(
      state,
      { type: 'assignDealer', tableId: 'T2', staffId: 'D1' },
      DEFAULT_CONFIG,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('STAFF_ALREADY_ASSIGNED');
  });

  it('테이블 구매는 다른 테이블의 딜러를 빼오지 않는다 (채택 R9)', () => {
    const config = DEFAULT_CONFIG;
    const state = labState({ tables: 1, dealers: 1, cashGold: 100_000 }, config);
    const events: EngineEvent[] = [];
    applyCommand(state, { type: 'buyTable' }, config, events);

    expect(state.tables[0]?.dealerId).toBe('D1'); // 기존 테이블은 그대로
    expect(state.tables[1]?.dealerId).toBe(null); // 새 테이블은 딜러 없음
    expect(state.tables[1]?.status).toBe('idle');
  });

  it('대기 중인 일반 딜러가 있으면 새 테이블에 자동 배치된다 (Progression §7)', () => {
    const config = DEFAULT_CONFIG;
    const state = labState({ tables: 1, dealers: 1, cashGold: 100_000 }, config);
    state.staff.push({ id: 'SPARE', type: 'normal', duty: 'standby', assignedTableId: null });

    const events: EngineEvent[] = [];
    applyCommand(state, { type: 'buyTable' }, config, events);
    expect(state.tables[1]?.dealerId).toBe('SPARE');
    expect(state.tables[1]?.status).toBe('operating');
  });

  it('숙련 딜러는 자동 배치되지 않는다 — 명시적 편성만', () => {
    const config = DEFAULT_CONFIG;
    const state = labState({ tables: 1, dealers: 1, cashGold: 100_000 }, config);
    state.staff.push({ id: 'SK', type: 'skilled', duty: 'standby', assignedTableId: null });

    const events: EngineEvent[] = [];
    applyCommand(state, { type: 'buyTable' }, config, events);
    expect(state.tables[1]?.dealerId).toBe(null);
  });
});

describe('딜러 교체는 기존 세션이 끝난 뒤 반영된다 (Economy §5)', () => {
  const config = DEFAULT_CONFIG;

  it('교체 예약 중에는 신규 착석을 받지 않고, 세션이 끝나면 반영된다', () => {
    let state = run(createInitialState(config), 20, config);
    expect(state.sessions.length).toBeGreaterThan(0);

    state.staff.push({ id: 'SK', type: 'skilled', duty: 'standby', assignedTableId: null });
    const events: EngineEvent[] = [];
    applyCommand(state, { type: 'assignDealer', tableId: 'T1', staffId: 'SK' }, config, events);

    expect(state.tables[0]?.status).toBe('closing');
    expect(state.tables[0]?.pendingDealerId).toBe('SK');
    expect(state.tables[0]?.dealerId).toBe('S1'); // 아직 그대로

    // 기존 세션이 모두 끝날 때까지 진행
    state = run(state, 200, config);
    expect(state.tables[0]?.dealerId).toBe('SK');
    expect(state.tables[0]?.status).toBe('operating');
    expect(state.staff.find((s) => s.id === 'S1')?.duty).toBe('standby');
  });

  it('closing 상태에서도 시설비는 계속 낸다', () => {
    // 진행 중 세션이 있어야 closing이 유지된다.
    // 세션이 없으면 9단계가 즉시 전환을 끝내므로 closing이 남지 않는다.
    let state = run(createInitialState(config), 20, config);
    expect(state.sessions.length).toBeGreaterThan(0);

    state.staff.push({ id: 'SK', type: 'skilled', duty: 'standby', assignedTableId: null });
    applyCommand(state, { type: 'assignDealer', tableId: 'T1', staffId: 'SK' }, config, []);
    expect(state.tables[0]?.status).toBe('closing');

    const before = state.records.totalFacilityUnits;
    state = run(state, 60, config); // 분 20 -> 80. 세션은 분 135까지 남아 있다.
    expect(state.tables[0]?.status).toBe('closing'); // 여전히 정리 중
    expect(G(state.records.totalFacilityUnits - before)).toBe(30); // 30G/시간 x 1시간
  });

  it('대기 중 직원은 급여가 없다', () => {
    const config2 = fixedDemandConfig(0);
    let state = labState({ tables: 1, dealers: 1 }, config2);
    state.staff.push({ id: 'IDLE', type: 'normal', duty: 'standby', assignedTableId: null });
    state = run(state, 60, config2);
    expect(G(state.records.totalWageUnits)).toBe(80); // 근무 1명분만
  });
});

describe('현금과 잠금 금액 (05 §3)', () => {
  const config = DEFAULT_CONFIG;

  it('사용 가능 현금 = cash - lockedCash', () => {
    const state = createInitialState(config);
    lock(state, gold(200));
    expect(state.venue.cash).toBe(gold(600)); // 예약은 cash를 바꾸지 않는다
    expect(state.venue.lockedCash).toBe(gold(200));
    expect(availableCash(state)).toBe(gold(400));
  });

  it('잠긴 금액은 다른 지출에 쓸 수 없다', () => {
    const state = createInitialState(config);
    lock(state, gold(500));
    expect(() => spend(state, gold(200), 'test')).toThrow(/사용 가능 현금 초과/);
    expect(state.venue.cash).toBe(gold(600)); // 실패해도 그대로
  });

  it('같은 금액을 두 번 잠글 수 없다', () => {
    const state = createInitialState(config);
    lock(state, gold(400));
    expect(() => lock(state, gold(400))).toThrow();
    expect(state.venue.lockedCash).toBe(gold(400));
  });

  it('정산은 cash와 lockedCash를 각각 한 번씩만 줄인다 — 이중 차감 없음', () => {
    const state = createInitialState(config);
    lock(state, gold(300));
    settleLocked(state, gold(300), 'tournament:prep');

    expect(state.venue.cash).toBe(gold(300)); // 600 - 300
    expect(state.venue.lockedCash).toBe(0);
    expect(availableCash(state)).toBe(gold(300));
    expect(state.records.totalOneOffUnits).toBe(gold(300));
    expect(state.ledger).toHaveLength(1);
  });

  it('잠긴 금액보다 많이 정산하거나 해제할 수 없다', () => {
    const state = createInitialState(config);
    lock(state, gold(100));
    expect(() => settleLocked(state, gold(200), 'x')).toThrow();
    expect(() => release(state, gold(200))).toThrow();
    expect(state.venue.lockedCash).toBe(gold(100));
  });

  it('해제는 cash를 건드리지 않는다', () => {
    const state = createInitialState(config);
    lock(state, gold(250));
    release(state, gold(250));
    expect(state.venue.cash).toBe(gold(600));
    expect(state.venue.lockedCash).toBe(0);
  });

  it('잠금이 있는 상태에서도 명령 검증이 사용 가능 현금을 쓴다', () => {
    const state = labState({ tables: 1, dealers: 1, cashGold: 1500 }, config);
    expect(validateCommand(state, { type: 'buyTable' }, config).ok).toBe(true);
    lock(state, gold(400)); // 가용 1,100G < 1,200G
    expect(validateCommand(state, { type: 'buyTable' }, config).reason).toBe('INSUFFICIENT_CASH');
  });
});

describe('대회 준비비 — 채택 R2 (계산만, 진행은 작업 B)', () => {
  const small = DEFAULT_CONFIG.tournament.small;
  const mid = DEFAULT_CONFIG.tournament.mid;

  it('준비비 = 상금 + 참가자별 운영비 + 고정 개최비', () => {
    // 소규모 16명: 16x60 + 16x20 + 600 = 1,880G
    expect(G(tournamentPrepCostUnits(small, 16))).toBe(1880);
    // 중규모 32명: 32x100 + 32x30 + 1,800 = 5,960G
    expect(G(tournamentPrepCostUnits(mid, 32))).toBe(5960);
  });

  it('참가비는 준비비에 포함하지 않는다', () => {
    // 순이익 = 참가비 - 준비비
    expect(G(tournamentNetUnits(small, 16))).toBe(16 * 180 - 1880);
    expect(G(tournamentNetUnits(small, 16))).toBe(1000);
    expect(G(tournamentNetUnits(mid, 32))).toBe(32 * 240 - 5960);
    expect(G(tournamentNetUnits(mid, 32))).toBe(1720);
  });

  it('예상 참가자 = min(max, floor(D x multiplier))', () => {
    expect(expectedParticipants(milli(4.025), small)).toBe(8);
    expect(expectedParticipants(milli(8.05), small)).toBe(16);
    expect(expectedParticipants(milli(100), small)).toBe(16); // 상한
    expect(expectedParticipants(milli(6.9), mid)).toBe(20);
  });
});

describe('저장 복원 (05 §4-5)', () => {
  const config = DEFAULT_CONFIG;

  it('중단 없이 진행한 결과와 저장 복원 후 진행한 결과가 같다', () => {
    const straight = run(createInitialState(config), 2000, config);

    let broken = run(createInitialState(config), 777, config);
    broken = deserialize(serialize(broken), config);
    broken = run(broken, 1223, config);

    expect(serialize(broken)).toBe(serialize(straight));
  });

  it('여러 번 저장·복원해도 같다', () => {
    const straight = run(createInitialState(config), 1500, config);

    let broken = createInitialState(config);
    for (const chunk of [100, 250, 50, 700, 400]) {
      broken = run(broken, chunk, config);
      broken = deserialize(serialize(broken), config);
    }
    expect(serialize(broken)).toBe(serialize(straight));
  });

  it('나머지 값들이 실제로 직렬화된다', () => {
    const state = run(createInitialState(config), 137, config);
    const json = JSON.parse(serialize(state));
    expect(json.time.arrivalCarry).toBe(state.time.arrivalCarry);
    expect(json.venue.satisfactionRemainder).toBe(state.venue.satisfactionRemainder);
    expect(json.window.sumArrivals).toBe(state.window.sumArrivals);
    expect(json.window.arrivals).toHaveLength(360);
  });

  it('이탈률 윈도우 합계가 조작되면 복원이 거부된다', () => {
    const state = run(createInitialState(config), 500, config);
    const tampered = JSON.parse(serialize(state));
    tampered.window.sumArrivals += 1;
    expect(() => deserialize(JSON.stringify(tampered), config)).toThrow(/윈도우 합계 불일치/);
  });

  it('저장 스키마 버전이 다르면 거부된다', () => {
    const state = createInitialState(config);
    const tampered = JSON.parse(serialize(state));
    tampered.saveVersion = 99;
    expect(() => deserialize(JSON.stringify(tampered), config)).toThrow(/저장 스키마 버전/);
  });

  it('룰 버전이 다르면 거부된다', () => {
    const state = createInitialState(config);
    const tampered = JSON.parse(serialize(state));
    tampered.rulesVersion = 'economy-0.2';
    expect(() => deserialize(JSON.stringify(tampered), config)).toThrow(/룰 버전 불일치/);
  });
});

describe('이탈률 윈도우 — 채택 R5', () => {
  it('방문 기록이 없으면 이탈률이 0이다', () => {
    const config = fixedDemandConfig(0);
    const state = run(labState({ tables: 1, dealers: 1 }, config), 500, config);
    expect(state.window.sumArrivals).toBe(0);
    // 목표 만족도가 이탈 페널티 없이 계산된다
    expect(state.venue.satisfactionMilli).toBe(milli(80));
  });

  it('윈도우는 최근 360분만 집계한다', () => {
    const config = fixedDemandConfig(20);
    const state = run(labState({ tables: 1, dealers: 1 }, config), 1000, config);
    const sum = state.window.arrivals.reduce((a, b) => a + b, 0);
    expect(state.window.sumArrivals).toBe(sum);
    // 20명/시간 x 6시간 = 120명
    expect(state.window.sumArrivals).toBe(120);
  });

  it('수요가 능력을 크게 넘으면 이탈이 발생하고 만족도가 내려간다', () => {
    const config = fixedDemandConfig(40);
    const end = run(labState({ tables: 1, dealers: 1 }, config), 48 * 60, config);
    expect(end.window.sumAbandons).toBeGreaterThan(0);
    expect(end.venue.satisfactionMilli).toBeLessThan(milli(80));
  });
});

describe('지역 홍보 — 채택 R6', () => {
  it('기본값이 on이다', () => {
    expect(DEFAULT_CONFIG.promotion.enabled).toBe(true);
  });

  it('구매하면 인지도가 +5 오르고 재사용 대기가 걸린다', () => {
    const config = DEFAULT_CONFIG;
    const state = labState({ tables: 1, dealers: 1, cashGold: 5000 }, config);
    const events: EngineEvent[] = [];
    applyCommand(state, { type: 'buyPromotion' }, config, events);

    expect(state.venue.awarenessMilli).toBe(milli(5));
    expect(state.records.promoReadyMinute).toBe(360);
    expect(validateCommand(state, { type: 'buyPromotion' }, config).reason).toBe(
      'PROMOTION_ON_COOLDOWN',
    );
  });

  it('인지도 40 이상이면 구매할 수 없다', () => {
    const config = DEFAULT_CONFIG;
    const state = labState({ tables: 1, dealers: 1, cashGold: 5000 }, config);
    state.venue.awarenessMilli = milli(40);
    expect(validateCommand(state, { type: 'buyPromotion' }, config).reason).toBe(
      'PROMOTION_AWARENESS_TOO_HIGH',
    );
  });

  it('off로 두면 거절되며, 엔진은 그대로 동작한다', () => {
    const config = { ...DEFAULT_CONFIG, promotion: { ...DEFAULT_CONFIG.promotion, enabled: false } };
    const state = labState({ tables: 1, dealers: 1, cashGold: 5000 }, config);
    expect(validateCommand(state, { type: 'buyPromotion' }, config).reason).toBe(
      'PROMOTION_DISABLED',
    );
    // off여도 48시간 진행에 문제가 없다 (성장 속도는 보장하지 않는다)
    const end = run(state, 48 * 60, config);
    expect(end.records.completedGuests).toBeGreaterThan(0);
  });
});

describe('인지도 상한 — 채택 R4', () => {
  it('세션 보상으로 100을 넘지 않는다', () => {
    const config = fixedDemandConfig(80);
    const state = labState({ tables: 18, dealers: 18 }, config);
    state.venue.awarenessMilli = milli(99.99);
    const end = run(state, 600, config);
    expect(end.venue.awarenessMilli).toBe(milli(100));
  });

  it('홍보로 100을 넘지 않는다', () => {
    const config = { ...DEFAULT_CONFIG, promotion: { ...DEFAULT_CONFIG.promotion, maxAwarenessMilli: milli(1000) } };
    const state = labState({ tables: 1, dealers: 1, cashGold: 5000 }, config);
    state.venue.awarenessMilli = milli(98);
    const events: EngineEvent[] = [];
    applyCommand(state, { type: 'buyPromotion' }, config, events);
    expect(state.venue.awarenessMilli).toBe(milli(100));
  });
});

describe('해금은 한 번만 부여된다 (Progression §4)', () => {
  it('같은 해금 ID가 두 번 기록되지 않는다', () => {
    const config = DEFAULT_CONFIG;
    const state = labState({ tables: 3, dealers: 3 }, config);
    state.venue.awarenessMilli = milli(10);
    const end = run(state, 600, config);

    const ids = end.unlocks.map((u) => u.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('amenityUpgrade');
    expect(ids).toContain('skilledDealerGrant');
    expect(ids).toContain('smallTournament');
  });

  it('조건을 만족하지 않으면 해금되지 않는다', () => {
    const config = DEFAULT_CONFIG;
    const end = run(createInitialState(config), 600, config);
    expect(end.unlocks.map((u) => u.id)).not.toContain('amenityUpgrade');
  });
});

describe('미구현 상태는 조용히 무시되지 않는다', () => {
  const config = DEFAULT_CONFIG;

  it('tournament 상태가 있으면 tick이 거부한다', () => {
    const state = createInitialState(config);
    (state as { tournament: unknown }).tournament = { id: 'X' };
    expect(() => tick(state, config)).toThrow(/대회 진행은 작업 B/);
  });

  it('remodel 상태가 있으면 tick이 거부한다', () => {
    const state = createInitialState(config);
    (state as { remodel: unknown }).remodel = { id: 'X' };
    expect(() => tick(state, config)).toThrow(/리모델링 전환은 작업 C/);
  });

  it('알 수 없는 긴급 운영 단계는 tick이 거부한다', () => {
    // B-3에서 긴급 운영이 구현되면서 유효한 단계는 지원 대상이 됐다.
    // 정의되지 않은 단계는 여전히 조용히 처리하지 않고 거절한다.
    const state = createInitialState(config);
    (state as { emergency: unknown }).emergency = { active: true };
    expect(() => tick(state, config)).toThrow(/지원하지 않는 긴급 운영 단계/);
  });

  it('자기 자금이 마르면 긴급 축소 운영이 부족액만 지원한다 (B-3)', () => {
    // B-3 이전에는 현금을 음수로 두고 cashNegative 이벤트만 알렸다.
    // 이제 긴급 운영이 구현됐으므로 부족액만 지원하며 계속 진행한다.
    // "조용히 0으로 자르지 않는다"는 원칙은 그대로다 — 지원금을 명시적으로 기록한다.
    const config2 = fixedDemandConfig(0); // 손님 없음 = 비용만 나감
    let state = labState({ tables: 5, dealers: 5, cashGold: 10 }, config2);

    let startedAt = -1;
    const supports: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      const r = tick(state, config2);
      state = r.state;
      for (const e of r.events) {
        if (e.type === 'emergencyStarted' && startedAt < 0) startedAt = state.time.minute;
        if (e.type === 'emergencySupportGranted') supports.push(e.amountUnits);
      }
      expect(state.venue.cash).toBeGreaterThanOrEqual(0); // 음수로 두지 않는다
    }

    // 분당 비용 = 5x80 + 5x30 + 40 = 590 units. 시작 자금 600 units로 1분은 버틴다.
    expect(startedAt).toBe(2);
    expect(supports.length).toBeGreaterThan(0);
    expect(state.records.totalEmergencySupportUnits).toBe(supports.reduce((a, b) => a + b, 0));
    // 지원금은 매출·일회성 지출과 섞이지 않는다
    expect(state.records.totalRevenueUnits).toBe(0);
    expect(state.records.totalOneOffUnits).toBe(0);
  });
});
