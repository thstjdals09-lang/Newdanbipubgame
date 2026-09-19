/**
 * 중규모 대회 (작업 C-2) 인수 테스트. Progression P15.
 *
 * 실제 엔진 동작을 검사한다. 기대값을 프로덕션 코드에 심어 통과시키지 않는다.
 *
 * 두 가지를 전제로 삼지 않는다.
 *   - 참가자 32명. 참가자 수는 예약 시점의 수요에서 계산되는 **결과**다.
 *     15 / 16 / 17 / 24 / 32명을 각각 만든다.
 *   - 준비비 5,960G·대회 순익 1,720G. 이는 32명일 때의 조건부 값이다.
 *     기대 금액은 기존 계산 함수(tournamentPrepCostUnits)와 config 수치에서 파생한다.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, gold, milli } from '../src/config/economy.js';
import type { EconomyConfig } from '../src/config/economy.js';
import { tournamentPrepCostUnits } from '../src/engine/cash.js';
import { applyCommand, validateCommand } from '../src/engine/commands.js';
import { minuteCosts } from '../src/engine/costs.js';
import { availableCash, demandPerHourMilli } from '../src/engine/derive.js';
import {
  forecast,
  forecastSmallTournament,
  forecastTournament,
} from '../src/engine/forecast.js';
import { planRemodel } from '../src/engine/remodel.js';
import { deserialize, serialize } from '../src/engine/state.js';
import { TOURNAMENT_SPECIALIST_REWARD_ID, tick } from '../src/engine/tick.js';
import {
  MID_TOURNAMENT_UNLOCK_ID,
  planSmallTournament,
  planTournament,
  requiredOperatingReserveUnits,
} from '../src/engine/tournament.js';
import type {
  Command,
  EngineEvent,
  GameState,
  TournamentCompletionRecord,
} from '../src/engine/types.js';
import { G, fixedDemandConfig, labState, recurringUnits, run, withConfig } from './helpers.js';

const MID = DEFAULT_CONFIG.tournament.mid;
const FOUR = ['T1', 'T2', 'T3', 'T4'] as const;
const RESERVE_MID: Command = { type: 'reserveMidTournament', tableIds: [...FOUR] };

const demand20 = fixedDemandConfig(20);

/** 수요를 milli 단위로 직접 고정한 설정 (경계값 확인용) */
const demandMilli = (m: number): EconomyConfig => withConfig({ fixedDemandMilliPerHour: m });

/**
 * 2단계 매장.
 *
 * 단계만 조립하고 해금은 직접 넣지 않는다. 1틱을 돌려 **엔진이 상태에서 판정해**
 * 부여하게 한다. 리모델링을 실제로 거친 경로는 아래 M02가 따로 검증한다.
 */
function stage2State(
  config: EconomyConfig,
  opts: { tables?: number; dealers?: number; cashGold?: number; warmup?: number } = {},
): GameState {
  const state = labState(
    { tables: opts.tables ?? 8, dealers: opts.dealers ?? 8, cashGold: opts.cashGold ?? 200_000 },
    config,
  );
  state.venue.stage = 2;
  state.venue.awarenessMilli = milli(50);
  return run(state, opts.warmup ?? 1, config);
}

/** 대회가 끝날 때까지 진행하고 이벤트를 모은다 */
function runUntilCompleted(start: GameState, config: EconomyConfig, limit = 2000) {
  let cur = start;
  const events: EngineEvent[] = [];
  for (let i = 0; i < limit; i += 1) {
    const r = tick(cur, config);
    cur = r.state;
    events.push(...r.events);
    if (r.events.some((e) => e.type === 'tournamentCompleted')) {
      return { state: cur, events };
    }
  }
  throw new Error('대회가 끝나지 않았다');
}

const lastRecord = (s: GameState): TournamentCompletionRecord => {
  const rec = s.records.completedTournaments[s.records.completedTournaments.length - 1];
  if (!rec) throw new Error('완료 기록이 없다');
  return rec;
};

/* ------------------------------------------------------------------ */
/* 해금                                                                 */
/* ------------------------------------------------------------------ */

