/**
 * 플레이어 명령 (Economy §10-1).
 *
 * 모든 명령은 "검증 -> 적용" 두 단계다. 검증이 실패하면 상태를 전혀 건드리지 않는다
 * (Progression P09 "상태와 자산 변경 없음").
 *
 * 다른 테이블에 배치된 직원을 조용히 빼오는 동작은 넣지 않는다 (채택 R9).
 * buyTable의 자동 배치는 대기(standby) 상태의 일반 딜러만 사용한다.
 */

import { gold } from '../config/economy.js';
import type { EconomyConfig } from '../config/economy.js';
import { spend } from './cash.js';
import {
  availableCash,
  canInstallMoreTables,
  findStaff,
  findTable,
  installedTableCount,
  tablePriceGold,
} from './derive.js';
import type {
  Command,
  CommandResult,
  EngineEvent,
  GameState,
  RejectReason,
  StaffState,
  TableState,
} from './types.js';

const ok: CommandResult = { ok: true };
const no = (reason: RejectReason, detail?: string): CommandResult =>
  detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };

/** 이 딜러가 다른 곳에 배치·예약돼 있는가 (Economy §5 중복 배치 금지) */
function isDealerCommitted(state: GameState, staffId: string, exceptTableId?: string): boolean {
  return state.tables.some(
    (t) =>
      t.id !== exceptTableId &&
      (t.dealerId === staffId || t.pendingDealerId === staffId),
  );
}

function hasActiveSessions(state: GameState, tableId: string): boolean {
  return state.sessions.some((s) => !s.settled && s.tableId === tableId);
}

/**
 * 명령 검증. 상태를 수정하지 않는다.
 * 화면이 "실행할 수 없는 이유"를 미리 보여줄 때도 이 함수를 쓴다 (Economy §8, Progression §5).
 */
export function validateCommand(
  state: GameState,
  command: Command,
  config: EconomyConfig,
): CommandResult {
  const cash = availableCash(state);

  switch (command.type) {
    case 'buyTable': {
      if (!canInstallMoreTables(state, config)) {
        return no('TABLE_CAP_REACHED', `단계 ${state.venue.stage} 상한 ${config.table.capByStage[state.venue.stage]}개`);
      }
      const index = installedTableCount(state) + 1;
      const price = gold(tablePriceGold(index, config));
      if (price > cash) return no('INSUFFICIENT_CASH', `${index}번째 테이블 ${price / 60}G, 가용 ${cash / 60}G`);
      return ok;
    }

    case 'hireDealer': {
      const price = gold(config.hire.normalDealerGold);
      if (price > cash) return no('INSUFFICIENT_CASH');
      return ok;
    }

    case 'hireServiceStaff': {
      const price = gold(config.hire.serviceStaffGold);
      if (price > cash) return no('INSUFFICIENT_CASH');
      return ok;
    }

    case 'assignDealer': {
      const table = findTable(state, command.tableId);
      if (!table) return no('TABLE_NOT_FOUND');
      const staff = findStaff(state, command.staffId);
      if (!staff) return no('STAFF_NOT_FOUND');
      if (staff.type === 'service') return no('STAFF_IS_SERVICE');
      if (table.status === 'tournamentHeld' || table.status === 'remodelPrep') {
        return no('TABLE_NOT_AVAILABLE');
      }
      if (isDealerCommitted(state, staff.id, table.id)) return no('STAFF_ALREADY_ASSIGNED');
      if (table.dealerId !== null && table.dealerId !== staff.id) {
        // 교체는 허용하되 기존 세션이 끝난 뒤 반영된다.
        return ok;
      }
      if (table.dealerId === staff.id) return no('TABLE_ALREADY_HAS_DEALER');
      return ok;
    }

    case 'unassignDealer': {
      const table = findTable(state, command.tableId);
      if (!table) return no('TABLE_NOT_FOUND');
      if (table.dealerId === null && table.pendingDealerId === undefined) {
        return no('NO_DEALER_ON_TABLE');
      }
      if (table.status === 'tournamentHeld' || table.status === 'remodelPrep') {
        return no('TABLE_NOT_AVAILABLE');
      }
      return ok;
    }

    case 'setStaffStandby': {
      const staff = findStaff(state, command.staffId);
      if (!staff) return no('STAFF_NOT_FOUND');
      if (staff.type !== 'service' && staff.assignedTableId !== null) {
        // 딜러는 테이블에서 먼저 떼어내야 한다. 조용히 빼오지 않는다 (채택 R9).
        return no('STAFF_HAS_ACTIVE_TABLE', '먼저 unassignDealer로 테이블에서 해제해야 한다');
      }
      return ok;
    }

    case 'setServiceWorking': {
      const staff = findStaff(state, command.staffId);
      if (!staff) return no('STAFF_NOT_FOUND');
      if (staff.type !== 'service') return no('STAFF_NOT_SERVICE');
      return ok;
    }

    case 'upgradeAmenity': {
      const next = state.venue.amenityLevel + 1;
      if (next > config.amenity.maxLevel) return no('AMENITY_MAX_LEVEL');
      if (installedTableCount(state) < config.amenity.unlockTableCount) {
        return no('AMENITY_LOCKED', `테이블 ${config.amenity.unlockTableCount}개 설치 필요`);
      }
      const costGold = config.amenity.costGoldByLevel[next];
      if (costGold === undefined) return no('AMENITY_MAX_LEVEL');
      if (gold(costGold) > cash) return no('INSUFFICIENT_CASH');
      return ok;
    }

    case 'buyPromotion': {
      if (!config.promotion.enabled) return no('PROMOTION_DISABLED');
      if (state.time.minute < state.records.promoReadyMinute) {
        return no('PROMOTION_ON_COOLDOWN', `재사용 가능 시각 ${state.records.promoReadyMinute}분`);
      }
      if (state.venue.awarenessMilli >= config.promotion.maxAwarenessMilli) {
        return no('PROMOTION_AWARENESS_TOO_HIGH');
      }
      if (gold(config.promotion.costGold) > cash) return no('INSUFFICIENT_CASH');
      return ok;
    }
  }
}

