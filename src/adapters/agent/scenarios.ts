import { candidateDigest } from '../../domain/digest.js';
import type { Scenario, ScenarioContext } from './simulator.js';

/**
 * Built-in scenarios that reproduce the hard timing/failure cases from a
 * single script, so the guarantees can be demonstrated without waiting on real
 * time or real network flakiness. Each scenario targets one property.
 */

const baseline = {
  type: 'object',
  properties: { id: { type: 'string' }, amount: { type: 'number' } },
  required: ['id']
};

// A backward-compatible candidate: adds an optional field only.
const compatibleCandidate = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    amount: { type: 'number' },
    currency: { type: 'string' }
  },
  required: ['id']
};

// A breaking candidate: newly requires a field.
const breakingCandidate = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    amount: { type: 'number' },
    currency: { type: 'string' }
  },
  required: ['id', 'currency']
};

// A corrected, still-compatible candidate distinct from `compatibleCandidate`
// (different optional field) — used as a successor, so it has a new digest.
const correctedCandidate = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    amount: { type: 'number' },
    region: { type: 'string' }
  },
  required: ['id']
};

function digestOf(schema: unknown): string {
  return candidateDigest(schema);
}

async function expectSnapshotGate(
  ctx: ScenarioContext,
  subjectId: string,
  predicate: (gate: any) => boolean,
  description: string
): Promise<void> {
  const snap = await ctx.client.snapshot();
  const subj = snap.body.subjects.find((s: any) => s.subject.subjectId === subjectId);
  if (!subj?.current) throw new Error(`${description}: no current proposal`);
  if (!predicate(subj.current.gate)) {
    throw new Error(`${description}: gate was ${JSON.stringify(subj.current.gate.status)}`);
  }
}