describe('M01~M04 해금과 실행 가능 여부', () => {
  it('M01. 1단계에서는 해금되지 않았고 TOURNAMENT_LOCKED로 거절한다', () => {
    const state = run(labState({ tables: 6, dealers: 6, cashGold: 200_000 }, demand20), 50, demand20);
    expect(state.venue.stage).toBe(1);
    expect(state.unlocks.some((u) => u.id === MID_TOURNAMENT_UNLOCK_ID)).toBe(false);

    const before = serialize(state);
    const r = validateCommand(state, RESERVE_MID, demand20);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('TOURNAMENT_LOCKED');
    expect(r.detail).toMatch(/2단계/);
    expect(serialize(state)).toBe(before);
  });

  it('M02. 실제 리모델링을 거치면 다음 분에 정확히 한 번 해금된다', () => {
    const config = demand20;
    const state = labState({ tables: 6, dealers: 6, cashGold: 200_000 }, config);
    state.venue.awarenessMilli = milli(50);
    state.records.completedTournaments = [1, 2].map((i) => ({
      id: `TN${i}`,
      scale: 'small' as const,
      participants: 16,
      gameDay: i - 1,
      startedAtMinute: i * 100,
      completedAtMinute: i * 100 + 240,
      prepCostUnits: gold(1880),
      entryFeeUnits: gold(2880),
      awarenessGainedMilli: milli(12),
      tableIds: ['T1', 'T2'],
      dealerIds: ['D1', 'D2'],
    }));
    // 개최권 사용 기록은 넣지 않는다. 넣으면 같은 게임일의 예약이 그 이유로 막혀
    // 해금 여부를 확인할 수 없다.

    let cur = run(state, 30, config);
    applyCommand(cur, { type: 'requestRemodel' }, config, []);
    let completedAt = -1;
    for (let i = 0; i < 1000 && completedAt < 0; i += 1) {
      const r = tick(cur, config);
      cur = r.state;
      if (r.events.some((e) => e.type === 'remodelCompleted')) completedAt = cur.time.minute;
    }
    expect(completedAt).toBeGreaterThan(0);
    expect(cur.venue.stage).toBe(2);

    // 해금 판정(9단계 앞쪽)은 전환(9단계 마지막)보다 먼저이므로 다음 분에 부여된다.
    const next = tick(cur, config);
    expect(
      next.events.filter((e) => e.type === 'unlockGranted' && e.id === MID_TOURNAMENT_UNLOCK_ID),
    ).toHaveLength(1);

    const later = run(next.state, 500, config);
    expect(later.unlocks.filter((u) => u.id === MID_TOURNAMENT_UNLOCK_ID)).toHaveLength(1);

    // 그리고 실제로 예약할 수 있다
    expect(validateCommand(next.state, RESERVE_MID, config)).toEqual({ ok: true });
  });

  it('M03. 해금 기록만 있고 단계가 1이면 규모 가용성 검사가 막는다 (방어 경로)', () => {
    const state = run(labState({ tables: 6, dealers: 6, cashGold: 200_000 }, demand20), 5, demand20);
    state.unlocks.push({ id: MID_TOURNAMENT_UNLOCK_ID, grantedAtMinute: state.time.minute });
    expect(validateCommand(state, RESERVE_MID, demand20).reason).toBe(
      'TOURNAMENT_SCALE_UNAVAILABLE',
    );
  });

  it('M04. 해금됐어도 자원이 모자라면 부족한 것을 알려 준다 (Progression §4)', () => {
    const config = demand20;
    // 테이블 4개 중 딜러는 3명뿐이다
    const state = stage2State(config, { tables: 4, dealers: 3 });
    expect(state.unlocks.some((u) => u.id === MID_TOURNAMENT_UNLOCK_ID)).toBe(true);

    const noDealer = validateCommand(state, RESERVE_MID, config);
    expect(noDealer.reason).toBe('TOURNAMENT_TABLE_NOT_OPERATING'); // T4는 딜러가 없어 미운영
    expect(noDealer.detail).toMatch(/T4/);

    const three = validateCommand(
      state,
      { type: 'reserveMidTournament', tableIds: ['T1', 'T2', 'T3'] },
      config,
    );
    expect(three.reason).toBe('TOURNAMENT_TABLE_COUNT');
    expect(three.detail).toMatch(/4개/);

    const dup = validateCommand(
      state,
      { type: 'reserveMidTournament', tableIds: ['T1', 'T2', 'T3', 'T3'] },
      config,
    );
    expect(dup.reason).toBe('TOURNAMENT_TABLE_DUPLICATE');
  });

  it('소규모 대회는 2단계에서도 그대로 열 수 있고 테이블 2개를 요구한다', () => {
    const config = demand20;
    const state = stage2State(config);
    // 2단계 실험 상태에는 소규모 해금 조건(테이블 3개·인지도 10)도 성립한다
    expect(planSmallTournament(state, ['T1', 'T2'], config).result.ok).toBe(true);
    expect(planSmallTournament(state, [...FOUR], config).result.reason).toBe(
      'TOURNAMENT_TABLE_COUNT',
    );
    // 래퍼와 일반 함수는 같은 결과를 낸다
    expect(planSmallTournament(state, ['T1', 'T2'], config)).toEqual(
      planTournament(state, 'small', ['T1', 'T2'], config),
    );
  });
});

/* ------------------------------------------------------------------ */
/* 참가자 수 — 전제가 아니라 결과                                        */
/* ------------------------------------------------------------------ */

