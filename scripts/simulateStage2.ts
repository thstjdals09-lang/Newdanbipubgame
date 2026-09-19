/**
 * 2단계 매장 성장 시뮬레이션 (작업 C-2).
 *
 *   npm run simulate
 *
 * 05 §6이 "후속 시뮬레이션 과제"로 남긴 세 가지를 **측정만** 한다.
 *   - 8~18번째 테이블 성장 시간
 *   - 대회의 실제 기회비용
 *   - 리모델링 직후 수요 증가
 *
 * 밸런스 수치를 바꾸지 않는다. 보정값도 없다. 판정은 테스트(npm test)가 하고,
 * 이 스크립트는 사람이 읽을 숫자를 보여 준다. 실제 엔진의 tick / validateCommand /
 * forecastTournament만 쓰며 별도의 근사 계산을 만들지 않는다.
 *
 * **가상 플레이어는 게임 규칙이 아니다.** 04 §2의 자동 투자 정책을 그대로 따른 가정이다.
 *   - 게임 1시간마다 한 번 판단한다.
 *   - 구매 후 4게임시간 운영비를 남긴다.
 *   - 수요가 현재 이론 처리 능력의 85%를 넘으면 딜러를 늘린다.
 *   - 테이블은 돈이 되면 산다. 조건이 되면 홍보·리모델링을 한다.
 *   - 1단계에서는 리모델링 조건(소규모 2회)을 채울 때까지 소규모 대회를 연다.
 *   - 2단계의 대회 정책만 시나리오로 바꾼다: 없음 / 매일 소규모 / 매일 중규모.
 *   - 대회 테이블은 번호가 큰 운영 테이블부터 고른다. 좌석이 앞 번호부터 차므로(R8)
 *     뒤 번호가 가장 덜 찬 테이블이다.
 * 최적 전략도, 사람의 행동 모사도 아니다. 시간표는 실제 플레이 시간의 보장이 아니다.
 */

import { DEFAULT_CONFIG, MONEY_SCALE } from '../src/config/economy.js';
import type { EconomyConfig } from '../src/config/economy.js';
import { validateCommand } from '../src/engine/commands.js';
import { hourlyOperatingCostUnits } from '../src/engine/costs.js';
import {
  availableCash,
  canInstallMoreTables,
  demandPerHourMilli,
  installedTableCount,
  operatingTableCount,
  seatedGuests,
  serviceCapacity,
  tablePriceGold,
  theoreticalCapacityMilli,
} from '../src/engine/derive.js';
import { forecastTournament } from '../src/engine/forecast.js';
import { createInitialState } from '../src/engine/state.js';
import { tick } from '../src/engine/tick.js';
import type { Command, GameState, TournamentScale } from '../src/engine/index.js';

const config: EconomyConfig = DEFAULT_CONFIG;
const G = (units: number): number => units / MONEY_SCALE;
const gold = (g: number): number => g * MONEY_SCALE;
const fmtG = (units: number): string => `${Math.round(G(units)).toLocaleString('en-US')}G`;
const hours = (minute: number): string => (minute / 60).toFixed(1);

type Stage2Policy = 'none' | 'small' | 'mid';

const MAX_MINUTES = 80 * 1440; // 80게임일
const RESERVE_HOURS = 4; // 04 §2: "구매 후 약 4시간 운영비를 남기고"
const DEALER_UPKEEP_PER_HOUR = gold(
  config.staff.normal.wagePerHourGold + config.table.facilityCostPerHourGold,
);

/** 번호가 큰 운영 테이블부터 n개. 일반 딜러가 맡은 테이블만 고른다. */
function pickTournamentTables(state: GameState, n: number): string[] {
  return state.tables
    .filter((t) => t.status === 'operating' && t.dealerId !== null && t.pendingDealerId === undefined)
    .sort((a, b) => b.spotIndex - a.spotIndex)
    .slice(0, n)
    .map((t) => t.id)
    .reverse();
}

function tournamentCommand(state: GameState, scale: TournamentScale): Command {
  const tableIds = pickTournamentTables(state, config.tournament[scale].tables);
  return scale === 'small'
    ? { type: 'reserveSmallTournament', tableIds }
    : { type: 'reserveMidTournament', tableIds };
}

/** 지출 후에도 4게임시간 운영비가 남는가 */
function affordable(state: GameState, costUnits: number, extraHourlyUnits = 0): boolean {
  const reserve = (hourlyOperatingCostUnits(state, config) + extraHourlyUnits) * RESERVE_HOURS;
  return availableCash(state) >= costUnits + reserve;
}

