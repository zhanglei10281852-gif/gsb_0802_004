import { ControlCenterClient } from './client.js';

/**
 * Scriptable build-agent simulator.
 *
 * Real build agents report validation evidence for consumers, and the real
 * network repeats, reorders, and drops those reports; agents also crash after
 * writing but before replying. This simulator reproduces every one of those
 * behaviours deterministically by executing an explicit, ordered script
 * against a real running server, using the server's logical clock so timing is
 * exact and no real time has to pass.
 *
 * A scenario is a list of steps. Steps are executed strictly in order, so the
 * "arrival order" seen by the server is whatever the script says — that is how
 * we reproduce reordering and duplicates precisely. The simulator is an
 * adapter: it contains no gate/compatibility logic, it only drives the API.
 */
export type Step =
  | { kind: 'registerSubject'; subjectId: string; requiredConsumers: string[]; freshnessWindowMs: number }
  | { kind: 'submitCandidate'; subjectId: string; baselineSchema: unknown; candidateSchema: unknown; submittedBy: string; as?: string; expectedPredecessorRef?: string }
  | {
      kind: 'report';
      reportId: string;
      subjectId: string;
      // Reference a candidate submitted earlier by its `as` alias, or give a
      // literal digest (used to test unknown/late targets).
      targetRef?: string;
      targetDigest?: string;
      consumerId: string;
      verdict: 'PASS' | 'FAIL';
      producedAt: number;
      detail?: string;
      // Deliver the same report id N times to reproduce at-least-once retries.
      repeat?: number;
      // Arm the after-write crash before this report; the first delivery will
      // 503 after committing, a following repeat reconciles as DUPLICATE.
      crashAfterWrite?: boolean;
      // Simulate a dropped response: send but ignore the outcome.
      dropResponse?: boolean;
    }
  | { kind: 'advanceClock'; deltaMs: number }
  | { kind: 'setClock'; ms: number }
  | {
      kind: 'decide';
      proposalRef?: string;
      proposalId?: string;
      expectedDigestRef?: string;
      expectedDigest?: string;
      environment?: string;
      useCurrentFingerprint?: boolean;
      type: 'APPROVE' | 'REJECT';
      decidedBy: string;
      note?: string;
      crashAfterCommit?: boolean;
      // Store the resulting decisionId under this alias for a later rollout.
      as?: string;
      // Fire two decide calls "concurrently" to test CAS conflict handling.
      concurrentWith?: { decidedBy: string; type: 'APPROVE' | 'REJECT' };
    }
  | {
      // Apply for a time-limited waiver against a candidate; store its id under
      // `as` for later confirm/reject/revoke steps.
      kind: 'requestWaiver';
      as: string;
      subjectRef?: string;
      subjectId?: string;
      candidateRef: string;
      consumerId: string;
      environment?: string;
      compatDirection: 'COMPATIBLE' | 'BREAKING' | 'UNKNOWN';
      reason: string;
      requestedBy: string;
      ttlMs: number;
    }
  | { kind: 'confirmWaiver'; waiverRef: string; confirmedBy: string }
  | { kind: 'rejectWaiver'; waiverRef: string; rejectedBy: string; reason: string }
  | { kind: 'revokeWaiver'; waiverRef: string; revokedBy: string; reason: string }
  | {
      // Create a staged rollout from a decision, storing it (and its wave ids +
      // bound fingerprint) under `as` for later receipt/pause/retry steps.
      kind: 'createRollout';
      as: string;
      decisionRef: string;
      waves: string[];
      createdBy: string;
      note?: string;
    }
  | { kind: 'startWave'; rolloutRef: string }
  | { kind: 'pauseRollout'; rolloutRef: string }
  | { kind: 'resumeRollout'; rolloutRef: string }
  | { kind: 'retryWave'; rolloutRef: string; waveIndex: number }
  | {
      // A deployment adapter reports a receipt for a wave attempt. The wave is
      // named by its 0-based index within the rollout; the bound fingerprint is
      // taken from the rollout unless `fingerprint` overrides it (to test a
      // mismatched receipt). `repeat` re-delivers the same receipt id (duplicate
      // handling); `dropResponse` sends but ignores the reply; `crashAfterWrite`
      // arms the after-write-before-reply fault so the first delivery 503s.
      kind: 'reportReceipt';
      receiptId: string;
      rolloutRef: string;
      waveIndex: number;
      attempt: number;
      result: 'SUCCESS' | 'FAILURE' | 'UNKNOWN';
      fingerprint?: string;
      detail?: string;
      repeat?: number;
      crashAfterWrite?: boolean;
      dropResponse?: boolean;
    }
  | {
      // Roll back an environment to a prior known-good candidate; deployment
      // only. Stores the new ROLLBACK rollout under `as`.
      kind: 'rollback';
      as: string;
      subjectRef?: string;
      subjectId?: string;
      targetRef: string;
      environment?: string;
      waves: string[];
      createdBy: string;
      note?: string;
    }
  | { kind: 'expect'; description: string; check: (ctx: ScenarioContext) => Promise<void> | void }
  | { kind: 'log'; message: string };