describe('M05~M07 참가자 수는 예약 시점 수요에서 나온다', () => {
  it('M05. min(32, floor(D x 3))의 D는 현재 시간당 방문 수요다', () => {
    for (const [demandPerHour, expected] of [
      [6, 18],
      [8, 24],
      [10, 30],
      [11, 32], // 33 -> 상한 32
      [20, 32],
    ] as const) {
      const config = fixedDemandConfig(demandPerHour);
      const state = stage2State(config);
      expect(demandPerHourMilli(state, config)).toBe(milli(demandPerHour));

      const { result, plan } = planTournament(state, 'mid', [...FOUR], config);
      expect(result.ok).toBe(true);
      expect(plan!.participants).toBe(expected);
      expect(plan!.participants).toBe(
        Math.min(MID.maxParticipants, Math.floor(demandPerHour * MID.demandMultiplier)),
      );
    }
  });

  it('M06. 최소 16명 경계: 16명이면 통과, 15명이면 거절하고 상태를 바꾸지 않는다', () => {
    // D x 3 = 16.002 -> 16명
    const pass = demandMilli(5334);
    const okState = stage2State(pass);
    const ok = planTournament(okState, 'mid', [...FOUR], pass);
    expect(ok.result.ok).toBe(true);
    expect(ok.plan!.participants).toBe(MID.minParticipants);

    // D x 3 = 15.999 -> 15명
    const fail = demandMilli(5333);
    const state = stage2State(fail);
    const before = serialize(state);
    const r = validateCommand(state, RESERVE_MID, fail);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('TOURNAMENT_PARTICIPANTS_TOO_FEW');
    expect(r.detail).toMatch(/15명/);
    expect(r.detail).toMatch(/16명/);

    // 거절은 아무것도 바꾸지 않는다: 잠금·점유·개최권 모두 그대로
    expect(serialize(state)).toBe(before);
    expect(state.venue.lockedCash).toBe(0);
    expect(state.tournament).toBeNull();
    expect(state.records.usedTournamentDays).toEqual([]);

    // tick에 넣어도 거절 이벤트만 남고 예약은 생기지 않는다
    const ticked = tick(state, fail, [RESERVE_MID]);
    expect(ticked.state.tournament).toBeNull();
    expect(ticked.events.some((e) => e.type === 'tournamentReserved')).toBe(false);
  });

  it('M07. 자연 수요에서는 단계·인지도·만족도가 참가자 수를 정한다', () => {
    const config = DEFAULT_CONFIG; // 고정 수요 없음

    // 인지도 50: D = 6 x 6 x (0.75 + 0.5 x S/100)
    const high = stage2State(config);
    const highPlan = planTournament(high, 'mid', [...FOUR], config);
    expect(highPlan.result.ok).toBe(true);
    expect(highPlan.plan!.participants).toBe(32);

    // 인지도 0·만족도 40: D = 6 x 1 x 0.95 = 5.7 -> floor(17.1) = 17명
    const low = labState({ tables: 8, dealers: 8, cashGold: 200_000 }, config);
    low.venue.stage = 2;
    low.venue.awarenessMilli = 0;
    low.venue.satisfactionMilli = milli(40);
    low.unlocks.push({ id: MID_TOURNAMENT_UNLOCK_ID, grantedAtMinute: 0 });
    expect(demandPerHourMilli(low, config)).toBe(5700);
    const lowPlan = planTournament(low, 'mid', [...FOUR], config);
    expect(lowPlan.result.ok).toBe(true);
    expect(lowPlan.plan!.participants).toBe(17);
  });

  it('참가자 수는 예약 때 확정되고 이후 수요가 변해도 바뀌지 않는다', () => {
    const config = DEFAULT_CONFIG;
    const low = labState({ tables: 8, dealers: 8, cashGold: 200_000 }, config);
    low.venue.stage = 2;
    low.venue.awarenessMilli = 0;
    low.venue.satisfactionMilli = milli(40);
    const state = run(low, 1, config);

    applyCommand(state, RESERVE_MID, config, []);
    const reserved = state.tournament!.participants;
    const demandAtReservation = demandPerHourMilli(state, config);

    const { state: done } = runUntilCompleted(state, config);
    // 그 사이 인지도·만족도가 올라 수요는 달라졌다
    expect(demandPerHourMilli(done, config)).not.toBe(demandAtReservation);
    expect(lastRecord(done).participants).toBe(reserved);
  });
});

/* ------------------------------------------------------------------ */
/* 손익 — 참가자 수별로 일관되게                                          */
/* ------------------------------------------------------------------ */

