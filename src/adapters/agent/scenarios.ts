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
    }
  ];
}

export { digestOf };