export interface Scenario {
  name: string;
  steps: Step[];
}

/** Runtime context threaded through a scenario, holding resolved ids. */
export interface ScenarioContext {
  client: ControlCenterClient;
  /** alias -> { proposalId, digest } for candidates submitted with `as`. */
  candidates: Map<string, { proposalId: string; digest: string }>;
  /** alias -> waiverId for waivers requested with `as`. */
  waivers: Map<string, string>;
  /** alias -> decisionId for decisions taken with `as`. */
  decisions: Map<string, string>;
  /** alias -> rollout handle for rollouts created with `as`. */
  rollouts: Map<string, { rolloutId: string; waveIds: string[]; fingerprint: string }>;
  /** free-form record of step outcomes for assertions. */
  outcomes: Array<{ step: string; result: unknown }>;
}

export interface RunResult {
  scenario: string;
  passed: boolean;
  steps: Array<{ step: string; ok: boolean; detail?: string }>;
}

export class AgentSimulator {
  constructor(private readonly client: ControlCenterClient) {}

  async run(scenario: Scenario): Promise<RunResult> {
    const ctx: ScenarioContext = { client: this.client, candidates: new Map(), waivers: new Map(), decisions: new Map(), rollouts: new Map(), outcomes: [] };
    const steps: RunResult['steps'] = [];
    let passed = true;

    for (const step of scenario.steps) {
      try {
        const detail = await this.exec(step, ctx);
        steps.push({ step: step.kind, ok: true, detail });
      } catch (err) {
        passed = false;
        steps.push({ step: step.kind, ok: false, detail: (err as Error).message });
        // Stop on the first failed assertion so the report is easy to read.
        break;
      }
    }

    return { scenario: scenario.name, passed, steps };
  }