describe('M08~M09 준비비·참가비·순익', () => {
  const cases: ReadonlyArray<readonly [string, EconomyConfig, number]> = [
    ['16명 (최소)', demandMilli(5334), 16],
    ['24명', fixedDemandConfig(8), 24],
    ['32명 (상한)', fixedDemandConfig(20), 32],
  ];

  for (const [label, config, participants] of cases) {
    it(`M08. ${label}: 잠금·지출·수입·순익이 같은 참가자 수로 맞물린다`, () => {
      const state = stage2State(config, { warmup: 150 });
      const prep = tournamentPrepCostUnits(MID, participants);
      const entry = gold(MID.entryFeeGold * participants);

      // 기대값의 출처를 고정한다: config 수치에서 직접 계산한 값과 기존 함수가 같다
      expect(prep).toBe(
        gold(
          (MID.prizePerParticipantGold + MID.opCostPerParticipantGold) * participants +
            MID.fixedHostingGold,
        ),
      );

      const before = {
        cash: state.venue.cash,
        revenue: state.records.totalRevenueUnits,
        tournamentRevenue: state.records.totalTournamentRevenueUnits,
        oneOff: state.records.totalOneOffUnits,
        recurring: recurringUnits(state),
        support: state.records.totalEmergencySupportUnits,
        done: state.records.tournamentsDone,
      };

      // 예약: 잠기기만 하고 빠져나가지 않는다
      applyCommand(state, RESERVE_MID, config, []);
      expect(state.tournament!.scale).toBe('mid');
      expect(state.tournament!.participants).toBe(participants);
      expect(state.tournament!.prepCostUnits).toBe(prep);
      expect(state.venue.lockedCash).toBe(prep);
      expect(state.venue.cash).toBe(before.cash);
      expect(state.records.totalOneOffUnits).toBe(before.oneOff);

      const { state: done, events } = runUntilCompleted(state, config);

      // 완료 기록
      const rec = lastRecord(done);
      expect(rec.scale).toBe('mid');
      expect(rec.participants).toBe(participants);
      expect(rec.prepCostUnits).toBe(prep);
      expect(rec.entryFeeUnits).toBe(entry);

      // 누계 계정
      expect(done.venue.lockedCash).toBe(0);
      expect(done.records.totalOneOffUnits - before.oneOff).toBe(prep);
      expect(done.records.totalTournamentRevenueUnits - before.tournamentRevenue).toBe(entry);
      expect(done.records.tournamentsDone).toBe(before.done + 1);

      // 장부: 준비비 1건, 참가비 1건
      const prepEntries = done.ledger.filter((l) => l.purpose === `tournament:${rec.id}:prep`);
      const feeEntries = done.ledger.filter((l) => l.purpose === `tournament:${rec.id}:entryFee`);
      expect(prepEntries).toHaveLength(1);
      expect(prepEntries[0]!.amountUnits).toBe(-prep);
      expect(feeEntries).toHaveLength(1);
      expect(feeEntries[0]!.amountUnits).toBe(entry);

      // 이벤트도 같은 금액을 말한다
      const completed = events.find((e) => e.type === 'tournamentCompleted');
      expect(completed).toMatchObject({ prepCostUnits: prep, entryFeeUnits: entry });

      // 대회 자체 순익 = 참가비 - 준비비 = (240 - 130) x n - 1800
      const net = entry - prep;
      expect(G(net)).toBe(
        (MID.entryFeeGold - MID.prizePerParticipantGold - MID.opCostPerParticipantGold) *
          participants -
          MID.fixedHostingGold,
      );

      // 현금 변화는 기록된 수입·지출과 정확히 맞는다 (참가비는 일반 매출에 섞이지 않는다)
      const reconciled =
        done.records.totalRevenueUnits -
        before.revenue +
        (done.records.totalTournamentRevenueUnits - before.tournamentRevenue) +
        (done.records.totalEmergencySupportUnits - before.support) -
        (recurringUnits(done) - before.recurring) -
        (done.records.totalOneOffUnits - before.oneOff);
      expect(done.venue.cash - before.cash).toBe(reconciled);
      // 일반 매출 항등식은 그대로다
      expect(done.records.totalRevenueUnits).toBe(done.records.completedGuests * gold(200));
    });
  }

  it('M09. 조건부 값: 32명이면 준비비 5,960G·순익 +1,720G, 16명이면 순익이 -40G다', () => {
    const at = (n: number) => ({
      prep: G(tournamentPrepCostUnits(MID, n)),
      net: G(gold(MID.entryFeeGold * n) - tournamentPrepCostUnits(MID, n)),
    });
    expect(at(32)).toEqual({ prep: 5960, net: 1720 });
    expect(at(24)).toEqual({ prep: 4920, net: 840 });
    expect(at(17)).toEqual({ prep: 4010, net: 70 });
    // 최소 인원에서는 대회 자체만으로도 적자다. 현행 수치의 결과이며 여기서 고치지 않는다.
    expect(at(16)).toEqual({ prep: 3880, net: -40 });
  });

  it('운영 예비금: 준비비 + 예비금과 같으면 통과, 1 unit 모자라면 거절한다 (R10)', () => {
    const config = demand20;
    const state = stage2State(config);
    const prep = tournamentPrepCostUnits(MID, 32);
    const reserve = requiredOperatingReserveUnits(state, config);
    expect(reserve).toBe(minuteCosts(state, config).total * 60 * 4);

    state.venue.cash = prep + reserve;
    expect(validateCommand(state, RESERVE_MID, config).ok).toBe(true);

    state.venue.cash = prep + reserve - 1;
    expect(validateCommand(state, RESERVE_MID, config).reason).toBe(
      'TOURNAMENT_RESERVE_SHORTFALL',
    );

    state.venue.cash = prep - 1;
    expect(validateCommand(state, RESERVE_MID, config).reason).toBe('INSUFFICIENT_CASH');
  });
});

/* ------------------------------------------------------------------ */
/* 예약 -> 정리 -> 개최 -> 정산                                          */
/* ------------------------------------------------------------------ */

