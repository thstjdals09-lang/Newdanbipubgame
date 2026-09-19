/**
 * 대기·착석 (Economy §4).
 *
 *   - 신규 방문보다 기존 대기 손님을 먼저 착석시킨다.
 *   - 배정 순서: 테이블 ID 오름차순 -> 같은 테이블 안에서 좌석 번호 오름차순 (채택 R8).
 *     테이블 ID는 구매 순번(spotIndex)과 같은 순서이므로 spotIndex로 정렬한다.
 *   - 대기 30게임분에 도달하면 착석 전 이탈.
 *   - 대기열이 가득 차면 신규 방문객도 이탈.
 *
 * 후속 비교 과제(05 §5): 앞 번호 테이블부터 채우므로 수요가 낮을 때
 * 뒤 번호에 배치된 숙련 딜러의 속도 이득이 충분히 나타나지 않을 수 있다.
 * 다른 배정 정책은 이번에 구현하지 않는다.
 */

import type { EconomyConfig } from '../config/economy.js';
import { canSeatNewGuests, sessionMinutesFor } from './derive.js';
import { gold } from '../config/economy.js';
import type { EngineEvent, GameState, QueueEntry, SessionState, TableId } from './types.js';

interface FreeSeat {
  readonly tableId: TableId;
  readonly seatIndex: number;
  readonly spotIndex: number;
}

/** 배정 순서대로 정렬된 빈 좌석 목록 */
export function freeSeats(state: GameState, config: EconomyConfig): FreeSeat[] {
  const occupied = new Set<string>();
  for (const s of state.sessions) {
    if (!s.settled) occupied.add(`${s.tableId}#${s.seatIndex}`);
  }

  const tables = state.tables
    .filter((t) => canSeatNewGuests(state, t))
    .slice()
    .sort((a, b) => a.spotIndex - b.spotIndex);

  const seats: FreeSeat[] = [];
  for (const table of tables) {
    for (let seatIndex = 1; seatIndex <= config.table.seats; seatIndex += 1) {
      if (!occupied.has(`${table.id}#${seatIndex}`)) {
        seats.push({ tableId: table.id, seatIndex, spotIndex: table.spotIndex });
      }
    }
  }
  return seats;
}

function seat(
  state: FreeSeat,
  game: GameState,
  config: EconomyConfig,
  guestSeq: number,
  events: EngineEvent[],
): void {
  const table = game.tables.find((t) => t.id === state.tableId);
  if (!table) throw new Error(`착석: 테이블 ${state.tableId} 없음`);

  const minutes = sessionMinutesFor(game, table, config);
  const id = `SE${game.records.nextSessionSeq}`;
  game.records.nextSessionSeq += 1;

  const session: SessionState = {
    id,
    tableId: state.tableId,
    seatIndex: state.seatIndex,
    startedAtMinute: game.time.minute,
    endsAtMinute: game.time.minute + minutes,
    revenueUnits: gold(config.money.sessionRevenueGold),
    settled: false,
  };
  game.sessions.push(session);
  events.push({ type: 'guestSeated', seq: guestSeq, tableId: state.tableId, sessionId: id });
}

export interface SeatingResult {
  /** 이번 분의 신규 방문 수 (이탈 포함) */
  readonly arrivals: number;
  /** 이번 분의 이탈 수 (대기 만료 + 대기열 초과) */
  readonly abandons: number;
}

/**
 * 틱 6단계: 대기 만료 -> 기존 대기 착석 -> 신규 방문 착석 -> 잔여는 대기 또는 이탈.
 * state를 직접 수정한다.
 */
export function processSeating(
  state: GameState,
  config: EconomyConfig,
  newGuests: number,
  events: EngineEvent[],
): SeatingResult {
  let abandons = 0;

  // 1) 대기 만료
  const kept: QueueEntry[] = [];
  for (const entry of state.queue) {
    const waited = state.time.minute - entry.arrivedAtMinute;
    if (waited >= config.queue.abandonAfterMinutes) {
      abandons += 1;
      events.push({ type: 'guestAbandoned', seq: entry.seq, waitedMinutes: waited, cause: 'timeout' });
    } else {
      kept.push(entry);
    }
  }
  state.queue = kept;

  const seats = freeSeats(state, config);
  let cursor = 0;

  // 2) 기존 대기 손님 우선 착석 (도착 순서)
  while (cursor < seats.length && state.queue.length > 0) {
    const entry = state.queue.shift();
    if (!entry) break;
    const free = seats[cursor];
    if (!free) break;
    cursor += 1;
    seat(free, state, config, entry.seq, events);
  }

  // 3) 신규 방문객
  const queueCapacity = config.queue.capacityByStage[state.venue.stage];
  for (let i = 0; i < newGuests; i += 1) {
    const seq = state.records.nextArrivalSeq;
    state.records.nextArrivalSeq += 1;
    events.push({ type: 'guestArrived', seq });

    const free = seats[cursor];
    if (free !== undefined) {
      cursor += 1;
      seat(free, state, config, seq, events);
      continue;
    }
    if (state.queue.length < queueCapacity) {
      state.queue.push({ seq, arrivedAtMinute: state.time.minute });
      continue;
    }
    abandons += 1;
    events.push({ type: 'guestAbandoned', seq, waitedMinutes: 0, cause: 'queueFull' });
  }

  return { arrivals: newGuests, abandons };
}
