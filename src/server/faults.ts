import type { FaultInjector } from '../service/gate-service.js';

export class ScriptableFaults implements FaultInjector {
  private crashNextAfterWrite = false;
  private crashBeforeInsert = false;

  armCrashAfterWrite(stage: 'after-evidence-insert' | 'before-evidence-insert' = 'after-evidence-insert'): void {
    if (stage === 'before-evidence-insert') this.crashBeforeInsert = true;
    else this.crashNextAfterWrite = true;
  }

  shouldCrashAfterWrite(stage: string): boolean {
    if (stage === 'before-evidence-insert' && this.crashBeforeInsert) {
      this.crashBeforeInsert = false;
      return true;
    }
    if (stage === 'after-evidence-insert' && this.crashNextAfterWrite) {
      this.crashNextAfterWrite = false;
      return true;
    }
    return false;
  }
}
