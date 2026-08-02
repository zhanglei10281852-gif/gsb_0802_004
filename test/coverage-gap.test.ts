import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRepo, baselineSchema, compatibleCandidate } from './helpers.js';
import type { Repository } from '../src/storage/repository.js';

function setupApprovedProposal(
  repo: Repository,
  consumerIds: string[] = ['c1'],
): { proposalId: string; candidateHash: string; decisionId: string } {
  for (const id of consumerIds) {
    repo.registerConsumer(id, `Consumer ${id}`);
  }
  const { proposal } = repo.createProposal(compatibleCandidate, baselineSchema, 'production');
  for (const id of consumerIds) {
    const res = repo.submitEvidence({
      proposalId: proposal.id,
      consumerId: id,
      candidateHash: proposal.candidateHash,
      verdict: 'compatible',
      details: 'green',
      idempotencyKey: `ev-${id}`,
    });
    expect(res.accepted).toBe(true);
  }
  const decision = repo.decide(proposal.id, 'approve', 'gate ready');
  expect(decision.ok).toBe(true);
  if (!decision.ok) throw new Error('decision failed');
  return { proposalId: proposal.id, candidateHash: proposal.candidateHash, decisionId: decision.decision.id };
}

const threeWaves = [
  { sequence: 1, environment: 'canary' },
  { sequence: 2, environment: 'staging' },
  { sequence: 3, environment: 'production' },
];

