/**
 * Fault-injection port.
 *
 * Real service instances can crash after committing state but before replying,
 * duplicate work, or drop responses. To reproduce these deterministically the
 * application service asks a FaultInjector at named fault points whether it
 * should fail *now*. Production wires in a no-op injector; tests and the e2e
 * harness arm specific points so the exact "wrote-then-crashed" window can be
 * exercised without relying on timing luck.
 */
export type FaultPoint =
  | 'evidence.after-write-before-reply'
  | 'decision.after-commit-before-reply';

export interface FaultInjector {
  /**
   * Returns true if the named fault point should trip on this invocation.
   * Implementations may be one-shot (arm once, trip once) so a retried
   * request can succeed on the second attempt.
   */
  shouldFail(point: FaultPoint): boolean;
}

/** Never fails. Used in production. */
export class NoFaults implements FaultInjector {
  shouldFail(): boolean {
    return false;
  }
}

/**
 * Programmable injector. Arm a fault point with a count; each `shouldFail`
 * that matches decrements it and returns true until it reaches zero.
 */
export class ArmableFaults implements FaultInjector {
  private armed = new Map<FaultPoint, number>();

  arm(point: FaultPoint, times = 1): void {
    this.armed.set(point, times);
  }

  disarm(point: FaultPoint): void {
    this.armed.delete(point);
  }

  shouldFail(point: FaultPoint): boolean {
    const n = this.armed.get(point) ?? 0;
    if (n <= 0) return false;
    if (n === 1) this.armed.delete(point);
    else this.armed.set(point, n - 1);
    return true;
  }
}

/** Signals a deliberately injected crash, so callers can distinguish it. */
export class InjectedCrash extends Error {
  constructor(public readonly point: FaultPoint) {
    super(`injected crash at fault point: ${point}`);
    this.name = 'InjectedCrash';
  }
}