/** 이번 판단에서 실행할 다음 명령 하나. 없으면 null. */
function nextAction(state: GameState, policy: Stage2Policy): Command | null {
  const valid = (c: Command): boolean => validateCommand(state, c, config).ok;

  // 1) 리모델링
  const remodel: Command = { type: 'requestRemodel' };
  if (state.venue.stage === 1 && valid(remodel)) return remodel;

  // 2) 대회
  const smallDone = state.records.completedTournaments.filter((c) => c.scale === 'small').length;
  let scale: TournamentScale | null = null;
  if (state.venue.stage === 1) {
    if (smallDone < config.remodel.requiredSmallTournaments) scale = 'small';
  } else if (policy !== 'none') {
    scale = policy;
  }
  if (scale !== null && state.tournament === null) {
    const c = tournamentCommand(state, scale);
    if (valid(c)) return c;
  }

  // 3) 지역 홍보
  const promo: Command = { type: 'buyPromotion' };
  if (valid(promo) && affordable(state, gold(config.promotion.costGold))) return promo;

  // 4) 서비스 직원: 착석 인원이 수용 기준을 넘으면 고용
  const service: Command = { type: 'hireServiceStaff' };
  if (
    seatedGuests(state) > serviceCapacity(state, config) &&
    valid(service) &&
    affordable(state, gold(config.hire.serviceStaffGold), gold(config.staff.service.wagePerHourGold))
  ) {
    return service;
  }

  // 5) 딜러: 수요가 처리 능력의 85%를 넘고 딜러 없는 테이블이 있으면 채운다
  const pressured =
    demandPerHourMilli(state, config) * 100 > theoreticalCapacityMilli(state, config) * 85;
  const emptyTable = state.tables.find((t) => t.status === 'idle' && t.dealerId === null);
  if (pressured && emptyTable) {
    const standby = state.staff.find(
      (s) => s.type === 'normal' && s.duty === 'standby' && s.assignedTableId === null,
    );
    if (standby) {
      const assign: Command = { type: 'assignDealer', tableId: emptyTable.id, staffId: standby.id };
      if (valid(assign)) return assign;
    }
    const hire: Command = { type: 'hireDealer' };
    if (valid(hire) && affordable(state, gold(config.hire.normalDealerGold), DEALER_UPKEEP_PER_HOUR)) {
      return hire;
    }
  }

  // 6) 테이블: 돈이 되면 산다
  const buy: Command = { type: 'buyTable' };
  if (canInstallMoreTables(state, config) && valid(buy)) {
    const price = gold(tablePriceGold(installedTableCount(state) + 1, config));
    if (affordable(state, price, DEALER_UPKEEP_PER_HOUR)) return buy;
  }

  return null;
}

interface TableMilestone {
  readonly index: number;
  readonly minute: number;
  readonly cashUnits: number;
  readonly awarenessMilli: number;
  readonly satisfactionMilli: number;
  readonly demandMilli: number;
  readonly capacityMilli: number;
}

interface RunResult {
  readonly policy: Stage2Policy;
  readonly end: GameState;
  readonly milestones: TableMilestone[];
  readonly remodelRequestedAt: number;
  readonly remodelCompletedAt: number;
  readonly checkpoints: Map<number, GameState>;
  readonly stage2: { arrivals: number; abandons: number; firstDayArrivals: number; firstDayAbandons: number };
  readonly stoppedBecause: string;
}

