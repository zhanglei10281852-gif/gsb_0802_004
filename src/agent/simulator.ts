import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { resolve } from "node:path";
import { GateClient } from "./gate-client.js";
import type { Scenario } from "./scenario.js";
import type { GateView } from "../web/types";

export interface RunOptions {
  baseUrl: string;
  dbPath: string;
  serverEntry: string;
  env?: Record<string, string>;
}

export class SimLogger {
  lines: string[] = [];
  log(msg: string): void {
    const line = `[sim] ${msg}`;
    this.lines.push(line);
    console.log(line);
  }
}

export class AgentSimulator {
  private proc: ChildProcess | null = null;
  readonly client: GateClient;
  constructor(
    private readonly opts: RunOptions,
    private readonly logger = new SimLogger(),
  ) {
    this.client = new GateClient(opts.baseUrl);
  }

  async startServer(extraEnv: Record<string, string> = {}): Promise<void> {
    if (this.proc) return;
    const env = {
      ...process.env,
      PORT: new URL(this.opts.baseUrl).port,
      HOST: "127.0.0.1",
      DB_PATH: this.opts.dbPath,
      LOG_LEVEL: "warn",
      VIRTUAL_CLOCK: "1",
      DEBUG_FAULTS: "1",
      ...this.opts.env,
      ...extraEnv,
    };
    this.proc = spawn(process.execPath, [this.opts.serverEntry], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.proc.stdout?.on("data", (d) =>
      this.logger.log(`[server:out] ${d.toString().trim()}`),
    );
    this.proc.stderr?.on("data", (d) =>
      this.logger.log(`[server:err] ${d.toString().trim()}`),
    );
    this.proc.on("exit", (code) => {
      this.logger.log(`server exited code=${code}`);
      this.proc = null;
    });
    await this.waitForHealthy();
  }

  async stopServer(): Promise<void> {
    if (!this.proc) return;
    this.proc.kill("SIGTERM");
    await once(this.proc, "exit").catch(() => {});
    this.proc = null;
  }

  killServerHard(): void {
    if (this.proc) {
      this.proc.kill("SIGKILL");
      this.proc = null;
    }
  }

  async armCrashAfterWrite(
    stage:
      | "after-evidence-insert"
      | "before-evidence-insert" = "after-evidence-insert",
  ): Promise<void> {
    const res = await fetch(
      new URL("/api/debug/faults/crash-after-write", this.opts.baseUrl),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage }),
      },
    );
    if (!res.ok) throw new Error(`arm crash failed: ${await res.text()}`);
  }

  private async waitForHealthy(timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        await this.client.health();
        return;
      } catch {
        await sleep(150);
      }
    }
    throw new Error("server did not become healthy in time");
  }

  async restart(): Promise<void> {
    await this.stopServer();
    await sleep(200);
    await this.startServer();
  }

  async advanceClock(ms: number): Promise<void> {
    const res = await fetch(
      new URL("/api/debug/clock/advance", this.opts.baseUrl),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ms }),
      },
    );
    if (!res.ok) throw new Error(`clock advance failed: ${await res.text()}`);
  }

  async runScenario(
    scenario: Scenario,
  ): Promise<{ proposalId: string; finalView: GateView }> {
    const proposal = await this.client.createProposal({
      topic: scenario.topic,
      baseline: scenario.baseline,
      candidate: scenario.candidate,
      consumers: scenario.consumers,
      author: "agent-sim",
      ttlMs: scenario.ttlMs,
    });
    this.logger.log(
      `created proposal ${proposal.proposalId} status=${proposal.status} compatible=${proposal.compatibility.compatible}`,
    );
    const capturedProposals = new Map<string, string>();
    capturedProposals.set("root", proposal.proposalId);
    let activeProposalId = proposal.proposalId;
    let activeCandidateDigest = proposal.candidateDigest;

    let runCounter = 0;
    const captured = new Map<string, string>();

    const resolveTarget = (step: { targetProposal?: string }): string => {
      if (step.targetProposal) {
        return (
          capturedProposals.get(step.targetProposal) ?? step.targetProposal
        );
      }
      return activeProposalId;
    };

    for (const step of scenario.steps) {
      switch (step.action) {
        case "report": {
          runCounter++;
          const targetId = resolveTarget(step);
          const key = `${step.consumerId}-${targetId}-run${runCounter}`;
          const digest = step.wrongDigest
            ? "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
            : step.targetProposal === "root"
              ? proposal.candidateDigest
              : activeCandidateDigest;
          const consumer = step.unknownConsumer
            ? `${step.consumerId}-unknown`
            : step.consumerId!;
          if (step.crashAfterWrite) {
            await this.armCrashAfterWrite("after-evidence-insert");
            this.logger.log(
              `reporting ${step.result} from ${consumer} with crash-after-write armed`,
            );
            try {
              await this.client.reportEvidence({
                proposalId: targetId,
                candidateDigest: digest,
                consumerId: consumer!,
                status: step.result ?? "pass",
                detail: step.detail ?? `${step.result} result`,
                reportedAt: Date.now(),
                idempotencyKey: key,
                agentRunId: `run-${runCounter}`,
              });
            } catch (e) {
              this.logger.log(
                `connection reset as expected (process crashed after write): ${(e as Error).message}`,
              );
            }
            this.proc = null;
          } else {
            this.logger.log(
              `reporting ${step.result} from ${consumer} key=${key} target=${targetId}${step.duplicate ? " (will duplicate)" : ""}`,
            );
            const rep = await this.client.reportEvidence({
              proposalId: targetId,
              candidateDigest: digest,
              consumerId: consumer!,
              status: step.result ?? "pass",
              detail: step.detail ?? `${step.result} result`,
              reportedAt: Date.now(),
              idempotencyKey: key,
              agentRunId: `run-${runCounter}`,
            });
            if (!rep.accepted) {
              this.logger.log(
                `evidence rejected: reason=${rep.reason} (attributed to ${targetId})`,
              );
              if (
                step.expectRejectedReason &&
                rep.reason !== step.expectRejectedReason
              ) {
                throw new Error(
                  `expected rejection reason ${step.expectRejectedReason}, got ${rep.reason}`,
                );
              }
            }
            if (step.duplicate) {
              const dup = await this.client.reportEvidence({
                proposalId: targetId,
                candidateDigest: digest,
                consumerId: consumer!,
                status: step.result ?? "pass",
                detail: step.detail ?? `${step.result} result`,
                reportedAt: Date.now(),
                idempotencyKey: key,
                agentRunId: `run-${runCounter}`,
              });
              this.logger.log(
                `duplicate accepted=${dup.accepted} deduped=${dup.deduped}`,
              );
            }
          }
          break;
        }
        case "create-successor": {
          const candidate = step.candidate ?? scenario.candidate;
          const { predecessor, successor } = await this.client.createSuccessor(
            activeProposalId,
            {
              candidate,
              author: step.author ?? "upstream-author",
              note: step.note,
              ttlMs: step.ttlMs,
            },
          );
          if (step.captureProposalAs)
            capturedProposals.set(step.captureProposalAs, successor.proposalId);
          activeProposalId = successor.proposalId;
          activeCandidateDigest = successor.candidateDigest;
          this.logger.log(
            `created successor ${successor.proposalId} (digest ${successor.candidateDigest.slice(0, 12)}…); predecessor ${predecessor.proposalId} -> ${predecessor.status}`,
          );
          if (predecessor.status !== "superseded") {
            throw new Error(
              `expected predecessor to be superseded, got ${predecessor.status}`,
            );
          }
          break;
        }
        case "report-to-predecessor": {
          runCounter++;
          const predecessorId =
            (await this.client
              .getGateView(activeProposalId)
              .then((v) => v.proposal.lineage.predecessorId)) ??
            proposal.proposalId;
          const key = `late-${step.consumerId}-${predecessorId}-run${runCounter}`;
          this.logger.log(
            `late report ${step.result} from ${step.consumerId} to PREDECESSOR ${predecessorId}`,
          );
          const rep = await this.client.reportEvidence({
            proposalId: predecessorId,
            candidateDigest: proposal.candidateDigest,
            consumerId: step.consumerId!,
            status: step.result ?? "pass",
            detail: step.detail ?? "late result for old candidate",
            reportedAt: Date.now(),
            idempotencyKey: key,
            agentRunId: `late-run-${runCounter}`,
          });
          this.logger.log(
            `late report accepted=${rep.accepted} reason=${rep.reason ?? "n/a"}`,
          );
          if (rep.accepted) {
            throw new Error(
              "expected late evidence to predecessor to be rejected as proposal-superseded",
            );
          }
          if (
            step.expectRejectedReason &&
            rep.reason !== step.expectRejectedReason
          ) {
            throw new Error(
              `expected rejection reason ${step.expectRejectedReason}, got ${rep.reason}`,
            );
          }
          break;
        }
        case "expect-status": {
          const targetId = resolveTarget(step);
          const view = await this.client.getGateView(
            targetId,
            step.environment,
          );
          this.logger.log(
            `status of ${targetId}=${view.proposal.status} expected=${step.expectedStatus}`,
          );
          if (view.proposal.status !== step.expectedStatus) {
            throw new Error(
              `expected status ${step.expectedStatus}, got ${view.proposal.status}`,
            );
          }
          break;
        }
        case "wait":
          await sleep(step.ms ?? 100);
          break;
        case "sleep-real":
          await sleep(step.ms ?? 100);
          break;
        case "advance-clock":
          await this.advanceClock(step.ms ?? 1000);
          this.logger.log(`advanced virtual clock by ${step.ms}ms`);
          break;
        case "crash-server":
          this.logger.log(
            "CRASH: killing server hard (simulates post-write/pre-reply crash)",
          );
          this.killServerHard();
          break;
        case "restart-server":
          await this.restart();
          this.logger.log("server restarted from SQLite");
          break;
        case "expect-blockers": {
          const targetId = resolveTarget(step);
          const view = await this.client.getGateView(
            targetId,
            step.environment,
          );
          this.logger.log(
            `blockers=${view.blockers.length} expected>=${step.minBlockers ?? 0} on ${targetId}`,
          );
          if (view.blockers.length < (step.minBlockers ?? 0)) {
            throw new Error(
              `expected >=${step.minBlockers} blockers, got ${view.blockers.length}: ${view.blockers.map((b) => b.message).join("; ")}`,
            );
          }
          if (
            step.maxBlockers !== undefined &&
            view.blockers.length > step.maxBlockers
          ) {
            throw new Error(
              `expected <=${step.maxBlockers} blockers, got ${view.blockers.length}`,
            );
          }
          if (step.expectAppliedExemptions !== undefined) {
            this.logger.log(
              `applied exemptions=${view.appliedExemptions.length} expected=${step.expectAppliedExemptions}`,
            );
            if (
              view.appliedExemptions.length !== step.expectAppliedExemptions
            ) {
              throw new Error(
                `expected ${step.expectAppliedExemptions} applied exemptions, got ${view.appliedExemptions.length}`,
              );
            }
          }
          break;
        }
        case "decide": {
          const targetId = resolveTarget(step);
          try {
            const result = await this.client.decide(
              targetId,
              step.kind ?? "approve",
              step.decider ?? "sim",
              "automated",
              step.environment,
            );
            this.logger.log(`decision ${result.status} on ${targetId}`);
            if (step.expectBlocked) {
              throw new Error(
                `expected decision to be blocked but it succeeded (${result.status})`,
              );
            }
          } catch (e) {
            this.logger.log(`decision rejected: ${(e as Error).message}`);
            if (!step.expectBlocked && step.kind === "approve") throw e;
            if (step.expectBlocked) this.logger.log("(blocking was expected)");
          }
          break;
        }
        case "request-exemption": {
          const targetId = resolveTarget(step);
          const rec = await this.client.requestExemption(targetId, {
            consumerId: step.consumerId!,
            environment: step.environment ?? "prod",
            direction: step.direction ?? "backward",
            reason: step.reason ?? "offline during release window",
            requestedBy: step.requestedBy ?? "alice",
            ttlMs: step.ttlMs ?? 3600000,
          });
          if (step.captureExemptionAs)
            captured.set(step.captureExemptionAs, rec.exemptionId);
          this.logger.log(
            `requested exemption ${rec.exemptionId} status=${rec.status} on ${targetId}`,
          );
          break;
        }
        case "review-exemption": {
          const exId = step.exemptionId
            ? (captured.get(step.exemptionId) ?? step.exemptionId)
            : (captured.values().next().value as string);
          const rec = await this.client.reviewExemption(
            activeProposalId,
            exId,
            {
              reviewer: step.reviewer ?? "reviewer",
              approved: step.approved ?? true,
              comment: step.comment ?? "",
            },
          );
          this.logger.log(
            `review by ${step.reviewer} -> status=${rec.status} approvals=${rec.reviews.filter((r) => r.approved).length}`,
          );
          break;
        }
        case "revoke-exemption": {
          const exId = step.exemptionId
            ? (captured.get(step.exemptionId) ?? step.exemptionId)
            : (captured.values().next().value as string);
          const rec = await this.client.revokeExemption(
            activeProposalId,
            exId,
            step.revokedBy ?? step.reviewer ?? "reviewer",
          );
          this.logger.log(`revoked exemption -> status=${rec.status}`);
          break;
        }
      }
    }

    const finalView = await this.client.getGateView(activeProposalId);
    return { proposalId: activeProposalId, finalView };
  }
}

export function simulatorEntryPath(): string {
  return resolve(process.cwd(), "dist/server/main.js");
}