export function buildScenarios(): Scenario[] {
  return [
    // 1) Happy path: complete fresh evidence -> READY -> APPROVE, plus proof
    //    that a duplicate report is idempotent.
    {
      name: 'gate-happy-path-and-idempotency',
      steps: [
        { kind: 'registerSubject', subjectId: 'orders', requiredConsumers: ['billing', 'search'], freshnessWindowMs: 10_000 },
        { kind: 'submitCandidate', subjectId: 'orders', baselineSchema: baseline, candidateSchema: compatibleCandidate, submittedBy: 'dev', as: 'c1' },
        { kind: 'report', reportId: 'r-billing-1', subjectId: 'orders', targetRef: 'c1', consumerId: 'billing', verdict: 'PASS', producedAt: 0 },
        // Same report id delivered 3 times (at-least-once retry): applied once.
        { kind: 'report', reportId: 'r-search-1', subjectId: 'orders', targetRef: 'c1', consumerId: 'search', verdict: 'PASS', producedAt: 0, repeat: 3 },
        {
          kind: 'expect',
          description: 'gate READY with both consumers passing',
          check: (ctx) => expectSnapshotGate(ctx, 'orders', (g) => g.status === 'READY' && g.canApprove, 'happy path')
        },
        { kind: 'decide', proposalRef: 'c1', expectedDigestRef: 'c1', useCurrentFingerprint: true, type: 'APPROVE', decidedBy: 'release-mgr' },
        {
          kind: 'expect',
          description: 'proposal recorded as APPROVED with immutable snapshot',
          check: async (ctx) => {
            const c = ctx.candidates.get('c1')!;
            const view = await ctx.client.getProposal(c.proposalId);
            if (view.body.proposal.state !== 'APPROVED') throw new Error('expected APPROVED');
            if (!view.body.decision?.gateSnapshot) throw new Error('missing decision snapshot');
          }
        }
      ]
    },

    // 2) Missing evidence blocks approval; late evidence for an OLD candidate
    //    must not count toward the CURRENT proposal.
    {
      name: 'late-evidence-for-superseded-candidate-is-ignored',
      steps: [
        { kind: 'registerSubject', subjectId: 'inventory', requiredConsumers: ['warehouse'], freshnessWindowMs: 10_000 },
        { kind: 'submitCandidate', subjectId: 'inventory', baselineSchema: baseline, candidateSchema: compatibleCandidate, submittedBy: 'dev', as: 'old' },
        // Submit a newer candidate; the old one is superseded.
        { kind: 'submitCandidate', subjectId: 'inventory', baselineSchema: baseline, candidateSchema: breakingCandidate, submittedBy: 'dev', as: 'new' },
        // Evidence arrives LATE for the old candidate: must be ignored.
        { kind: 'report', reportId: 'r-late-1', subjectId: 'inventory', targetRef: 'old', consumerId: 'warehouse', verdict: 'PASS', producedAt: 0 },
        {
          kind: 'expect',
          description: 'current proposal still COLLECTING (late evidence ignored)',
          check: (ctx) => expectSnapshotGate(ctx, 'inventory', (g) => g.status === 'COLLECTING' && !g.canApprove, 'late evidence')
        },
        // Approval of current candidate is refused (no fresh evidence).
        { kind: 'decide', proposalRef: 'new', expectedDigestRef: 'new', type: 'APPROVE', decidedBy: 'release-mgr' }
      ]
    },

    // 3) Freshness: passing evidence goes stale as logical time advances.
    {
      name: 'evidence-goes-stale-with-logical-time',
      steps: [
        { kind: 'registerSubject', subjectId: 'pricing', requiredConsumers: ['ledger'], freshnessWindowMs: 5_000 },
        { kind: 'submitCandidate', subjectId: 'pricing', baselineSchema: baseline, candidateSchema: compatibleCandidate, submittedBy: 'dev', as: 'p1' },
        { kind: 'report', reportId: 'r-ledger-1', subjectId: 'pricing', targetRef: 'p1', consumerId: 'ledger', verdict: 'PASS', producedAt: 0 },
        {
          kind: 'expect',
          description: 'fresh -> READY',
          check: (ctx) => expectSnapshotGate(ctx, 'pricing', (g) => g.status === 'READY', 'fresh')
        },
        // Advance past the freshness window without new evidence.
        { kind: 'advanceClock', deltaMs: 6_000 },
        {
          kind: 'expect',
          description: 'stale -> COLLECTING, approval blocked',
          check: (ctx) => expectSnapshotGate(ctx, 'pricing', (g) => g.status === 'COLLECTING' && !g.canApprove, 'stale')
        }
      ]
    },

    // 4) Unknown consumer's evidence never pollutes the gate.
    {
      name: 'unknown-consumer-evidence-is-not-counted',
      steps: [
        { kind: 'registerSubject', subjectId: 'shipping', requiredConsumers: ['carrier'], freshnessWindowMs: 10_000 },
        { kind: 'submitCandidate', subjectId: 'shipping', baselineSchema: baseline, candidateSchema: compatibleCandidate, submittedBy: 'dev', as: 's1' },
        // A rogue/unknown consumer passes — must be ignored.
        { kind: 'report', reportId: 'r-rogue-1', subjectId: 'shipping', targetRef: 's1', consumerId: 'not-a-consumer', verdict: 'PASS', producedAt: 0 },
        {
          kind: 'expect',
          description: 'still COLLECTING (unknown consumer ignored)',
          check: (ctx) => expectSnapshotGate(ctx, 'shipping', (g) => g.status === 'COLLECTING', 'unknown consumer')
        }
      ]
    },

    // 5) Concurrent decisions: only one wins; no two contradictory conclusions.
    {
      name: 'concurrent-approvals-yield-single-conclusion',
      steps: [
        { kind: 'registerSubject', subjectId: 'catalog', requiredConsumers: ['ui'], freshnessWindowMs: 10_000 },
        { kind: 'submitCandidate', subjectId: 'catalog', baselineSchema: baseline, candidateSchema: compatibleCandidate, submittedBy: 'dev', as: 'k1' },
        { kind: 'report', reportId: 'r-ui-1', subjectId: 'catalog', targetRef: 'k1', consumerId: 'ui', verdict: 'PASS', producedAt: 0 },
        {
          kind: 'decide',
          proposalRef: 'k1',
          expectedDigestRef: 'k1',
          type: 'APPROVE',
          decidedBy: 'mgr-A',
          concurrentWith: { decidedBy: 'mgr-B', type: 'REJECT' }
        },
        {
          kind: 'expect',
          description: 'exactly one decision persisted',
          check: async (ctx) => {
            const c = ctx.candidates.get('k1')!;
            const view = await ctx.client.getProposal(c.proposalId);
            if (!['APPROVED', 'REJECTED'].includes(view.body.proposal.state)) {
              throw new Error(`expected terminal state, got ${view.body.proposal.state}`);
            }
            if (!view.body.decision) throw new Error('no decision persisted');
          }
        }
      ]
    },

    // 6) Crash after write, before reply: retry reconciles to one effect.
    {
      name: 'crash-after-write-then-retry-is-idempotent',
      steps: [
        { kind: 'registerSubject', subjectId: 'accounts', requiredConsumers: ['auth'], freshnessWindowMs: 10_000 },
        { kind: 'submitCandidate', subjectId: 'accounts', baselineSchema: baseline, candidateSchema: compatibleCandidate, submittedBy: 'dev', as: 'a1' },
        // First delivery crashes AFTER the row is written (503). The retry
        // (repeat=2) is the second delivery and returns DUPLICATE.
        { kind: 'report', reportId: 'r-auth-1', subjectId: 'accounts', targetRef: 'a1', consumerId: 'auth', verdict: 'PASS', producedAt: 0, crashAfterWrite: true, repeat: 2 },
        {
          kind: 'expect',
          description: 'evidence applied exactly once -> READY',
          check: (ctx) => expectSnapshotGate(ctx, 'accounts', (g) => g.status === 'READY', 'crash retry')
        }
      ]
    },

    // 7) Time-limited, dual-controlled waiver for an offline consumer, driven
    //    entirely on the logical clock: request -> confirm -> READY via WAIVED
    //    -> approve -> the waiver later expires but the frozen decision stands.
    {
      name: 'dual-controlled-waiver-covers-offline-consumer-then-expires',
      steps: [
        { kind: 'registerSubject', subjectId: 'billing-svc', requiredConsumers: ['gateway', 'reporting'], freshnessWindowMs: 10_000 },
        { kind: 'submitCandidate', subjectId: 'billing-svc', baselineSchema: baseline, candidateSchema: compatibleCandidate, submittedBy: 'dev', as: 'w1' },
        // Only one consumer reports; 'reporting' is temporarily offline.
        { kind: 'report', reportId: 'r-gw-1', subjectId: 'billing-svc', targetRef: 'w1', consumerId: 'gateway', verdict: 'PASS', producedAt: 0 },
        {
          kind: 'expect',
          description: 'blocked: reporting is MISSING',
          check: (ctx) => expectSnapshotGate(ctx, 'billing-svc', (g) => g.status === 'COLLECTING' && !g.canApprove, 'pre-waiver')
        },
        // One reviewer applies for a scoped, 5s waiver.
        {
          kind: 'requestWaiver', as: 'wv', subjectId: 'billing-svc', candidateRef: 'w1',
          consumerId: 'reporting', compatDirection: 'COMPATIBLE', reason: 'reporting offline in window',
          requestedBy: 'alice', ttlMs: 5_000
        },
        {
          kind: 'expect',
          description: 'still blocked while waiver only REQUESTED',
          check: (ctx) => expectSnapshotGate(ctx, 'billing-svc', (g) => g.status === 'COLLECTING', 'requested-not-active')
        },
        // Same reviewer cannot confirm — dual control (expect DENIED).
        { kind: 'confirmWaiver', waiverRef: 'wv', confirmedBy: 'alice' },
        // A distinct reviewer confirms -> ACTIVE.
        { kind: 'confirmWaiver', waiverRef: 'wv', confirmedBy: 'bob' },
        {
          kind: 'expect',
          description: 'READY: reporting is WAIVED',
          check: (ctx) =>
            expectSnapshotGate(
              ctx,
              'billing-svc',
              (g) => g.status === 'READY' && g.canApprove && g.consumers.find((c: any) => c.consumerId === 'reporting')?.status === 'WAIVED',
              'active-waiver'
            )
        },
        { kind: 'decide', proposalRef: 'w1', expectedDigestRef: 'w1', useCurrentFingerprint: true, type: 'APPROVE', decidedBy: 'release-mgr' },
        {
          kind: 'expect',
          description: 'approved, snapshot records the applied waiver',
          check: async (ctx) => {
            const c = ctx.candidates.get('w1')!;
            const view = await ctx.client.getProposal(c.proposalId);
            if (view.body.proposal.state !== 'APPROVED') throw new Error('expected APPROVED');
            const applied = view.body.decision?.gateSnapshot?.appliedWaivers ?? [];
            if (applied.length !== 1) throw new Error('decision snapshot should record the applied waiver');
          }
        },
        // Advance past the TTL: the waiver expires, but the decision is frozen.
        { kind: 'advanceClock', deltaMs: 6_000 },
        {
          kind: 'expect',
          description: 'waiver expired but historical decision unchanged',
          check: async (ctx) => {
            const c = ctx.candidates.get('w1')!;
            const view = await ctx.client.getProposal(c.proposalId);
            if (view.body.proposal.state !== 'APPROVED') throw new Error('decision must remain APPROVED');
            const applied = view.body.decision?.gateSnapshot?.appliedWaivers ?? [];
            if (applied.length !== 1) throw new Error('frozen snapshot must still list the waiver it relied on');
            const wv = ctx.waivers.get('wv')!;
            const w = await ctx.client.getWaiver(wv);
            if (w.body.status !== 'EXPIRED') throw new Error(`waiver should be EXPIRED, was ${w.body.status}`);
          }
        }
      ]
    },

    // 8) A waiver can never mask a real FAIL.
    {
      name: 'waiver-cannot-mask-a-fail',
      steps: [
        { kind: 'registerSubject', subjectId: 'risk-svc', requiredConsumers: ['scorer'], freshnessWindowMs: 10_000 },
        { kind: 'submitCandidate', subjectId: 'risk-svc', baselineSchema: baseline, candidateSchema: compatibleCandidate, submittedBy: 'dev', as: 'f1' },
        { kind: 'report', reportId: 'r-scorer-1', subjectId: 'risk-svc', targetRef: 'f1', consumerId: 'scorer', verdict: 'FAIL', producedAt: 0, detail: 'schema breaks parser' },
        {
          kind: 'requestWaiver', as: 'fw', subjectId: 'risk-svc', candidateRef: 'f1',
          consumerId: 'scorer', compatDirection: 'COMPATIBLE', reason: 'attempt to bypass fail',
          requestedBy: 'alice', ttlMs: 5_000
        },
        { kind: 'confirmWaiver', waiverRef: 'fw', confirmedBy: 'bob' },
        {
          kind: 'expect',
          description: 'still BLOCKED — a FAIL is never waived',
          check: (ctx) => expectSnapshotGate(ctx, 'risk-svc', (g) => g.status === 'BLOCKED' && !g.canApprove, 'fail-not-waived')
        }
      ]
    },

    // 9) Successor proposal: upstream corrects the candidate mid-wait. New
    //    digest, no inherited evidence, prior waiver lapses by scope, and a
    //    concurrent late result for the old candidate cannot release the
    //    successor.
    {
      name: 'successor-proposal-does-not-inherit-evidence-or-waivers',
      steps: [
        { kind: 'registerSubject', subjectId: 'payments', requiredConsumers: ['ledger', 'audit'], freshnessWindowMs: 10_000_000 },
        { kind: 'submitCandidate', subjectId: 'payments', baselineSchema: baseline, candidateSchema: compatibleCandidate, submittedBy: 'dev', as: 'v1' },
        // v1: ledger passes; audit is offline, covered by a dual-confirmed waiver.
        { kind: 'report', reportId: 'r-ledger-v1', subjectId: 'payments', targetRef: 'v1', consumerId: 'ledger', verdict: 'PASS', producedAt: 0 },
        {
          kind: 'requestWaiver', as: 'wv1', subjectId: 'payments', candidateRef: 'v1',
          consumerId: 'audit', compatDirection: 'COMPATIBLE', reason: 'audit offline', requestedBy: 'alice', ttlMs: 100_000
        },
        { kind: 'confirmWaiver', waiverRef: 'wv1', confirmedBy: 'bob' },
        {
          kind: 'expect',
          description: 'v1 READY (audit WAIVED)',
          check: (ctx) => expectSnapshotGate(ctx, 'payments', (g) => g.status === 'READY', 'v1-ready')
        },
        // Upstream corrects the candidate -> successor v2 (new digest).
        { kind: 'submitCandidate', subjectId: 'payments', baselineSchema: baseline, candidateSchema: correctedCandidate, submittedBy: 'dev', as: 'v2', expectedPredecessorRef: 'v1' },
        {
          kind: 'expect',
          description: 'v2 is the current candidate, COLLECTING with no inherited evidence, and v1 waiver lapsed',
          check: async (ctx) => {
            const c1 = ctx.candidates.get('v1')!;
            const c2 = ctx.candidates.get('v2')!;
            if (c1.digest === c2.digest) throw new Error('successor must have a new digest');
            const snap = await ctx.client.snapshot();
            const subj = snap.body.subjects.find((s: any) => s.subject.subjectId === 'payments');
            if (subj.current.proposal.proposalId !== c2.proposalId) throw new Error('v2 should be current');
            if (subj.current.gate.status !== 'COLLECTING') throw new Error(`v2 should be COLLECTING, was ${subj.current.gate.status}`);
            if (subj.current.gate.consumers.some((x: any) => x.status === 'WAIVED')) throw new Error('successor must not inherit a waiver');
            if (subj.current.lineage.predecessorId !== c1.proposalId) throw new Error('v2 lineage must point at v1');
            const wv = await ctx.client.getWaiver(ctx.waivers.get('wv1')!);
            if (wv.body.status !== 'LAPSED') throw new Error(`v1 waiver should be LAPSED, was ${wv.body.status}`);
          }
        },
        // A late/concurrent result for the OLD candidate arrives after replacement.
        { kind: 'report', reportId: 'r-audit-v1-late', subjectId: 'payments', targetRef: 'v1', consumerId: 'audit', verdict: 'PASS', producedAt: 0 },
        {
          kind: 'expect',
          description: 'late old result is ignored and does not release the successor',
          check: (ctx) => expectSnapshotGate(ctx, 'payments', (g) => g.status === 'COLLECTING' && !g.canApprove, 'old-result-ignored')
        }
      ]
    },

    // 10) Staged rollout of an approved candidate: continuous waves advanced
    //     only by receipts bound to the decision snapshot and the live wave
    //     attempt. Covers duplicate + reordered + fingerprint-mismatched
    //     receipts (all inert), a crash-after-write receipt (idempotent retry),
    //     a dropped receipt, pause/resume, a failed wave + retry, then a
    //     rollback to the prior known-good version that leaves the contract
    //     decision and any lapsed waiver untouched.
    {
      name: 'staged-rollout-receipts-bound-to-decision-with-pause-retry-rollback',
      steps: [
        { kind: 'registerSubject', subjectId: 'checkout', requiredConsumers: ['cart'], freshnessWindowMs: 10_000_000 },
        // First release v1 and approve it — this is the "prior known-good".
        { kind: 'submitCandidate', subjectId: 'checkout', baselineSchema: baseline, candidateSchema: compatibleCandidate, submittedBy: 'dev', as: 'v1' },
        { kind: 'report', reportId: 'ck-cart-v1', subjectId: 'checkout', targetRef: 'v1', consumerId: 'cart', verdict: 'PASS', producedAt: 0 },
        { kind: 'decide', proposalRef: 'v1', expectedDigestRef: 'v1', useCurrentFingerprint: true, type: 'APPROVE', decidedBy: 'release-mgr', as: 'd-v1' },
        // Fully roll out v1 so it becomes a completed, known-good deployment.
        { kind: 'createRollout', as: 'ro-v1', decisionRef: 'd-v1', waves: ['canary', 'full'], createdBy: 'release-mgr' },
        { kind: 'startWave', rolloutRef: 'ro-v1' },
        { kind: 'reportReceipt', receiptId: 'rc-v1-canary', rolloutRef: 'ro-v1', waveIndex: 0, attempt: 1, result: 'SUCCESS' },
        { kind: 'startWave', rolloutRef: 'ro-v1' },
        { kind: 'reportReceipt', receiptId: 'rc-v1-full', rolloutRef: 'ro-v1', waveIndex: 1, attempt: 1, result: 'SUCCESS' },
        {
          kind: 'expect',
          description: 'v1 rollout COMPLETED',
          check: async (ctx) => {
            const ro = ctx.rollouts.get('ro-v1')!;
            const r = await ctx.client.getRollout(ro.rolloutId);
            if (r.body.rollout.status !== 'COMPLETED') throw new Error(`expected COMPLETED, got ${r.body.rollout.status}`);
          }
        },

        // Now v2 is submitted (v1 is already approved/closed) and approved; roll it out with 3 waves.
        { kind: 'submitCandidate', subjectId: 'checkout', baselineSchema: baseline, candidateSchema: correctedCandidate, submittedBy: 'dev', as: 'v2' },
        { kind: 'report', reportId: 'ck-cart-v2', subjectId: 'checkout', targetRef: 'v2', consumerId: 'cart', verdict: 'PASS', producedAt: 0 },
        { kind: 'decide', proposalRef: 'v2', expectedDigestRef: 'v2', useCurrentFingerprint: true, type: 'APPROVE', decidedBy: 'release-mgr', as: 'd-v2' },
        { kind: 'createRollout', as: 'ro', decisionRef: 'd-v2', waves: ['canary', 'half', 'full'], createdBy: 'release-mgr' },

        // Wave 0 (canary). A receipt bound to v1's fingerprint must be ignored;
        // a duplicate delivery of the good receipt must apply exactly once.
        { kind: 'startWave', rolloutRef: 'ro' },
        {
          kind: 'expect',
          description: 'a receipt with a mismatched (v1) fingerprint does not advance the v2 rollout',
          check: async (ctx) => {
            const roV1 = ctx.rollouts.get('ro-v1')!;
            const r = await ctx.client.reportReceipt({
              receiptId: 'rc-mismatch',
              rolloutId: ctx.rollouts.get('ro')!.rolloutId,
              waveId: ctx.rollouts.get('ro')!.waveIds[0],
              attempt: 1,
              result: 'SUCCESS',
              evidenceFingerprint: roV1.fingerprint // wrong snapshot
            });
            if (r.body.status !== 'IGNORED') throw new Error(`mismatched receipt should be IGNORED, was ${r.body.status}`);
            const detail = await ctx.client.getRollout(ctx.rollouts.get('ro')!.rolloutId);
            const canary = detail.body.waves.find((w: any) => w.ordinal === 1);
            if (canary.status !== 'IN_PROGRESS') throw new Error('canary must still be IN_PROGRESS after a mismatched receipt');
          }
        },
        // Reordered/stale receipt for a future attempt (attempt 2 before any
        // retry) is inert; then the correct receipt, delivered twice, applies once.
        { kind: 'reportReceipt', receiptId: 'rc-stale-attempt', rolloutRef: 'ro', waveIndex: 0, attempt: 2, result: 'SUCCESS' },
        { kind: 'reportReceipt', receiptId: 'rc-canary', rolloutRef: 'ro', waveIndex: 0, attempt: 1, result: 'SUCCESS', repeat: 2 },
        {
          kind: 'expect',
          description: 'canary SUCCEEDED once; stale/mismatch receipts recorded but not applied',
          check: async (ctx) => {
            const ro = ctx.rollouts.get('ro')!;
            const r = await ctx.client.getRollout(ro.rolloutId);
            const canary = r.body.waves.find((w: any) => w.ordinal === 1);
            if (canary.status !== 'SUCCEEDED') throw new Error(`canary should be SUCCEEDED, was ${canary.status}`);
            const applied = r.body.receipts.filter((x: any) => x.applied).length;
            if (applied !== 1) throw new Error(`exactly one receipt should have applied, got ${applied}`);
          }
        },

        // Wave 1 (half): pause mid-flight — a receipt during pause is ignored;
        // resume, then a crash-after-write receipt reconciles idempotently.
        { kind: 'startWave', rolloutRef: 'ro' },
        { kind: 'pauseRollout', rolloutRef: 'ro' },
        { kind: 'reportReceipt', receiptId: 'rc-during-pause', rolloutRef: 'ro', waveIndex: 1, attempt: 1, result: 'SUCCESS' },
        {
          kind: 'expect',
          description: 'receipt during pause is ignored; half still IN_PROGRESS',
          check: async (ctx) => {
            const ro = ctx.rollouts.get('ro')!;
            const r = await ctx.client.getRollout(ro.rolloutId);
            const half = r.body.waves.find((w: any) => w.ordinal === 2);
            if (half.status !== 'IN_PROGRESS') throw new Error('half must remain IN_PROGRESS through a pause');
          }
        },
        { kind: 'resumeRollout', rolloutRef: 'ro' },
        // Crash after durable write, before reply; the retry (repeat=2) sees the
        // receipt already applied and reconciles as DUPLICATE — one effect.
        { kind: 'reportReceipt', receiptId: 'rc-half', rolloutRef: 'ro', waveIndex: 1, attempt: 1, result: 'SUCCESS', crashAfterWrite: true, repeat: 2 },
        {
          kind: 'expect',
          description: 'half SUCCEEDED exactly once after crash+retry',
          check: async (ctx) => {
            const ro = ctx.rollouts.get('ro')!;
            const r = await ctx.client.getRollout(ro.rolloutId);
            const half = r.body.waves.find((w: any) => w.ordinal === 2);
            if (half.status !== 'SUCCEEDED') throw new Error(`half should be SUCCEEDED, was ${half.status}`);
          }
        },

        // Wave 2 (full): a FAILURE fails the wave; retry bumps the attempt so a
        // late duplicate of the failed attempt is stale, then a dropped receipt,
        // then a definitive SUCCESS on the live attempt.
        { kind: 'startWave', rolloutRef: 'ro' },
        { kind: 'reportReceipt', receiptId: 'rc-full-fail', rolloutRef: 'ro', waveIndex: 2, attempt: 1, result: 'FAILURE', detail: 'deploy error' },
        {
          kind: 'expect',
          description: 'full FAILED, rollout FAILED',
          check: async (ctx) => {
            const ro = ctx.rollouts.get('ro')!;
            const r = await ctx.client.getRollout(ro.rolloutId);
            if (r.body.rollout.status !== 'FAILED') throw new Error(`rollout should be FAILED, was ${r.body.rollout.status}`);
          }
        },
        { kind: 'retryWave', rolloutRef: 'ro', waveIndex: 2 },
        // A late duplicate for the old (attempt 1) is now stale by attempt.
        { kind: 'reportReceipt', receiptId: 'rc-full-fail-late', rolloutRef: 'ro', waveIndex: 2, attempt: 1, result: 'SUCCESS' },
        // A dropped response: we send but ignore the reply; the server still
        // recorded it, so a later definitive receipt with a new id settles it.
        { kind: 'reportReceipt', receiptId: 'rc-full-unknown', rolloutRef: 'ro', waveIndex: 2, attempt: 2, result: 'UNKNOWN', dropResponse: true },
        { kind: 'reportReceipt', receiptId: 'rc-full-ok', rolloutRef: 'ro', waveIndex: 2, attempt: 2, result: 'SUCCESS' },
        {
          kind: 'expect',
          description: 'full SUCCEEDED on attempt 2; rollout COMPLETED; stale attempt-1 receipt inert',
          check: async (ctx) => {
            const ro = ctx.rollouts.get('ro')!;
            const r = await ctx.client.getRollout(ro.rolloutId);
            if (r.body.rollout.status !== 'COMPLETED') throw new Error(`rollout should be COMPLETED, was ${r.body.rollout.status}`);
            const full = r.body.waves.find((w: any) => w.ordinal === 3);
            if (full.attempt !== 2 || full.status !== 'SUCCEEDED') throw new Error('full should be SUCCEEDED on attempt 2');
            const staleApplied = r.body.receipts.find((x: any) => x.receiptId === 'rc-full-fail-late')?.applied;
            if (staleApplied) throw new Error('a stale attempt-1 receipt must not apply after retry');
          }
        },

        // Roll back checkout to the prior known-good v1 digest. Deployment only:
        // the v2 contract decision must remain APPROVED and unchanged, and no
        // lapsed/expired waiver is revived.
        { kind: 'rollback', as: 'rb', subjectId: 'checkout', targetRef: 'v1', waves: ['revert'], createdBy: 'release-mgr' },
        {
          kind: 'expect',
          description: 'rollback is a new ROLLBACK rollout to v1; v2 decision untouched',
          check: async (ctx) => {
            const rb = ctx.rollouts.get('rb')!;
            const r = await ctx.client.getRollout(rb.rolloutId);
            if (r.body.rollout.kind !== 'ROLLBACK') throw new Error('rollback must be a ROLLBACK rollout');
            const v1 = ctx.candidates.get('v1')!;
            if (r.body.rollout.candidateDigest !== v1.digest) throw new Error('rollback must target the v1 digest');
            // v2's contract decision is still APPROVED and unmodified.
            const v2 = ctx.candidates.get('v2')!;
            const view = await ctx.client.getProposal(v2.proposalId);
            if (view.body.proposal.state !== 'APPROVED') throw new Error('v2 decision must remain APPROVED after rollback');
          }
        }
      ]
    }
  ];
}

export { digestOf };
