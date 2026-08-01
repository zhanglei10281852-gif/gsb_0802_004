export interface Clock {
  now(): number;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

export class VirtualClock implements Clock {
  private current: number;

  constructor(start = 0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  advance(ms: number): number {
    if (ms < 0) throw new Error('cannot rewind clock');
    this.current += ms;
    return this.current;
  }

  setTo(ms: number): void {
    if (ms < this.current) throw new Error('cannot rewind clock');
    this.current = ms;
  }
}