function simulate(policy: Stage2Policy, checkpointTables: readonly number[]): RunResult {
  let state = createInitialState(config);
  const milestones: TableMilestone[] = [];
  const checkpoints = new Map<number, GameState>();
  let remodelRequestedAt = -1;
  let remodelCompletedAt = -1;
  const stage2 = { arrivals: 0, abandons: 0, firstDayArrivals: 0, firstDayAbandons: 0 };
  let stoppedBecause = `${MAX_MINUTES / 1440}게임일 상한`;

  const step = (commands: Command[]): void => {
    const before = installedTableCount(state);
    const r = tick(state, config, commands);
    state = r.state;
    for (const e of r.events) {
      if (e.type === 'remodelRequested') remodelRequestedAt = state.time.minute;
      if (e.type === 'remodelCompleted') remodelCompletedAt = state.time.minute;
      if (state.venue.stage === 2) {
        const firstDay = remodelCompletedAt >= 0 && state.time.minute - remodelCompletedAt <= 1440;
        if (e.type === 'guestArrived') {
          stage2.arrivals += 1;
          if (firstDay) stage2.firstDayArrivals += 1;
        }
        if (e.type === 'guestAbandoned') {
          stage2.abandons += 1;
          if (firstDay) stage2.firstDayAbandons += 1;
        }
      }
    }
    if (installedTableCount(state) > before) {
      milestones.push({
        index: installedTableCount(state),
        minute: state.time.minute,
        cashUnits: state.venue.cash,
        awarenessMilli: state.venue.awarenessMilli,
        satisfactionMilli: state.venue.satisfactionMilli,
        demandMilli: demandPerHourMilli(state, config),
        capacityMilli: theoreticalCapacityMilli(state, config),
      });
    }
  };

  while (state.time.minute < MAX_MINUTES) {
    if (state.time.minute % 60 === 0) {
      // 한 번의 판단에서 여러 행동을 할 수 있다. 행동마다 다시 검증한다.
      for (let guard = 0; guard < 8; guard += 1) {
        const action = nextAction(state, policy);
        if (action === null) break;
        step([action]);
      }
      // 같은 게임일에 대회를 열 수 있는 시점의 상태를 기회비용 측정용으로 남긴다.
      const operating = operatingTableCount(state);
      for (const n of checkpointTables) {
        if (
          !checkpoints.has(n) &&
          state.venue.stage === 2 &&
          operating >= n &&
          state.tournament === null &&
          state.emergency === null &&
          validateCommand(state, tournamentCommand(state, 'mid'), config).ok
        ) {
          checkpoints.set(n, state);
        }
      }
    }
    step([]);

    if (
      installedTableCount(state) >= config.table.capByStage[2] &&
      operatingTableCount(state) >= config.table.capByStage[2]
    ) {
      stoppedBecause = '18테이블 모두 운영';
      break;
    }
  }

  return {
    policy,
    end: state,
    milestones,
    remodelRequestedAt,
    remodelCompletedAt,
    checkpoints,
    stage2,
    stoppedBecause,
  };
}

/* ------------------------------------------------------------------ */
/* 출력                                                                 */
/* ------------------------------------------------------------------ */

const line = (c = '-'): void => console.log(c.repeat(108));
const pad = (s: string | number, n: number): string => String(s).padEnd(n);
const lpad = (s: string | number, n: number): string => String(s).padStart(n);

const POLICY_LABEL: Record<Stage2Policy, string> = {
  none: 'A. 2단계 대회 없음',
  small: 'B. 매일 소규모',
  mid: 'C. 매일 중규모',
};

console.log(`\n2단계 성장 시뮬레이션  —  rulesVersion = ${config.rulesVersion}`);
console.log('가상 플레이어(04 §2 정책)의 결과다. 밸런스 수치는 바꾸지 않았다.');
line('=');

const CHECKPOINT_TABLES = [7, 10, 14, 18];
const results = (['none', 'small', 'mid'] as const).map((p) => simulate(p, CHECKPOINT_TABLES));

/* 1. 리모델링까지는 세 시나리오가 같다 */
const base = results[0]!;
console.log('\n[1] 1단계 -> 리모델링 (세 시나리오 공통 경로)');
line();
for (const m of base.milestones.filter((x) => x.index <= 6)) {
  console.log(`  ${lpad(m.index, 2)}번째 테이블   ${lpad(hours(m.minute), 6)}게임시간`);
}
console.log(
  `  리모델링 요청   ${lpad(hours(base.remodelRequestedAt), 6)}게임시간   ` +
    `완료 ${hours(base.remodelCompletedAt)}게임시간`,
);
const same = results.every(
  (r) =>
    r.remodelRequestedAt === base.remodelRequestedAt &&
    r.remodelCompletedAt === base.remodelCompletedAt,
);
console.log(`  세 시나리오의 리모델링 시각 일치: ${same ? '예' : '아니오'}`);

/* 2. 8~18번째 성장 시간 */
console.log('\n[2] 7~18번째 테이블 구매 시각 (게임시간, 괄호는 리모델링 완료 이후 경과)');
line();
console.log(
  `  ${pad('테이블', 8)}${pad('가격', 12)}` + results.map((r) => pad(POLICY_LABEL[r.policy], 28)).join(''),
);
for (let index = 7; index <= 18; index += 1) {
  const cells = results.map((r) => {
    const m = r.milestones.find((x) => x.index === index);
    if (!m) return pad('미도달', 28);
    return pad(`${hours(m.minute)}h (+${hours(m.minute - r.remodelCompletedAt)}h)`, 28);
  });
  console.log(`  ${pad(`${index}번째`, 8)}${pad(fmtG(gold(tablePriceGold(index, config))), 12)}${cells.join('')}`);
}
console.log(
  `  ${pad('종료 사유', 20)}` + results.map((r) => pad(r.stoppedBecause, 28)).join(''),
);

/* 3. 종료 시점 요약 */
console.log('\n[3] 종료 시점 요약');
line();
const row = (label: string, f: (r: RunResult) => string): void =>
  console.log(`  ${pad(label, 26)}` + results.map((r) => pad(f(r), 28)).join(''));
