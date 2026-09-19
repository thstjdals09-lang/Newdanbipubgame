/**
 * 정수 고정소수 연산 헬퍼.
 *
 * 규칙 (05 채택기록 v1 §4):
 *   - 모든 나눗셈은 floor + 나머지 보존.
 *   - floor를 쓰는 이유: 음수에서 trunc/round와 부호 거동이 갈려 재현성이 깨진다.
 *   - 나머지는 항상 [0, den) 범위이며 상태에 저장된다.
 */

/** floor 나눗셈. den > 0 을 전제한다. */
export function floorDiv(num: number, den: number): number {
  return Math.floor(num / den);
}

export interface DivRem {
  readonly quotient: number;
  /** 항상 0 이상 den 미만 */
  readonly remainder: number;
}

/**
 * num을 den으로 나누되 나머지를 보존한다.
 * quotient * den + remainder === num 이 항상 성립한다.
 */
export function divRem(num: number, den: number): DivRem {
  if (den <= 0) throw new Error(`divRem: den은 양수여야 함 (${den})`);
  const quotient = Math.floor(num / den);
  const remainder = num - quotient * den;
  return { quotient, remainder };
}

export function clamp(v: number, lo: number, hi: number): number {
  if (lo > hi) throw new Error(`clamp: 범위가 뒤집힘 (${lo} > ${hi})`);
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 안전 정수 검사.
 * 엔진은 매 틱 금액에 이 검사를 건다 (05 §4-1 "안전 범위").
 */
export function assertSafeInteger(v: number, label: string): number {
  if (!Number.isInteger(v)) {
    throw new Error(`${label}: 정수가 아님 (${v})`);
  }
  if (!Number.isSafeInteger(v)) {
    throw new Error(`${label}: 안전 정수 범위를 벗어남 (${v})`);
  }
  return v;
}

/** floor 나눗셈이 정확히 나누어떨어지는지 확인하고 몫을 돌려준다. */
export function exactDiv(num: number, den: number, label: string): number {
  const { quotient, remainder } = divRem(num, den);
  if (remainder !== 0) {
    throw new Error(`${label}: ${num} / ${den} 이 정확히 나누어떨어지지 않음`);
  }
  return quotient;
}