describe('M10~M14 진행과 정산 (P15)', () => {
  it('M10. 테이블 4개를 점유하고 기존 세션을 정상 완료시킨 뒤 시작한다', () => {
    const config = demand20;
    const state = stage2State(config, { warmup: 150 });
    const held = state.sessions.filter((s) => !s.settled && FOUR.includes(s.tableId as never));
    expect(held.length).toBeGreaterThan(0);
    const plannedEnds = new Map(held.map((s) => [s.id, s.endsAtMinute]));
    const dealersBefore = FOUR.map((id) => state.tables.find((t) => t.id === id)!.dealerId);

    const r0 = tick(state, config, [RESERVE_MID]);
    let cur = r0.state;
    expect(cur.tournament!.phase).toBe('RESERVED_DRAINING');
    expect(cur.tournament!.tableIds).toEqual([...FOUR]);
    expect(cur.tournament!.dealerIds).toEqual(dealersBefore);
    for (const id of FOUR) {
      expect(cur.tables.find((t) => t.id === id)!.status).toBe('tournamentHeld');
    }

    const settledAt = new Map<string, number>();
    let seatedOnHeld = 0;
    let readyAt = -1;
    let startedAt = -1;
    let endsAt = -1;
    for (let i = 0; i < 400 && startedAt < 0; i += 1) {
      const r = tick(cur, config);
      cur = r.state;
      for (const e of r.events) {
        if (e.type === 'sessionCompleted' && plannedEnds.has(e.sessionId)) {
          settledAt.set(e.sessionId, cur.time.minute);
        }
        if (e.type === 'guestSeated' && FOUR.includes(e.tableId as never)) seatedOnHeld += 1;
        if (e.type === 'tournamentReady') readyAt = cur.time.minute;
        if (e.type === 'tournamentStarted') {
          startedAt = e.startedAtMinute;
          endsAt = e.endsAtMinute;
        }
      }
    }

    // 점유 테이블에는 새 손님이 앉지 않았다
    expect(seatedOnHeld).toBe(0);
    // 기존 세션은 예정된 시각 그대로 끝났다
    for (const [id, planned] of plannedEnds) expect(settledAt.get(id)).toBe(planned);
    // 준비 완료 다음 분에 시작한다 (B-1에서 확정한 타이밍)
    expect(readyAt).toBeGreaterThan(0);
    expect(startedAt).toBe(readyAt + 1);
    // 전문 딜러가 예약되지 않았으므로 기본 360분
    expect(endsAt - startedAt).toBe(MID.baseDurationMinutes);
    expect(cur.tournament!.phase).toBe('IN_PROGRESS');
  });

  it('M11. 종료 시 테이블 4개가 같은 딜러로 일반 영업에 복귀하고 인지도가 오른다', () => {
    const config = demand20;
    const state = stage2State(config, { warmup: 150 });
    const dealersBefore = FOUR.map((id) => state.tables.find((t) => t.id === id)!.dealerId);
    applyCommand(state, RESERVE_MID, config, []);

    const { state: done, events } = runUntilCompleted(state, config);

    expect(done.tournament).toBeNull();
    FOUR.forEach((id, i) => {
      const table = done.tables.find((t) => t.id === id)!;
      expect(table.status).toBe('operating');
      expect(table.dealerId).toBe(dealersBefore[i]);
    });
    const completed = events.find((e) => e.type === 'tournamentCompleted');
    expect(completed).toMatchObject({ awarenessGainedMilli: MID.awarenessRewardMilli });
    expect(MID.awarenessRewardMilli).toBe(milli(18));

    // 복귀한 테이블이 다시 손님을 받는다
    const later = run(done, 60, config);
    expect(later.sessions.some((s) => FOUR.includes(s.tableId as never))).toBe(true);
  });

  it('인지도 보상은 상한 100을 넘지 않는다 (R4)', () => {
    const config = demand20;
    const state = stage2State(config);
    state.venue.awarenessMilli = milli(90);
    applyCommand(state, RESERVE_MID, config, []);
    const { state: done } = runUntilCompleted(state, config);
    expect(done.venue.awarenessMilli).toBe(milli(100));
    expect(lastRecord(done).awarenessGainedMilli).toBeLessThan(MID.awarenessRewardMilli);
  });

  it('M12. 예약된 전문 딜러가 있으면 288분, 보유만 하면 360분이다 (R3)', () => {
    const config = demand20;
    const duration = (mutate: (s: GameState) => void): number => {
      const state = stage2State(config);
      mutate(state);
      applyCommand(state, RESERVE_MID, config, []);
      const { events } = runUntilCompleted(state, config);
      const started = events.find((e) => e.type === 'tournamentStarted');
      if (!started || started.type !== 'tournamentStarted') throw new Error('시작 이벤트 없음');
      return started.endsAtMinute - started.startedAtMinute;
    };

    // 직원 유형은 읽기 전용이므로 레코드를 교체해 전문 딜러로 만든다
    const makeSpecialists = (s: GameState, ids: readonly string[]): void => {
      s.staff = s.staff.map((x) => (ids.includes(x.id) ? { ...x, type: 'tournament' as const } : x));
      expect(s.staff.filter((x) => x.type === 'tournament').map((x) => x.id)).toEqual([...ids]);
    };

    // 예약 테이블(T2)의 담당이 전문 딜러
    expect(duration((s) => makeSpecialists(s, ['D2']))).toBe(Math.ceil(360 / 1.25));

    // 전문 딜러가 있지만 예약하지 않은 테이블(T8) 담당
    expect(duration((s) => makeSpecialists(s, ['D8']))).toBe(360);

    // 여러 명이어도 중첩하지 않는다
    expect(duration((s) => makeSpecialists(s, ['D1', 'D2', 'D3']))).toBe(288);
  });

  it('M13. 한 번만 정산된다. 계속 돌려도 기록·장부·실적이 늘지 않는다', () => {
    const config = demand20;
    const state = stage2State(config);
    applyCommand(state, RESERVE_MID, config, []);
    const { state: done } = runUntilCompleted(state, config);
    const id = lastRecord(done).id;
    const snapshot = {
      oneOff: done.records.totalOneOffUnits,
      fee: done.records.totalTournamentRevenueUnits,
      doneCount: done.records.tournamentsDone,
      awareness: done.venue.awarenessMilli,
    };

    // 일반 세션의 인지도 보상이 섞이지 않도록 수요를 끊고 돌린다
    const later = run(done, 600, fixedDemandConfig(0));
    expect(later.records.completedTournaments.filter((c) => c.id === id)).toHaveLength(1);
    expect(later.ledger.filter((l) => l.purpose.startsWith(`tournament:${id}:`))).toHaveLength(2);
    expect(later.records.totalOneOffUnits).toBe(snapshot.oneOff);
    expect(later.records.totalTournamentRevenueUnits).toBe(snapshot.fee);
    expect(later.records.tournamentsDone).toBe(snapshot.doneCount);
  });

  it('M14. 개최권은 규모와 무관하게 게임일당 하나다', () => {
    const config = demand20;

    // 중규모를 먼저 열면 같은 날 소규모를 열 수 없다
    const a = stage2State(config);
    applyCommand(a, RESERVE_MID, config, []);
    const { state: afterMid } = runUntilCompleted(a, config);
    expect(afterMid.time.minute).toBeLessThan(1440);
    expect(
      validateCommand(afterMid, { type: 'reserveSmallTournament', tableIds: ['T1', 'T2'] }, config)
        .reason,
    ).toBe('TOURNAMENT_DAY_USED');
    expect(validateCommand(afterMid, RESERVE_MID, config).reason).toBe('TOURNAMENT_DAY_USED');

    // 소규모를 먼저 열면 같은 날 중규모를 열 수 없다
    const b = stage2State(config);
    applyCommand(b, { type: 'reserveSmallTournament', tableIds: ['T1', 'T2'] }, config, []);
    const { state: afterSmall } = runUntilCompleted(b, config);
    expect(afterSmall.time.minute).toBeLessThan(1440);
    expect(validateCommand(afterSmall, RESERVE_MID, config).reason).toBe('TOURNAMENT_DAY_USED');

    // 다음 게임일에는 다시 열 수 있다
    const nextDay = run(afterSmall, 1440 - afterSmall.time.minute, config);
    expect(validateCommand(nextDay, RESERVE_MID, config).ok).toBe(true);

    // 진행 중에는 두 번째 대회를 예약할 수 없다
    const c = stage2State(config);
    applyCommand(c, RESERVE_MID, config, []);
    expect(
      validateCommand(c, { type: 'reserveSmallTournament', tableIds: ['T5', 'T6'] }, config).reason,
    ).toBe('TOURNAMENT_ALREADY_RESERVED');
  });
});