describe('Coverage gaps during phased rollout', () => {
  let ctx: ReturnType<typeof createTestRepo>;

  beforeEach(() => {
    ctx = createTestRepo();
  });
  afterEach(() => ctx.cleanup());

  it('auto-pauses not-yet-started waves when a new consumer registers after the decision', () => {
    const { repo } = ctx;
    const { proposalId } = setupApprovedProposal(repo);
    const started = repo.startRollout(proposalId, threeWaves, 'v1.0.0');
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const rolloutId = started.rollout.id;
    expect(started.rollout.status).toBe('in_progress');
    expect(started.rollout.pauseReason).toBeNull();

    repo.reportReceipt({
      rolloutId,
      sequence: 1,
      result: 'success',
      adapterId: 'a1',
      idempotencyKey: 'w1',
    });

    const afterW1 = repo.getRollout(rolloutId)!;
    expect(afterW1.waves[0].status).toBe('succeeded');
    expect(afterW1.waves[1].status).toBe('in_progress');

    repo.registerConsumer('new-svc', 'New Service');

    const afterNewConsumer = repo.getRollout(rolloutId)!;
    expect(afterNewConsumer.status).toBe('paused');
    expect(afterNewConsumer.pauseReason).toBe('coverage_gap');
    expect(afterNewConsumer.coverageGaps).toHaveLength(1);
    expect(afterNewConsumer.coverageGaps[0].consumerId).toBe('new-svc');
    expect(afterNewConsumer.coverageGaps[0].status).toBe('open');
    expect(afterNewConsumer.waves[1].status).toBe('in_progress');

    const receiptForCurrent = repo.reportReceipt({
      rolloutId,
      sequence: 2,
      result: 'success',
      adapterId: 'a2',
      idempotencyKey: 'w2',
    });
    expect(receiptForCurrent.ok).toBe(true);
    if (receiptForCurrent.ok) {
      expect(receiptForCurrent.rollout.waves[1].status).toBe('succeeded');
      expect(receiptForCurrent.rollout.waves[2].status).toBe('pending');
      expect(receiptForCurrent.rollout.status).toBe('paused');
      expect(receiptForCurrent.rollout.pauseReason).toBe('coverage_gap');
    }

    const blocked = repo.reportReceipt({
      rolloutId,
      sequence: 3,
      result: 'success',
      adapterId: 'a3',
      idempotencyKey: 'w3',
    });
    expect(blocked.ok).toBe(false);
  });

  it('detects a coverage gap at rollout start if consumers registered after the decision', () => {
    const { repo } = ctx;
    const { proposalId } = setupApprovedProposal(repo);
    repo.registerConsumer('late-svc', 'Late Service');

    const started = repo.startRollout(proposalId, threeWaves, 'v1.0.0');
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.rollout.status).toBe('paused');
    expect(started.rollout.pauseReason).toBe('coverage_gap');
    expect(started.rollout.coverageGaps).toHaveLength(1);
    expect(started.rollout.coverageGaps[0].consumerId).toBe('late-svc');
    expect(started.rollout.waves[0].status).toBe('in_progress');
  });

  it('resolves a coverage gap with compatible re-verification and allows resume', () => {
    const { repo } = ctx;
    const { proposalId } = setupApprovedProposal(repo);
    const started = repo.startRollout(proposalId, threeWaves, null);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const rolloutId = started.rollout.id;

    repo.registerConsumer('new-svc', 'New Service');
    let rollout = repo.getRollout(rolloutId)!;
    expect(rollout.status).toBe('paused');
    expect(rollout.coverageGaps[0].status).toBe('open');

    const resumeBlocked = repo.resumeRollout(rolloutId);
    expect(resumeBlocked.ok).toBe(false);
    if (!resumeBlocked.ok) {
      expect(resumeBlocked.reason).toContain('coverage gap');
    }

    const verify = repo.submitVerification({
      rolloutId,
      consumerId: 'new-svc',
      verdict: 'compatible',
      details: 'verified against new schema',
      idempotencyKey: 'verify-1',
      adapterId: 'build-agent-new-svc',
    });
    expect(verify.ok).toBe(true);
    if (!verify.ok) return;
    expect(verify.gap.status).toBe('resolved_compatible');
    expect(verify.gap.verdict).toBe('compatible');
    expect(verify.duplicate).toBe(false);

    rollout = repo.getRollout(rolloutId)!;
    expect(rollout.coverageGaps[0].status).toBe('resolved_compatible');
    expect(rollout.status).toBe('paused');

    const resumed = repo.resumeRollout(rolloutId);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.rollout.status).toBe('in_progress');
    expect(resumed.rollout.pauseReason).toBeNull();
    expect(resumed.rollout.waves[0].status).toBe('in_progress');
  });

  it('halts the rollout when re-verification returns incompatible', () => {
    const { repo } = ctx;
    const { proposalId } = setupApprovedProposal(repo);
    const started = repo.startRollout(proposalId, threeWaves, null);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const rolloutId = started.rollout.id;

    repo.registerConsumer('new-svc', 'New Service');

    const verify = repo.submitVerification({
      rolloutId,
      consumerId: 'new-svc',
      verdict: 'incompatible',
      details: 'breaking change detected',
      idempotencyKey: 'verify-bad',
    });
    expect(verify.ok).toBe(true);
    if (!verify.ok) return;
    expect(verify.gap.status).toBe('resolved_incompatible');
    expect(verify.rollout.status).toBe('failed');
    expect(verify.rollout.pauseReason).toBeNull();

    const events = repo.listEvents().map((e) => e.type);
    expect(events).toContain('reverification_recorded');
    expect(events).toContain('coverage_gap_resolved');
    expect(events).toContain('rollout_failed');
  });

  it('dedupes repeated verification submissions by idempotency key', () => {
    const { repo } = ctx;
    const { proposalId } = setupApprovedProposal(repo);
    const started = repo.startRollout(proposalId, threeWaves, null);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const rolloutId = started.rollout.id;
    repo.registerConsumer('new-svc', 'New Service');

    const v1 = repo.submitVerification({
      rolloutId,
      consumerId: 'new-svc',
      verdict: 'compatible',
      details: 'ok',
      idempotencyKey: 'vkey-1',
    });
    expect(v1.ok).toBe(true);
    if (!v1.ok) return;
    expect(v1.duplicate).toBe(false);

    const v2 = repo.submitVerification({
      rolloutId,
      consumerId: 'new-svc',
      verdict: 'compatible',
      details: 'ok again',
      idempotencyKey: 'vkey-1',
    });
    expect(v2.ok).toBe(true);
    if (!v2.ok) return;
    expect(v2.duplicate).toBe(true);
    expect(v2.gap.id).toBe(v1.gap.id);

    const gaps = repo.getRollout(rolloutId)!.coverageGaps;
    expect(gaps).toHaveLength(1);
    expect(gaps[0].details).toBe('ok');
  });

  it('does not create a gap for consumers already in the decision snapshot', () => {
    const { repo } = ctx;
    const { proposalId } = setupApprovedProposal(repo, ['c1', 'c2']);
    const started = repo.startRollout(proposalId, threeWaves, null);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.rollout.coverageGaps).toHaveLength(0);

    repo.registerConsumer('c1', 'Duplicate');
    const after = repo.getRollout(started.rollout.id)!;
    expect(after.coverageGaps).toHaveLength(0);
    expect(after.status).toBe('in_progress');
  });

  it('leaves the immutable decision snapshot unchanged when a coverage gap is detected', () => {
    const { repo } = ctx;
    const { proposalId, decisionId } = setupApprovedProposal(repo);
    const started = repo.startRollout(proposalId, threeWaves, null);
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    repo.registerConsumer('new-svc', 'New Service');
    repo.submitVerification({
      rolloutId: started.rollout.id,
      consumerId: 'new-svc',
      verdict: 'incompatible',
      details: 'bad',
      idempotencyKey: 'v1',
    });

    const decision = repo.getDecision(proposalId)!;
    expect(decision.id).toBe(decisionId);
    expect(decision.decision).toBe('approved');
    expect(decision.snapshot.requiredConsumerIds).toEqual(['c1']);
    expect(decision.snapshot.requiredConsumerIds).not.toContain('new-svc');
    expect(decision.snapshot.gateReady).toBe(true);
  });

  it('handles concurrent receipt completion and topology change deterministically', () => {
    const { repo } = ctx;
    const { proposalId } = setupApprovedProposal(repo);
    const started = repo.startRollout(proposalId, threeWaves, null);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const rolloutId = started.rollout.id;

    const receipt = repo.reportReceipt({
      rolloutId,
      sequence: 1,
      result: 'success',
      adapterId: 'a1',
      idempotencyKey: 'w1-success',
    });
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    expect(receipt.rollout.waves[1].status).toBe('in_progress');

    repo.registerConsumer('new-svc', 'New Service');
    const afterGap = repo.getRollout(rolloutId)!;
    expect(afterGap.status).toBe('paused');
    expect(afterGap.pauseReason).toBe('coverage_gap');
    expect(afterGap.waves[1].status).toBe('in_progress');

    const inFlightReceipt = repo.reportReceipt({
      rolloutId,
      sequence: 2,
      result: 'success',
      adapterId: 'a2',
      idempotencyKey: 'w2-inflight',
    });
    expect(inFlightReceipt.ok).toBe(true);
    if (inFlightReceipt.ok) {
      expect(inFlightReceipt.rollout.waves[1].status).toBe('succeeded');
      expect(inFlightReceipt.rollout.waves[2].status).toBe('pending');
      expect(inFlightReceipt.rollout.status).toBe('paused');
    }

    const verify = repo.submitVerification({
      rolloutId,
      consumerId: 'new-svc',
      verdict: 'compatible',
      details: 'ok',
      idempotencyKey: 'v1',
    });
    expect(verify.ok).toBe(true);

    const resumed = repo.resumeRollout(rolloutId);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.rollout.waves[2].status).toBe('in_progress');

    const w3 = repo.reportReceipt({
      rolloutId,
      sequence: 3,
      result: 'success',
      adapterId: 'a3',
      idempotencyKey: 'w3-success',
    });
    expect(w3.ok).toBe(true);
    if (!w3.ok) return;
    expect(w3.rollout.waves[2].status).toBe('succeeded');
    expect(w3.rollout.status).toBe('succeeded');
  });

  it('records coverage gap events in the causal chain linked to the proposal lineage', () => {
    const { repo } = ctx;
    const { proposalId } = setupApprovedProposal(repo);
    const started = repo.startRollout(proposalId, threeWaves, null);
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    repo.registerConsumer('new-svc', 'New Service');
    repo.submitVerification({
      rolloutId: started.rollout.id,
      consumerId: 'new-svc',
      verdict: 'compatible',
      details: 'ok',
      idempotencyKey: 'v1',
    });

    const events = repo.listEvents();
    const gapDetected = events.find((e) => e.type === 'coverage_gap_detected');
    expect(gapDetected).toBeDefined();
    expect(gapDetected!.payload.proposalId).toBe(proposalId);
    expect(gapDetected!.payload.consumerId).toBe('new-svc');

    const autoPaused = events.find((e) => e.type === 'rollout_auto_paused_coverage');
    expect(autoPaused).toBeDefined();
    expect(autoPaused!.payload.proposalId).toBe(proposalId);

    const reverified = events.find((e) => e.type === 'reverification_recorded');
    expect(reverified).toBeDefined();
    expect(reverified!.payload.proposalId).toBe(proposalId);
    expect(reverified!.payload.verdict).toBe('compatible');

    const resolved = events.find((e) => e.type === 'coverage_gap_resolved');
    expect(resolved).toBeDefined();
  });

  it('rollback does not clear or alter coverage gap records', () => {
    const { repo } = ctx;
    const { proposalId } = setupApprovedProposal(repo);
    const started = repo.startRollout(proposalId, threeWaves, null);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const rolloutId = started.rollout.id;

    repo.registerConsumer('new-svc', 'New Service');
    const gapId = repo.getRollout(rolloutId)!.coverageGaps[0].id;

    const rb = repo.rollback(rolloutId, 'v1.0.0', 'regression');
    expect(rb.ok).toBe(true);
    if (!rb.ok) return;

    const after = repo.getRollout(rolloutId)!;
    expect(after.status).toBe('rolled_back');
    expect(after.pauseReason).toBeNull();
    expect(after.coverageGaps).toHaveLength(1);
    expect(after.coverageGaps[0].id).toBe(gapId);
    expect(after.coverageGaps[0].status).toBe('open');
  });
});
