/**
 * Clock port.
 *
 * The domain and application layers never call `Date.now()` directly. They ask
 * a Clock. This makes time a replaceable dependency: production uses the wall
 * clock, tests and the agent simulator use a logical clock they advance
 * explicitly, so timelines (freshness expiry, ordering) can be reproduced
 * without waiting for real time to pass.
 */
export interface Clock {
  /** Current time in epoch milliseconds. */
  now(): number;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

/**
 * A logical clock whose value only changes when explicitly advanced or set.
 * Two calls to `now()` return the same value unless time was moved in between,
 * which is exactly what deterministic replay of timing-sensitive scenarios
 * requires.
 */
export class LogicalClock implements Clock {
  private current: number;

  constructor(start = 0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  set(ms: number): void {
    if (ms < this.current) {
      throw new Error(`logical clock cannot move backwards: ${ms} < ${this.current}`);
    }
    this.current = ms;
  }

  advance(deltaMs: number): number {
    if (deltaMs < 0) {
      throw new Error(`cannot advance clock by negative delta: ${deltaMs}`);
    }
    this.current += deltaMs;
    return this.current;
  }
}