/* ------------------------------------------------------------------ */
/* 기존 시스템 보존                                                      */
/* ------------------------------------------------------------------ */

describe('M15~M18 기존 동작 보존', () => {
  it('M15. 중규모 완료는 대회 전문 딜러 보상을 주지 않는다 (조건은 소규모 1회)', () => {
    const config = demand20;
    const state = stage2State(config);
    const staffBefore = state.staff.map((s) => s.id);
    applyCommand(state, RESERVE_MID, config, []);
    const { state: done } = runUntilCompleted(state, config);
    const later = run(done, 10, config);

    expect(later.records.completedTournaments).toHaveLength(1);
    expect(later.records.completedTournaments.every((c) => c.scale === 'mid')).toBe(true);
    expect(later.unlocks.some((u) => u.id === TOURNAMENT_SPECIALIST_REWARD_ID)).toBe(false);
    expect(later.staff.filter((s) => s.type === 'tournament')).toHaveLength(0);
    // 대회 전후로 직원 명부가 그대로다 — 중규모 완료가 새 직원을 만들지 않는다
    expect(later.staff.map((s) => s.id)).toEqual(staffBefore);
  });

  it('M16. 리모델링 조건은 여전히 소규모 완료만 센다', () => {
    const config = demand20;
    const state = labState({ tables: 6, dealers: 3, cashGold: 200_000 }, config);
    state.venue.awarenessMilli = milli(50);
    state.records.completedTournaments = [1, 2].map((i) => ({
      id: `TN${i}`,
      scale: 'mid' as const,
      participants: 32,
      gameDay: i - 1,
      startedAtMinute: i * 100,
      completedAtMinute: i * 100 + 360,
      prepCostUnits: gold(5960),
      entryFeeUnits: gold(7680),
      awarenessGainedMilli: milli(18),
      tableIds: [...FOUR],
      dealerIds: ['D1', 'D2', 'D3', 'D4'],
    }));
    expect(planRemodel(state, config).result.reason).toBe('REMODEL_TOURNAMENTS_REQUIRED');
  });

  it('M17. 대회 중 긴급 운영이 발동해도 예약 자원 4개를 건드리지 않고 한 번만 정산한다', () => {
    const config = demand20;
    const state = stage2State(config, { tables: 5, dealers: 5, warmup: 30 });
    applyCommand(state, RESERVE_MID, config, []);
    const prep = state.tournament!.prepCostUnits;
    const dealers = [...state.tournament!.dealerIds];

    // 잠긴 준비비는 그대로 두고 자기 자금만 말린다
    state.venue.cash = state.venue.lockedCash + minuteCosts(state, config).total - 1;
    expect(availableCash(state)).toBeLessThan(minuteCosts(state, config).total);

    let cur = state;
    let sawEmergency = false;
    let completed = 0;
    for (let i = 0; i < 1200 && completed === 0; i += 1) {
      const r = tick(cur, config);
      cur = r.state;
      if (cur.emergency !== null) sawEmergency = true;
      completed += r.events.filter((e) => e.type === 'tournamentCompleted').length;

      if (cur.tournament !== null) {
        // 대회가 살아 있는 동안 예약 테이블·딜러는 그대로다
        FOUR.forEach((id, idx) => {
          const table = cur.tables.find((t) => t.id === id)!;
          expect(table.status).toBe('tournamentHeld');
          expect(table.dealerId).toBe(dealers[idx]);
        });
        for (const id of dealers) {
          const dealer = cur.staff.find((s) => s.id === id)!;
          expect(dealer.duty).toBe('working');
        }
        // 잠긴 준비비는 운영비로 새지 않는다
        expect(cur.venue.lockedCash).toBe(prep);
      }
    }

    expect(sawEmergency).toBe(true);
    expect(completed).toBe(1);
    expect(cur.venue.lockedCash).toBe(0);
    expect(cur.records.totalEmergencySupportUnits).toBeGreaterThan(0);
    const rec = lastRecord(cur);
    expect(cur.ledger.filter((l) => l.purpose === `tournament:${rec.id}:prep`)).toHaveLength(1);
    // 지원금은 참가비 수입에 섞이지 않는다
    expect(cur.records.totalTournamentRevenueUnits).toBe(rec.entryFeeUnits);
    expect(cur.venue.cash).toBeGreaterThanOrEqual(0);
  });

  it('M18. 긴급 운영 중·공사 중에는 기존 관문이 그대로 막는다', () => {
    const config = demand20;

    const em = stage2State(config, { tables: 5, dealers: 5 });
    em.venue.cash = minuteCosts(em, config).total - 1;
    const inEmergency = tick(em, config).state;
    expect(inEmergency.emergency).not.toBeNull();
    expect(validateCommand(inEmergency, RESERVE_MID, config).reason).toBe('EMERGENCY_ACTIVE');

    // 공사 상태는 2단계에서 자연 발생하지 않는다. 관문 순서만 방어적으로 확인한다.
    const rm = stage2State(config);
    (rm as { remodel: unknown }).remodel = { id: 'RM9', phase: 'PREPARING' };
    expect(validateCommand(rm, RESERVE_MID, config).reason).toBe('REMODEL_ACTIVE');
    expect(planTournament(rm, 'mid', [...FOUR], config).result.reason).toBe('REMODEL_IN_PROGRESS');
  });
});

