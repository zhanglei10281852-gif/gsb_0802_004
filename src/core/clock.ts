/** 可替换时钟：生产环境用 SystemClock，测试与端到端用 ManualClock。 */
export interface Clock {
  /** 当前时刻（epoch 毫秒）。 */
  now(): number;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

/** 手动时钟：只能通过 advance 前进，用于无真实等待的时序复现。 */
export class ManualClock implements Clock {
  private t: number;
  constructor(start = 0) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  advance(ms: number): number {
    if (!Number.isFinite(ms) || ms < 0) throw new Error('advance 需要非负毫秒数');
    this.t += ms;
    return this.t;
  }
  set(ms: number): void {
    this.t = ms;
  }
}
