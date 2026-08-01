import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve } from 'node:path';
import { GateClient } from './gate-client.js';
import type { Scenario } from './scenario.js';
import type { GateView } from '../web/types';

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
  constructor(private readonly opts: RunOptions, private readonly logger = new SimLogger()) {
    this.client = new GateClient(opts.baseUrl);
  }

  async startServer(extraEnv: Record<string, string> = {}): Promise<void> {
    if (this.proc) return;
    const env = {
      ...process.env,
      PORT: new URL(this.opts.baseUrl).port,
      HOST: '127.0.0.1',
      DB_PATH: this.opts.dbPath,
      LOG_LEVEL: 'warn',
      VIRTUAL_CLOCK: '1',
      DEBUG_FAULTS: '1',
      ...this.opts.env,
      ...extraEnv,
    };
    this.proc = spawn(process.execPath, [this.opts.serverEntry], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc.stdout?.on('data', (d) => this.logger.log(`[server:out] ${d.toString().trim()}`));
    this.proc.stderr?.on('data', (d) => this.logger.log(`[server:err] ${d.toString().trim()}`));
    this.proc.on('exit', (code) => {
      this.logger.log(`server exited code=${code}`);
      this.proc = null;
    });
    await this.waitForHealthy();
  }

  async stopServer(): Promise<void> {
    if (!this.proc) return;
    this.proc.kill('SIGTERM');
    await once(this.proc, 'exit').catch(() => {});
    this.proc = null;
  }

  killServerHard(): void {
    if (this.proc) {
      this.proc.kill('SIGKILL');
      this.proc = null;
    }
  }

  async armCrashAfterWrite(stage: 'after-evidence-insert' | 'before-evidence-insert' = 'after-evidence-insert'): Promise<void> {
    const res = await fetch(new URL('/api/debug/faults/crash-after-write', this.opts.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage }),
    });
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
    throw new Error('server did not become healthy in time');
  }

  async restart(): Promise<void> {
    await this.stopServer();
    await sleep(200);
    await this.startServer();
  }

  async advanceClock(ms: number): Promise<void> {
    const res = await fetch(new URL('/api/debug/clock/advance', this.opts.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ms }),
    });
    if (!res.ok) throw new Error(`clock advance failed: ${await res.text()}`);
  }

  async runScenario(scenario: Scenario): Promise<{ proposalId: string; finalView: GateView }> {
    const proposal = await this.client.createProposal({
      topic: scenario.topic,
      baseline: scenario.baseline,
      candidate: scenario.candidate,
      consumers: scenario.consumers,
      author: 'agent-sim',
      ttlMs: scenario.ttlMs,
    });
    this.logger.log(`created proposal ${proposal.proposalId} status=${proposal.status} compatible=${proposal.compatibility.compatible}`);
    const proposalId = proposal.proposalId;

    let runCounter = 0;
    for (const step of scenario.steps) {
      switch (step.action) {
        case 'report': {
          runCounter++;
          const key = `${step.consumerId}-${proposalId}-run${runCounter}`;
          const digest = step.wrongDigest
            ? 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
            : proposal.candidateDigest;
          const consumer = step.unknownConsumer ? `${step.consumerId}-unknown` : step.consumerId!;
          if (step.crashAfterWrite) {
            await this.armCrashAfterWrite('after-evidence-insert');
            this.logger.log(`reporting ${step.result} from ${consumer} with crash-after-write armed`);
            try {
              await this.client.reportEvidence({
                proposalId,
                candidateDigest: digest,
                consumerId: consumer!,
                status: step.result ?? 'pass',
                detail: step.detail ?? `${step.result} result`,
                reportedAt: Date.now(),
                idempotencyKey: key,
                agentRunId: `run-${runCounter}`,
              });
            } catch (e) {
              this.logger.log(`connection reset as expected (process crashed after write): ${(e as Error).message}`);
            }
            this.proc = null;
          } else {
            this.logger.log(`reporting ${step.result} from ${consumer} key=${key}${step.duplicate ? ' (will duplicate)' : ''}`);
            await this.client.reportEvidence({
              proposalId,
              candidateDigest: digest,
              consumerId: consumer!,
              status: step.result ?? 'pass',
              detail: step.detail ?? `${step.result} result`,
              reportedAt: Date.now(),
              idempotencyKey: key,
              agentRunId: `run-${runCounter}`,
            });
            if (step.duplicate) {
              const dup = await this.client.reportEvidence({
                proposalId,
                candidateDigest: digest,
                consumerId: consumer!,
                status: step.result ?? 'pass',
                detail: step.detail ?? `${step.result} result`,
                reportedAt: Date.now(),
                idempotencyKey: key,
                agentRunId: `run-${runCounter}`,
              });
              this.logger.log(`duplicate accepted=${dup.accepted} deduped=${dup.deduped}`);
            }
          }
          break;
        }
        case 'wait':
          await sleep(step.ms ?? 100);
          break;
        case 'sleep-real':
          await sleep(step.ms ?? 100);
          break;
        case 'advance-clock':
          await this.advanceClock(step.ms ?? 1000);
          this.logger.log(`advanced virtual clock by ${step.ms}ms`);
          break;
        case 'crash-server':
          this.logger.log('CRASH: killing server hard (simulates post-write/pre-reply crash)');
          this.killServerHard();
          break;
        case 'restart-server':
          await this.restart();
          this.logger.log('server restarted from SQLite');
          break;
        case 'expect-blockers': {
          const view = await this.client.getGateView(proposalId);
          this.logger.log(`blockers=${view.blockers.length} expected>=${step.minBlockers ?? 0}`);
          if (view.blockers.length < (step.minBlockers ?? 0)) {
            throw new Error(`expected >=${step.minBlockers} blockers, got ${view.blockers.length}: ${view.blockers.map((b) => b.message).join('; ')}`);
          }
          break;
        }
        case 'decide': {
          try {
            const result = await this.client.decide(proposalId, step.kind ?? 'approve', step.decider ?? 'sim', 'automated');
            this.logger.log(`decision ${result.status}`);
            if (step.expectBlocked) {
              throw new Error(`expected decision to be blocked but it succeeded (${result.status})`);
            }
          } catch (e) {
            this.logger.log(`decision rejected: ${(e as Error).message}`);
            if (!step.expectBlocked && step.kind === 'approve') throw e;
            if (step.expectBlocked) this.logger.log('(blocking was expected)');
          }
          break;
        }
      }
    }

    const finalView = await this.client.getGateView(proposalId);
    return { proposalId, finalView };
  }
}

export function simulatorEntryPath(): string {
  return resolve(process.cwd(), 'dist/server/main.js');
}