row('경과', (r) => `${hours(r.end.time.minute)}h (${(r.end.time.minute / 1440).toFixed(1)}게임일)`);
row('설치 / 운영 테이블', (r) => `${installedTableCount(r.end)} / ${operatingTableCount(r.end)}`);
row('직원 (딜러 / 서비스)', (r) => {
  const d = r.end.staff.filter((s) => s.type !== 'service').length;
  return `${d} / ${r.end.staff.length - d}`;
});
row('현금', (r) => fmtG(r.end.venue.cash));
row('인지도 / 만족도', (r) =>
  `${(r.end.venue.awarenessMilli / 1000).toFixed(1)} / ${(r.end.venue.satisfactionMilli / 1000).toFixed(1)}`);
row('수요 / 처리 능력 (명/h)', (r) =>
  `${(demandPerHourMilli(r.end, config) / 1000).toFixed(1)} / ${(theoreticalCapacityMilli(r.end, config) / 1000).toFixed(1)}`);
row('일반 매출 누계', (r) => fmtG(r.end.records.totalRevenueUnits));
row('대회 참가비 누계', (r) => fmtG(r.end.records.totalTournamentRevenueUnits));
row('대회 (소 / 중)', (r) => {
  const c = r.end.records.completedTournaments;
  return `${c.filter((x) => x.scale === 'small').length} / ${c.filter((x) => x.scale === 'mid').length}`;
});
row('긴급 운영 (분 / 지원금)', (r) =>
  `${r.end.records.emergencyMinutes} / ${fmtG(r.end.records.totalEmergencySupportUnits)}`);

/* 4. 리모델링 직후 수요 압력 */
console.log('\n[4] 2단계 이탈률 (착석 전 이탈 / 신규 방문)');
line();
row('완료 후 첫 24게임시간', (r) =>
  r.stage2.firstDayArrivals === 0
    ? '-'
    : `${((r.stage2.firstDayAbandons / r.stage2.firstDayArrivals) * 100).toFixed(1)}% ` +
      `(${r.stage2.firstDayAbandons}/${r.stage2.firstDayArrivals})`);
row('2단계 전체', (r) =>
  r.stage2.arrivals === 0
    ? '-'
    : `${((r.stage2.abandons / r.stage2.arrivals) * 100).toFixed(1)}% (${r.stage2.abandons}/${r.stage2.arrivals})`);

/* 5. 대회 기회비용 — 같은 상태에서 "연다 / 안 연다"를 실제 엔진으로 24게임시간 비교 */
console.log('\n[5] 대회 기회비용 측정 (시나리오 A의 상태에서 forecastTournament로 24게임시간 쌍 비교)');
console.log('    대회 순익 = 참가비 - 준비비.  일반 매출 차이 = 대회 때문에 놓친 일반 영업.');
line();
console.log(
  `  ${pad('운영', 6)}${pad('규모', 6)}${lpad('참가자', 6)}${lpad('준비비', 10)}${lpad('참가비', 10)}` +
    `${lpad('대회 순익', 11)}${lpad('일반 매출 차이', 16)}${lpad('반복 비용 차이', 15)}${lpad('현금 차이', 12)}  인지도`,
);
for (const n of CHECKPOINT_TABLES) {
  const at = base.checkpoints.get(n);
  if (!at) {
    console.log(`  ${pad(n, 6)}측정 시점에 도달하지 못함`);
    continue;
  }
  for (const scale of ['small', 'mid'] as const) {
    const f = forecastTournament(at, scale, pickTournamentTables(at, config.tournament[scale].tables), config);
    if (!f.supported) {
      console.log(`  ${pad(n, 6)}${pad(scale, 6)}미지원: ${f.code}${f.reason ? ` (${f.reason})` : ''}`);
      continue;
    }
    const entry = f.delta.tournamentRevenueUnits;
    console.log(
      `  ${pad(operatingTableCount(at), 6)}${pad(scale, 6)}${lpad(f.participants, 6)}` +
        `${lpad(fmtG(f.prepCostUnits), 10)}${lpad(fmtG(entry), 10)}${lpad(fmtG(entry - f.prepCostUnits), 11)}` +
        `${lpad(fmtG(f.delta.ordinaryRevenueUnits), 16)}${lpad(fmtG(f.delta.recurringCostUnits), 15)}` +
        `${lpad(fmtG(f.delta.endCashUnits), 12)}  +${(f.awarenessGainedMilli / 1000).toFixed(1)}`,
    );
  }
}
line('=');
console.log('현금 차이 = 대회 순익 + 일반 매출 차이 - 반복 비용 차이 (+ 긴급 지원금 차이).');
console.log('음수면 그 24게임시간 동안은 대회를 열지 않는 쪽이 현금이 더 많았다는 뜻이다.\n');