  private async exec(step: Step, ctx: ScenarioContext): Promise<string | undefined> {
    switch (step.kind) {
      case 'log':
        return step.message;

      case 'registerSubject': {
        const r = await this.client.registerSubject({
          subjectId: step.subjectId,
          requiredConsumers: step.requiredConsumers,
          freshnessWindowMs: step.freshnessWindowMs
        });
        assert(r.status === 201, `registerSubject failed: ${r.status}`);
        return `subject ${step.subjectId} registered`;
      }

      case 'submitCandidate': {
        const expectedPredecessorId = step.expectedPredecessorRef
          ? ctx.candidates.get(step.expectedPredecessorRef)?.proposalId
          : undefined;
        const r = await this.client.submitCandidate(step.subjectId, {
          baselineSchema: step.baselineSchema,
          candidateSchema: step.candidateSchema,
          submittedBy: step.submittedBy,
          expectedPredecessorId
        });
        assert(r.status === 200 || r.status === 201, `submitCandidate failed: ${r.status}`);
        if (step.as) {
          ctx.candidates.set(step.as, { proposalId: r.body.proposalId, digest: r.body.candidateDigest });
        }
        const lineage = r.body.predecessorId ? ` <- ${r.body.predecessorId.slice(0, 8)}` : '';
        return `candidate ${r.body.candidateDigest.slice(0, 14)} (${r.body.compat.result})${r.body.deduplicated ? ' [dedup]' : ''}${lineage}`;
      }

      case 'report': {
        const digest = this.resolveDigest(step, ctx);
        const times = step.repeat ?? 1;
        const results: string[] = [];
        for (let i = 0; i < times; i++) {
          if (step.crashAfterWrite && i === 0) {
            await this.client.armFault('evidence.after-write-before-reply', 1);
          }
          const r = await this.client.reportEvidence({
            reportId: step.reportId,
            subjectId: step.subjectId,
            targetDigest: digest,
            consumerId: step.consumerId,
            verdict: step.verdict,
            producedAt: step.producedAt,
            detail: step.detail
          });
          if (step.dropResponse) {
            results.push('sent(response dropped)');
            continue;
          }
          results.push(`${r.status}:${r.body?.status ?? ''}`);
        }
        ctx.outcomes.push({ step: `report ${step.reportId}`, result: results });
        return results.join(' , ');
      }

      case 'advanceClock': {
        const r = await this.client.clockAdvance(step.deltaMs);
        return `clock -> ${r.body.now}`;
      }

      case 'setClock': {
        const r = await this.client.clockSet(step.ms);
        return `clock = ${r.body.now}`;
      }

      case 'decide': {
        const proposalId = step.proposalId ?? this.resolveProposalId(step.proposalRef, ctx);
        const expectedDigest = step.expectedDigest ?? this.resolveDigestRef(step.expectedDigestRef, ctx);

        let fingerprint: string | undefined;
        if (step.useCurrentFingerprint) {
          const view = await this.client.getProposal(proposalId);
          fingerprint = view.body?.gate?.evidenceFingerprint;
        }

        if (step.crashAfterCommit) {
          await this.client.armFault('decision.after-commit-before-reply', 1);
        }

        // Concurrent decisions: issue both before awaiting, so they race the
        // compare-and-set at the store.
        if (step.concurrentWith) {
          const [a, b] = await Promise.all([
            this.client.decide(proposalId, {
              expectedDigest,
              expectedFingerprint: fingerprint,
              type: step.type,
              decidedBy: step.decidedBy,
              note: step.note
            }),
            this.client.decide(proposalId, {
              expectedDigest,
              type: step.concurrentWith.type,
              decidedBy: step.concurrentWith.decidedBy
            })
          ]);
          const statuses = [a.body?.status, b.body?.status];
          const decided = statuses.filter((s) => s === 'DECIDED').length;
          ctx.outcomes.push({ step: `decide ${proposalId}`, result: { a: a.body, b: b.body } });
          return `concurrent decide -> ${statuses.join(' / ')} (decided=${decided})`;
        }

        const r = await this.client.decide(proposalId, {
          expectedDigest,
          expectedFingerprint: fingerprint,
          environment: step.environment,
          type: step.type,
          decidedBy: step.decidedBy,
          note: step.note
        });
        ctx.outcomes.push({ step: `decide ${proposalId}`, result: r.body });
        if (step.as && r.body?.decision?.decisionId) {
          ctx.decisions.set(step.as, r.body.decision.decisionId);
        }
        return `${r.status}:${r.body?.status}${r.body?.reason ? ` (${r.body.reason})` : ''}`;
      }

      case 'requestWaiver': {
        const subjectId = step.subjectId ?? this.resolveSubjectId(step.subjectRef, ctx);
        const digest = this.resolveDigestRef(step.candidateRef, ctx);
        const r = await this.client.requestWaiver({
          subjectId,
          candidateDigest: digest,
          consumerId: step.consumerId,
          environment: step.environment,
          compatDirection: step.compatDirection,
          reason: step.reason,
          requestedBy: step.requestedBy,
          ttlMs: step.ttlMs
        });
        if (r.body?.waiver?.waiverId) ctx.waivers.set(step.as, r.body.waiver.waiverId);
        ctx.outcomes.push({ step: `requestWaiver ${step.as}`, result: r.body });
        return `${r.status}:${r.body?.status}${r.body?.reason ? ` (${r.body.reason})` : ''}`;
      }

      case 'confirmWaiver': {
        const id = this.resolveWaiverId(step.waiverRef, ctx);
        const r = await this.client.confirmWaiver(id, step.confirmedBy);
        ctx.outcomes.push({ step: `confirmWaiver ${step.waiverRef}`, result: r.body });
        return `${r.status}:${r.body?.status}${r.body?.reason ? ` (${r.body.reason})` : ''}`;
      }

      case 'rejectWaiver': {
        const id = this.resolveWaiverId(step.waiverRef, ctx);
        const r = await this.client.rejectWaiver(id, step.rejectedBy, step.reason);
        ctx.outcomes.push({ step: `rejectWaiver ${step.waiverRef}`, result: r.body });
        return `${r.status}:${r.body?.status}${r.body?.reason ? ` (${r.body.reason})` : ''}`;
      }

      case 'revokeWaiver': {
        const id = this.resolveWaiverId(step.waiverRef, ctx);
        const r = await this.client.revokeWaiver(id, step.revokedBy, step.reason);
        ctx.outcomes.push({ step: `revokeWaiver ${step.waiverRef}`, result: r.body });
        return `${r.status}:${r.body?.status}${r.body?.reason ? ` (${r.body.reason})` : ''}`;
      }

      case 'createRollout': {
        const decisionId = this.resolveDecisionId(step.decisionRef, ctx);
        const r = await this.client.createRollout({
          decisionId,
          waves: step.waves,
          createdBy: step.createdBy,
          note: step.note
        });
        ctx.outcomes.push({ step: `createRollout ${step.as}`, result: r.body });
        if (r.body?.rollout?.rolloutId) {
          ctx.rollouts.set(step.as, {
            rolloutId: r.body.rollout.rolloutId,
            waveIds: (r.body.waves ?? []).map((w: any) => w.waveId),
            fingerprint: r.body.rollout.evidenceFingerprint
          });
        }
        return `${r.status}:${r.body?.status}${r.body?.reason ? ` (${r.body.reason})` : ''}`;
      }

      case 'startWave': {
        const ro = this.resolveRollout(step.rolloutRef, ctx);
        const r = await this.client.startNextWave(ro.rolloutId);
        // A started wave may be a new one; refresh wave ids so later receipts
        // resolve correctly even after retries added attempts.
        await this.refreshWaveIds(ro, ctx);
        ctx.outcomes.push({ step: `startWave ${step.rolloutRef}`, result: r.body });
        return `${r.status}:${r.body?.status}${r.body?.wave ? ` (ordinal ${r.body.wave.ordinal})` : r.body?.reason ? ` (${r.body.reason})` : ''}`;
      }

      case 'pauseRollout': {
        const ro = this.resolveRollout(step.rolloutRef, ctx);
        const r = await this.client.pauseRollout(ro.rolloutId);
        ctx.outcomes.push({ step: `pauseRollout ${step.rolloutRef}`, result: r.body });
        return `${r.status}:${r.body?.status}${r.body?.reason ? ` (${r.body.reason})` : ''}`;
      }

      case 'resumeRollout': {
        const ro = this.resolveRollout(step.rolloutRef, ctx);
        const r = await this.client.resumeRollout(ro.rolloutId);
        ctx.outcomes.push({ step: `resumeRollout ${step.rolloutRef}`, result: r.body });
        return `${r.status}:${r.body?.status}${r.body?.reason ? ` (${r.body.reason})` : ''}`;
      }

      case 'retryWave': {
        const ro = this.resolveRollout(step.rolloutRef, ctx);
        const waveId = ro.waveIds[step.waveIndex];
        if (!waveId) throw new Error(`rollout "${step.rolloutRef}" has no wave at index ${step.waveIndex}`);
        const r = await this.client.retryWave(ro.rolloutId, waveId);
        ctx.outcomes.push({ step: `retryWave ${step.rolloutRef}#${step.waveIndex}`, result: r.body });
        return `${r.status}:${r.body?.status}${r.body?.attempt ? ` (attempt ${r.body.attempt})` : r.body?.reason ? ` (${r.body.reason})` : ''}`;
      }

      case 'reportReceipt': {
        const ro = this.resolveRollout(step.rolloutRef, ctx);
        const waveId = ro.waveIds[step.waveIndex];
        if (!waveId) throw new Error(`rollout "${step.rolloutRef}" has no wave at index ${step.waveIndex}`);
        const fingerprint = step.fingerprint ?? ro.fingerprint;
        const times = step.repeat ?? 1;
        const results: string[] = [];
        for (let i = 0; i < times; i++) {
          if (step.crashAfterWrite && i === 0) {
            await this.client.armFault('rollout.receipt.after-write-before-reply', 1);
          }
          const r = await this.client.reportReceipt({
            receiptId: step.receiptId,
            rolloutId: ro.rolloutId,
            waveId,
            attempt: step.attempt,
            result: step.result,
            evidenceFingerprint: fingerprint,
            detail: step.detail
          });
          if (step.dropResponse) {
            results.push('sent(response dropped)');
            continue;
          }
          results.push(`${r.status}:${r.body?.status ?? ''}`);
        }
        ctx.outcomes.push({ step: `reportReceipt ${step.receiptId}`, result: results });
        return results.join(' , ');
      }

      case 'rollback': {
        const subjectId = step.subjectId ?? this.resolveSubjectId(step.subjectRef, ctx);
        const targetDigest = this.resolveDigestRef(step.targetRef, ctx);
        const r = await this.client.rollback({
          subjectId,
          environment: step.environment,
          targetDigest,
          waves: step.waves,
          createdBy: step.createdBy,
          note: step.note
        });
        ctx.outcomes.push({ step: `rollback ${step.as}`, result: r.body });
        if (r.body?.rollout?.rolloutId) {
          ctx.rollouts.set(step.as, {
            rolloutId: r.body.rollout.rolloutId,
            waveIds: (r.body.waves ?? []).map((w: any) => w.waveId),
            fingerprint: r.body.rollout.evidenceFingerprint
          });
        }
        return `${r.status}:${r.body?.status}${r.body?.reason ? ` (${r.body.reason})` : ''}`;
      }

      case 'expect': {
        await step.check(ctx);
        return step.description;
      }
    }
  }

