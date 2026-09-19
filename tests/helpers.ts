import { DEFAULT_CONFIG, gold, milli } from '../src/config/economy.js';
import type { EconomyConfig, StaffType } from '../src/config/economy.js';
import { createInitialState } from '../src/engine/state.js';
import { tick } from '../src/engine/tick.js';
import type { GameState, TableState, StaffState } from '../src/engine/types.js';

export const G = (units: number): number => units / 60;

/** 설정 일부만 바꾼 사본 */
export function withConfig(patch: Partial<EconomyConfig>): EconomyConfig {
  return { ...DEFAULT_CONFIG, ...patch };
}

/**
 * 04 §1의 실험 조건을 그대로 만든다.
 * "수요와 인지도 변화를 고정해 처리 능력의 효과만 분리"한 구성이다.
 */
export function fixedDemandConfig(demandPerHour: number): EconomyConfig {
  return withConfig({ fixedDemandMilliPerHour: milli(demandPerHour) });
}

export interface LabSetup {
  readonly tables: number;
  readonly dealers: number;
  readonly dealerType?: StaffType;
  readonly serviceStaff?: number;
  readonly cashGold?: number;
}

/**
 * 실험용 상태를 직접 조립한다.
 * 구매 경로를 거치지 않으므로 초기 자금·가격표의 영향을 받지 않는다.
 * 04 §1의 실험도 같은 방식으로 조건만 고정한 것이다.
 */
export function labState(setup: LabSetup, config: EconomyConfig = DEFAULT_CONFIG): GameState {
  const state = createInitialState(config);
  const dealerType = setup.dealerType ?? 'normal';

  const tables: TableState[] = [];
  for (let i = 1; i <= setup.tables; i += 1) {
    tables.push({
      id: `T${i}`,
      spotIndex: i,
      floor: i >= 7 ? 2 : 1,
      status: 'idle',
      dealerId: null,
    });
  }

  const staff: StaffState[] = [];
  for (let i = 1; i <= setup.dealers; i += 1) {
    const table = tables[i - 1];
    if (!table) throw new Error('딜러가 테이블보다 많다');
    const id = `D${i}`;
    staff.push({ id, type: dealerType, duty: 'working', assignedTableId: table.id });
    table.dealerId = id;
    table.status = 'operating';
  }

  for (let i = 1; i <= (setup.serviceStaff ?? 0); i += 1) {
    staff.push({ id: `SV${i}`, type: 'service', duty: 'working', assignedTableId: null });
  }

  state.tables = tables;
  state.staff = staff;
  state.venue.cash = gold(setup.cashGold ?? 10_000_000);
  state.records.nextTableSeq = setup.tables + 1;
  state.records.nextStaffSeq = setup.dealers + (setup.serviceStaff ?? 0) + 1;
  return state;
}

export function run(state: GameState, minutes: number, config: EconomyConfig): GameState {
  let current = state;
  for (let i = 0; i < minutes; i += 1) {
    current = tick(current, config).state;
  }
  return current;
}

/** 반복 비용 누계 */
export function recurringUnits(state: GameState): number {
  const r = state.records;
  return r.totalWageUnits + r.totalFacilityUnits + r.totalVenueCostUnits;
}

/** 영업 순이익 누계 = 매출 - 반복 비용 */
export function operatingNetUnits(state: GameState): number {
  return state.records.totalRevenueUnits - recurringUnits(state);
}