/* ------------------------------------------------------------------ */
/* 저장·결정성                                                          */
/* ------------------------------------------------------------------ */

describe('M19~M21 저장·복원·결정성', () => {
  it('M19. 정리·준비·진행 각 단계에서 저장 복원해도 무중단 진행과 같다', () => {
    const config = demand20;
    const start = stage2State(config, { warmup: 150 });
    applyCommand(start, RESERVE_MID, config, []);
    const reference = serialize(run(start, 900, config));

    const seen = new Set<string>();
    let cur = start;
    for (let minute = 0; minute < 900; minute += 1) {
      const phase = cur.tournament?.phase ?? 'NONE';
      if (!seen.has(phase)) {
        seen.add(phase);
        const restored = deserialize(serialize(cur), config);
        expect(serialize(restored)).toBe(serialize(cur));
        expect(serialize(run(restored, 900 - minute, config))).toBe(reference);
      }
      cur = tick(cur, config).state;
    }
    expect([...seen].sort()).toEqual(
      ['IN_PROGRESS', 'NONE', 'RESERVED_DRAINING', 'RESERVED_READY'].sort(),
    );
    expect(serialize(cur)).toBe(reference);
  });

  it('M20. 시간 분할 결과가 같고 입력 상태가 불변이다', () => {
    const config = demand20;
    const start = stage2State(config, { warmup: 150 });
    applyCommand(start, RESERVE_MID, config, []);
    const frozen = serialize(start);

    const whole = run(start, 800, config);
    let split = start;
    for (const chunk of [1, 119, 2, 358, 320]) split = run(split, chunk, config);

    expect(serialize(split)).toBe(serialize(whole));
    expect(serialize(start)).toBe(frozen);
  });

  it('M21. C-2 이전에 2단계가 된 저장본은 복원 후 다음 틱에 한 번만 해금된다', () => {
    const config = demand20;
    const current = stage2State(config, { warmup: 60 });
    expect(current.unlocks.some((u) => u.id === MID_TOURNAMENT_UNLOCK_ID)).toBe(true);

    // C-2 이전 엔진이 남긴 저장본: 같은 saveVersion·rulesVersion, 해금 기록만 없다
    const raw = JSON.parse(serialize(current)) as {
      saveVersion: number;
      rulesVersion: string;
      unlocks: { id: string }[];
    };
    raw.unlocks = raw.unlocks.filter((u) => u.id !== MID_TOURNAMENT_UNLOCK_ID);
    expect(raw.saveVersion).toBe(5);
    expect(raw.rulesVersion).toBe('economy-0.3+c1-remodel');

    // 마이그레이션 없이 그대로 읽힌다
    const restored = deserialize(JSON.stringify(raw), config);
    expect(restored.saveVersion).toBe(5);
    expect(restored.unlocks.some((u) => u.id === MID_TOURNAMENT_UNLOCK_ID)).toBe(false);
    expect(validateCommand(restored, RESERVE_MID, config).reason).toBe('TOURNAMENT_LOCKED');

    // 다음 틱에 상태(단계)에서 판정해 부여한다
    const r = tick(restored, config);
    expect(
      r.events.filter((e) => e.type === 'unlockGranted' && e.id === MID_TOURNAMENT_UNLOCK_ID),
    ).toHaveLength(1);
    expect(validateCommand(r.state, RESERVE_MID, config).ok).toBe(true);

    const later = run(r.state, 300, config);
    expect(later.unlocks.filter((u) => u.id === MID_TOURNAMENT_UNLOCK_ID)).toHaveLength(1);

    // 해금 기록 말고는 아무것도 달라지지 않는다
    const strip = (s: GameState): string => {
      const copy = JSON.parse(serialize(s)) as { unlocks: { id: string }[] };
      copy.unlocks = copy.unlocks.filter((u) => u.id !== MID_TOURNAMENT_UNLOCK_ID);
      return JSON.stringify(copy);
    };
    expect(strip(run(restored, 301, config))).toBe(strip(run(current, 301, config)));
  });

  it('1단계 저장본은 복원해도 해금되지 않는다', () => {
    const config = demand20;
    const state = run(labState({ tables: 6, dealers: 6, cashGold: 200_000 }, config), 100, config);
    const later = run(deserialize(serialize(state), config), 200, config);
    expect(later.venue.stage).toBe(1);
    expect(later.unlocks.some((u) => u.id === MID_TOURNAMENT_UNLOCK_ID)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 예상치                                                               */
/* ------------------------------------------------------------------ */

describe('M22~M25 예상치 연결', () => {
  it('M22. forecastTournament(mid)는 실제 예약·정산이 만든 값을 그대로 보고한다', () => {
    for (const [config, participants] of [
      [fixedDemandConfig(8), 24],
      [fixedDemandConfig(20), 32],
    ] as const) {
      const state = stage2State(config, { warmup: 150 });
      const frozen = serialize(state);

      const f = forecastTournament(state, 'mid', [...FOUR], config);
      expect(serialize(state)).toBe(frozen); // 원본 불변
      if (!f.supported) throw new Error(`미지원: ${f.code} ${f.detail}`);

      const prep = tournamentPrepCostUnits(MID, participants);
      const entry = gold(MID.entryFeeGold * participants);
      expect(f.scale).toBe('mid');
      expect(f.participants).toBe(participants);
      expect(f.tableIds).toEqual([...FOUR]);
      expect(f.prepCostUnits).toBe(prep);

      // 예약 직후: 총현금은 그대로, 가용 현금만 준비비만큼 준다
      expect(f.cashAfterReservation.cashUnits).toBe(f.cashBeforeReservation.cashUnits);
      expect(f.cashAfterReservation.lockedCashUnits).toBe(prep);
      expect(
        f.cashBeforeReservation.availableCashUnits - f.cashAfterReservation.availableCashUnits,
      ).toBe(prep);

      expect(f.delta.tournamentRevenueUnits).toBe(entry);
      expect(f.delta.oneOffExpenseUnits).toBe(prep);
      expect(f.tournament.endLockedCashUnits).toBe(0);
      expect(f.awarenessGainedMilli).toBe(MID.awarenessRewardMilli);
    }
  });

  it('M23. 예측과 실제가 같은 규칙을 쓴다: 실제로 예약해 같은 분만큼 돌린 결과와 일치한다', () => {
    const config = demand20;
    const state = stage2State(config, { warmup: 150 });
    const f = forecastTournament(state, 'mid', [...FOUR], config);
    if (!f.supported) throw new Error(f.detail);

    const actualStart = deserialize(serialize(state), config);
    applyCommand(actualStart, RESERVE_MID, config, []);
    const actual = run(actualStart, f.horizonMinutes, config);
    const baseline = run(state, f.horizonMinutes, config);

    expect(f.tournament.endCashUnits).toBe(actual.venue.cash);
    expect(f.baseline.endCashUnits).toBe(baseline.venue.cash);
    expect(f.delta.endCashUnits).toBe(actual.venue.cash - baseline.venue.cash);
    expect(f.completedAtMinute).toBe(lastRecord(actual).completedAtMinute);
    // 일반 영업 기회비용은 "일반 매출 차이"로 따로 보인다. 참가비와 섞이지 않는다.
    expect(f.delta.ordinaryRevenueUnits).toBe(
      actual.records.totalRevenueUnits - baseline.records.totalRevenueUnits,
    );
  });

  it('M24. 자격 미달은 거절 사유를, 지평 부족은 미완료를 그대로 돌려준다', () => {
    const few = demandMilli(5333);
    const rejected = forecastTournament(stage2State(few), 'mid', [...FOUR], few);
    expect(rejected).toMatchObject({
      supported: false,
      code: 'COMMAND_REJECTED',
      reason: 'TOURNAMENT_PARTICIPANTS_TOO_FEW',
    });

    const locked = forecastTournament(
      run(labState({ tables: 6, dealers: 6, cashGold: 200_000 }, demand20), 5, demand20),
      'mid',
      [...FOUR],
      demand20,
    );
    expect(locked).toMatchObject({ code: 'COMMAND_REJECTED', reason: 'TOURNAMENT_LOCKED' });

    const short = forecastTournament(stage2State(demand20), 'mid', [...FOUR], demand20, 300);
    expect(short).toMatchObject({ supported: false, code: 'TOURNAMENT_INCOMPLETE_AT_HORIZON' });
  });

  it('M25. 일반 forecast()는 중규모 예약 명령을 계산하지 않고, 소규모 래퍼는 그대로다', () => {
    const config = demand20;
    const state = stage2State(config, { warmup: 60 });

    const general = forecast(state, RESERVE_MID, config);
    expect(general.supported).toBe(false);
    if (general.supported) throw new Error('unreachable');
    expect(general.code).toBe('TOURNAMENT_NOT_IMPLEMENTED');
    expect(general.detail).toMatch(/forecastTournament/);

    // 자격 미달 명령은 미지원이 아니라 거절이다
    const bad = forecast(state, { type: 'reserveMidTournament', tableIds: ['T1'] }, config);
    expect(bad).toMatchObject({ code: 'COMMAND_REJECTED', reason: 'TOURNAMENT_TABLE_COUNT' });

    // 기존 공개 이름은 같은 결과를 낸다
    expect(forecastSmallTournament(state, ['T1', 'T2'], config)).toEqual(
      forecastTournament(state, 'small', ['T1', 'T2'], config),
    );
  });
});
