import type { FaultInjector } from "../service/gate-service.js";

export type CrashStage =
  | "after-evidence-insert"
  | "before-evidence-insert"
  | "after-receipt-insert"
  | "before-receipt-insert";

export class ScriptableFaults implements FaultInjector {
  private crashNextAfterWrite = false;
  private crashBeforeInsert = false;
  private crashNextAfterReceipt = false;
  private crashBeforeReceipt = false;

  armCrashAfterWrite(stage: CrashStage = "after-evidence-insert"): void {
    if (stage === "before-evidence-insert") this.crashBeforeInsert = true;
    else if (stage === "after-receipt-insert")
      this.crashNextAfterReceipt = true;
    else if (stage === "before-receipt-insert") this.crashBeforeReceipt = true;
    else this.crashNextAfterWrite = true;
  }

  shouldCrashAfterWrite(stage: string): boolean {
    if (stage === "before-evidence-insert" && this.crashBeforeInsert) {
      this.crashBeforeInsert = false;
      return true;
    }
    if (stage === "after-evidence-insert" && this.crashNextAfterWrite) {
      this.crashNextAfterWrite = false;
      return true;
    }
    if (stage === "before-receipt-insert" && this.crashBeforeReceipt) {
      this.crashBeforeReceipt = false;
      return true;
    }
    if (stage === "after-receipt-insert" && this.crashNextAfterReceipt) {
      this.crashNextAfterReceipt = false;
      return true;
    }
    return false;
  }
}