  private resolveSubjectId(ref: string | undefined, ctx: ScenarioContext): string {
    if (!ref) throw new Error('step needs subjectId or subjectRef');
    const c = ctx.candidates.get(ref);
    // subjectRef reuses a candidate alias only if the caller stored one; else
    // treat the ref itself as a literal subject id.
    return c ? ref : ref;
  }

  private resolveWaiverId(ref: string, ctx: ScenarioContext): string {
    const id = ctx.waivers.get(ref);
    if (!id) throw new Error(`unknown waiver ref "${ref}"`);
    return id;
  }

  private resolveDecisionId(ref: string, ctx: ScenarioContext): string {
    const id = ctx.decisions.get(ref);
    if (!id) throw new Error(`unknown decision ref "${ref}"`);
    return id;
  }

  private resolveRollout(ref: string, ctx: ScenarioContext): { rolloutId: string; waveIds: string[]; fingerprint: string } {
    const ro = ctx.rollouts.get(ref);
    if (!ro) throw new Error(`unknown rollout ref "${ref}"`);
    return ro;
  }

  /** Re-read the rollout's waves so alias indices stay valid across retries. */
  private async refreshWaveIds(ro: { rolloutId: string; waveIds: string[] }, _ctx: ScenarioContext): Promise<void> {
    const r = await this.client.getRollout(ro.rolloutId);
    if (r.status === 200 && Array.isArray(r.body?.waves)) {
      ro.waveIds = r.body.waves
        .slice()
        .sort((a: any, b: any) => a.ordinal - b.ordinal)
        .map((w: any) => w.waveId);
    }
  }

  private resolveDigest(step: Extract<Step, { kind: 'report' }>, ctx: ScenarioContext): string {
    if (step.targetDigest) return step.targetDigest;
    if (step.targetRef) {
      const c = ctx.candidates.get(step.targetRef);
      if (!c) throw new Error(`unknown candidate ref "${step.targetRef}"`);
      return c.digest;
    }
    throw new Error('report step needs targetRef or targetDigest');
  }

  private resolveProposalId(ref: string | undefined, ctx: ScenarioContext): string {
    if (!ref) throw new Error('decide step needs proposalRef or proposalId');
    const c = ctx.candidates.get(ref);
    if (!c) throw new Error(`unknown candidate ref "${ref}"`);
    return c.proposalId;
  }

  private resolveDigestRef(ref: string | undefined, ctx: ScenarioContext): string {
    if (!ref) throw new Error('decide step needs expectedDigestRef or expectedDigest');
    const c = ctx.candidates.get(ref);
    if (!c) throw new Error(`unknown candidate ref "${ref}"`);
    return c.digest;
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}
