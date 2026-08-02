export interface Clock {
  now(): number;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

export class ManualClock implements Clock {
  private current: number;
  constructor(start = 0) {
    this.current = start;
  }
  now(): number {
    return this.current;
  }
  advance(ms: number): number {
    this.current += ms;
    return this.current;
  }
  set(ms: number): void {
    this.current = ms;
  }
}
