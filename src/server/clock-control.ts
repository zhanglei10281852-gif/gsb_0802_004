import type { Clock } from '../core/clock.js';
import { ManualClock, SystemClock } from '../core/clock.js';

export interface ControllableClock extends Clock {
  readonly mode: 'system' | 'manual';
  advance(ms: number): number;
  set(ms: number): number;
}

export class SystemControllableClock extends SystemClock implements ControllableClock {
  readonly mode = 'system' as const;
  advance(): number { return this.now(); }
  set(_ms: number): number { return this.now(); }
}

export class ManualControllableClock extends ManualClock implements ControllableClock {
  readonly mode = 'manual' as const;
  override set(ms: number): number { super.set(ms); return this.now(); }
}

export function createClockFromEnv(): ControllableClock {
  if (process.env.VIRTUAL_CLOCK === '1') {
    return new ManualControllableClock(Date.now());
  }
  return new SystemControllableClock();
}