/**
 * 명령 적용. 반드시 validateCommand가 통과한 뒤에만 호출한다.
 * state를 직접 수정한다.
 */
export function applyCommand(
  state: GameState,
  command: Command,
  config: EconomyConfig,
  events: EngineEvent[],
): void {
  switch (command.type) {
    case 'buyTable': {
      const index = installedTableCount(state) + 1;
      const price = gold(tablePriceGold(index, config));
      spend(state, price, `table#${index}`);

      const id = `T${state.records.nextTableSeq}`;
      state.records.nextTableSeq += 1;

      // 2단계의 7번째부터 2층 (Progression §7)
      const floor: 1 | 2 = index >= 7 ? 2 : 1;
      const table: TableState = { id, spotIndex: index, floor, status: 'idle', dealerId: null };
      state.tables.push(table);

      // 대기 중인 "일반" 딜러만 자동 배치한다 (Progression §7).
      // 특별 딜러는 플레이어가 명시적으로 편성한다.
      const idle = state.staff.find(
        (s) => s.type === 'normal' && s.assignedTableId === null && !isDealerCommitted(state, s.id),
      );
      if (idle) {
        idle.assignedTableId = id;
        idle.duty = 'working';
        table.dealerId = idle.id;
        table.status = 'operating';
        events.push({ type: 'dealerChangeApplied', tableId: id, dealerId: idle.id });
      }
      return;
    }

    case 'hireDealer': {
      spend(state, gold(config.hire.normalDealerGold), 'hire:normalDealer');
      const staff: StaffState = {
        id: `S${state.records.nextStaffSeq}`,
        type: 'normal',
        duty: 'standby',
        assignedTableId: null,
      };
      state.records.nextStaffSeq += 1;
      state.staff.push(staff);
      return;
    }

    case 'hireServiceStaff': {
      spend(state, gold(config.hire.serviceStaffGold), 'hire:serviceStaff');
      const staff: StaffState = {
        id: `S${state.records.nextStaffSeq}`,
        type: 'service',
        duty: 'working', // 서비스 직원은 배치 상태로 고용된다 (Economy §5)
        assignedTableId: null,
      };
      state.records.nextStaffSeq += 1;
      state.staff.push(staff);
      return;
    }

    case 'assignDealer': {
      const table = findTable(state, command.tableId);
      const staff = findStaff(state, command.staffId);
      if (!table || !staff) throw new Error('assignDealer: 검증을 통과하지 않은 명령');

      if (table.dealerId === null && !hasActiveSessions(state, table.id)) {
        // 즉시 반영
        staff.assignedTableId = table.id;
        staff.duty = 'working';
        table.dealerId = staff.id;
        table.status = 'operating';
        delete table.pendingDealerId;
        events.push({ type: 'dealerChangeApplied', tableId: table.id, dealerId: staff.id });
      } else {
        // 기존 세션이 끝난 뒤 반영 (Economy §5)
        table.pendingDealerId = staff.id;
        table.status = 'closing';
      }
      return;
    }

    case 'unassignDealer': {
      const table = findTable(state, command.tableId);
      if (!table) throw new Error('unassignDealer: 검증을 통과하지 않은 명령');
      table.pendingDealerId = null;
      table.status = 'closing';
      return;
    }

    case 'setStaffStandby': {
      const staff = findStaff(state, command.staffId);
      if (!staff) throw new Error('setStaffStandby: 검증을 통과하지 않은 명령');
      staff.duty = 'standby';
      return;
    }

    case 'setServiceWorking': {
      const staff = findStaff(state, command.staffId);
      if (!staff) throw new Error('setServiceWorking: 검증을 통과하지 않은 명령');
      staff.duty = 'working';
      return;
    }

    case 'upgradeAmenity': {
      const next = state.venue.amenityLevel + 1;
      const costGold = config.amenity.costGoldByLevel[next];
      if (costGold === undefined) throw new Error('upgradeAmenity: 검증을 통과하지 않은 명령');
      spend(state, gold(costGold), `amenity:L${next}`);
      state.venue.amenityLevel = next;
      return;
    }

    case 'buyPromotion': {
      spend(state, gold(config.promotion.costGold), 'promotion');
      // 채택 R4: 모든 증가 경로에서 100을 넘지 않는다.
      state.venue.awarenessMilli = Math.min(
        config.demand.awarenessMaxMilli,
        state.venue.awarenessMilli + config.promotion.awarenessGainMilli,
      );
      state.records.promoReadyMinute = state.time.minute + config.promotion.cooldownMinutes;
      return;
    }
  }
}

/**
 * 틱 1단계에서 호출된다.
 * 거절된 명령은 상태를 전혀 바꾸지 않고 이벤트만 남긴다.
 */
export function processCommands(
  state: GameState,
  commands: readonly Command[],
  config: EconomyConfig,
  events: EngineEvent[],
): void {
  for (const command of commands) {
    const result = validateCommand(state, command, config);
    if (!result.ok) {
      events.push({ type: 'commandRejected', command, reason: result.reason as RejectReason });
      continue;
    }
    applyCommand(state, command, config, events);
    events.push({ type: 'commandAccepted', command });
  }
}
