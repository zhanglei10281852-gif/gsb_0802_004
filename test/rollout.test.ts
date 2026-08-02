import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRepo, baselineSchema, compatibleCandidate } from './helpers.js';
import { Repository } from '../src/storage/repository.js';
import { openDatabase } from '../src/storage/database.js';
import { VirtualClock } from '../src/domain/clock.js';
import type { Proposal, Decision } from '../src/domain/types.js';

function setupApprovedProposal(
  repo: Repository,
  consumerIds: string[] = ['c1'],
  environment = 'production',
): { proposal: Proposal; decision: Decision } {
  for (const id of consumerIds) {
    repo.registerConsumer(id, `Consumer ${id}`);
  }
  const { proposal } = repo.createProposal(compatibleCandidate, baselineSchema, environment);
  for (const id of consumerIds) {
    const res = repo.submitEvidence({
      proposalId: proposal.id,
      consumerId: id,
      candidateHash: proposal.candidateHash,
      verdict: 'compatible',
      details: 'build green',
      idempotencyKey: `key-${id}`,
    });
    expect(res.accepted).toBe(true);
  }
  const decision = repo.decide(proposal.id, 'approve', 'gate ready');
  expect(decision.ok).toBe(true);
  if (!decision.ok) throw new Error('failed to approve proposal');
  return { proposal, decision: decision.decision };
}

const threeWaves = [
  { sequence: 1, environment: 'canary' },
  { sequence: 2, environment: 'staging' },
  { sequence: 3, environment: 'production' },
];

describe('Phased rollout', () => {
  let ctx: ReturnType<typeof createTestRepo>;

  beforeEach(() => {
    ctx = createTestRepo();
  });
  afterEach(() => ctx.cleanup());

  it('starts a rollout with the first wave in progress and remaining waves pending', () => {
    const { repo } = ctx;
    const { proposal, decision } = setupApprovedProposal(repo);
    const res = repo.startRollout(proposal.id, threeWaves, 'v1.2.3');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const rollout = res.rollout;
    expect(rollout.status).toBe('in_progress');
    expect(rollout.proposalId).toBe(proposal.id);
    expect(rollout.candidateHash).toBe(proposal.candidateHash);
    expect(rollout.decisionId).toBe(decision.id);
    expect(rollout.previousVersion).toBe('v1.2.3');
    expect(rollout.waves).toHaveLength(3);
    expect(rollout.waves[0].status).toBe('in_progress');
    expect(rollout.waves[0].environment).toBe('canary');
    expect(rollout.waves[1].status).toBe('pending');
    expect(rollout.waves[2].status).toBe('pending');
    expect(rollout.waves.every((w) => w.attempts === 0)).toBe(true);

    const detail = repo.getProposalDetail(proposal.id)!;
    expect(detail.rollout?.id).toBe(rollout.id);
  });

  it('rejects starting a rollout for a proposal that is not approved', () => {
    const { repo } = ctx;
    repo.registerConsumer('c1', 'Consumer 1');
    const { proposal } = repo.createProposal(compatibleCandidate, baselineSchema);
    const res = repo.startRollout(proposal.id, threeWaves, null);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('approved');
  });

  it('rejects a second rollout for the same proposal', () => {
    const { repo } = ctx;
    const { proposal } = setupApprovedProposal(repo);
    repo.startRollout(proposal.id, threeWaves, null);
    const again = repo.startRollout(proposal.id, threeWaves, null);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toContain('already exists');
  });

  it('rejects wave specs with gaps or duplicate sequences', () => {
    const { repo } = ctx;
    const { proposal } = setupApprovedProposal(repo);
    const gap = repo.startRollout(
      proposal.id,
      [
        { sequence: 1, environment: 'canary' },
        { sequence: 3, environment: 'production' },
      ],
      null,
    );
    expect(gap.ok).toBe(false);

    const dup = repo.startRollout(
      proposal.id,
      [
        { sequence: 1, environment: 'canary' },
        { sequence: 1, environment: 'staging' },
      ],
      null,
    );
    expect(dup.ok).toBe(false);
  });

  it('advances waves on success and completes the rollout on the final wave', () => {
    const { repo } = ctx;
    const { proposal } = setupApprovedProposal(repo);
    const started = repo.startRollout(proposal.id, threeWaves, null);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const rolloutId = started.rollout.id;

    const r1 = repo.reportReceipt({
      rolloutId,
      sequence: 1,
      result: 'success',
      adapterId: 'adapter-1',
      idempotencyKey: 'rcpt-1',
      message: 'canary ok',
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.duplicate).toBe(false);
    expect(r1.receipt.candidateHash).toBe(proposal.candidateHash);
    expect(r1.receipt.decisionId).toBe(started.rollout.decisionId);
    expect(r1.rollout.waves[0].status).toBe('succeeded');
    expect(r1.rollout.waves[1].status).toBe('in_progress');
    expect(r1.rollout.status).toBe('in_progress');

    const r2 = repo.reportReceipt({
      rolloutId,
      sequence: 2,
      result: 'success',
      adapterId: 'adapter-2',
      idempotencyKey: 'rcpt-2',
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.rollout.waves[1].status).toBe('succeeded');
    expect(r2.rollout.waves[2].status).toBe('in_progress');

    const r3 = repo.reportReceipt({
      rolloutId,
      sequence: 3,
      result: 'success',
      adapterId: 'adapter-3',
      idempotencyKey: 'rcpt-3',
    });
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;
    expect(r3.rollout.waves[2].status).toBe('succeeded');
    expect(r3.rollout.status).toBe('succeeded');
    expect(r3.rollout.waves.every((w) => w.status === 'succeeded')).toBe(true);
  });

  it('dedupes a repeated receipt with the same idempotency key without advancing or incrementing attempts', () => {
    const { repo } = ctx;
    const { proposal } = setupApprovedProposal(repo);
    const started = repo.startRollout(proposal.id, threeWaves, null);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const wave1 = started.rollout.waves[0];

    const first = repo.reportReceipt({
      rolloutId: started.rollout.id,
      sequence: 1,
      result: 'success',
      adapterId: 'adapter-1',
      idempotencyKey: 'same-key',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.duplicate).toBe(false);
    expect(first.rollout.waves[0].attempts).toBe(1);

    const dup = repo.reportReceipt({
      rolloutId: started.rollout.id,
      sequence: 1,
      result: 'success',
      adapterId: 'adapter-1',
      idempotencyKey: 'same-key',
    });
    expect(dup.ok).toBe(true);
    if (!dup.ok) return;
    expect(dup.duplicate).toBe(true);
    expect(dup.receipt.id).toBe(first.receipt.id);
    expect(dup.rollout.waves[0].attempts).toBe(1);

    const receipts = repo.listReceipts(wave1.id);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].idempotencyKey).toBe('same-key');

    const after = repo.getRollout(started.rollout.id)!;
    expect(after.waves[0].status).toBe('succeeded');
    expect(after.waves[1].status).toBe('in_progress');
  });

  it('rejects an out-of-order receipt targeting a wave that is not current', () => {
    const { repo } = ctx;
    const { proposal } = setupApprovedProposal(repo);
    const started = repo.startRollout(proposal.id, threeWaves, null);
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const future = repo.reportReceipt({
      rolloutId: started.rollout.id,
      sequence: 2,
      result: 'success',
      adapterId: 'adapter-2',
      idempotencyKey: 'too-early',
    });
    expect(future.ok).toBe(false);
    if (!future.ok) expect(future.reason).toContain('current');

    repo.reportReceipt({
      rolloutId: started.rollout.id,
      sequence: 1,
      result: 'success',
      adapterId: 'adapter-1',
      idempotencyKey: 'rcpt-1',
    });

    const past = repo.reportReceipt({
      rolloutId: started.rollout.id,
      sequence: 1,
      result: 'success',
      adapterId: 'adapter-1',
      idempotencyKey: 'already-done',
    });
    expect(past.ok).toBe(false);
    if (!past.ok) expect(past.reason).toContain('succeeded');
  });

  it('halts the rollout on failure and allows retrying the failed wave', () => {
    const { repo } = ctx;
    const { proposal } = setupApprovedProposal(repo);
    const started = repo.startRollout(proposal.id, threeWaves, null);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const rolloutId = started.rollout.id;

    const fail = repo.reportReceipt({
      rolloutId,
      sequence: 1,
      result: 'failure',
      adapterId: 'adapter-1',
      idempotencyKey: 'fail-1',
      message: 'deploy crashed',
    });
    expect(fail.ok).toBe(true);
    if (!fail.ok) return;
    expect(fail.rollout.waves[0].status).toBe('failed');
    expect(fail.rollout.waves[0].lastResult).toBe('failure');
    expect(fail.rollout.status).toBe('failed');

    const retry = repo.retryWave(rolloutId, 1);
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.rollout.waves[0].status).toBe('in_progress');
    expect(retry.rollout.status).toBe('in_progress');

    const retryBad = repo.retryWave(rolloutId, 2);
    expect(retryBad.ok).toBe(false);

    const success = repo.reportReceipt({
      rolloutId,
      sequence: 1,
      result: 'success',
      adapterId: 'adapter-1',
      idempotencyKey: 'retry-success',
    });
    expect(success.ok).toBe(true);
    if (success.ok) {
      expect(success.rollout.waves[0].status).toBe('succeeded');
      expect(success.rollout.waves[1].status).toBe('in_progress');
      expect(success.rollout.waves[0].attempts).toBe(2);
    }
  });

  it('records an unknown receipt without advancing the wave', () => {
    const { repo } = ctx;
    const { proposal } = setupApprovedProposal(repo);
    const started = repo.startRollout(proposal.id, threeWaves, null);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const wave1 = started.rollout.waves[0];

    const unknown = repo.reportReceipt({
      rolloutId: started.rollout.id,
      sequence: 1,
      result: 'unknown',
      adapterId: 'adapter-1',
      idempotencyKey: 'unknown-1',
      message: 'adapter lost contact',
    });
    expect(unknown.ok).toBe(true);
    if (!unknown.ok) return;
    expect(unknown.rollout.waves[0].status).toBe('in_progress');
    expect(unknown.rollout.waves[0].lastResult).toBe('unknown');
    expect(unknown.rollout.waves[0].attempts).toBe(1);
    expect(unknown.rollout.status).toBe('in_progress');
    expect(repo.listReceipts(wave1.id)).toHaveLength(1);

    const followup = repo.reportReceipt({
      rolloutId: started.rollout.id,
      sequence: 1,
      result: 'success',
      adapterId: 'adapter-1',
      idempotencyKey: 'after-unknown',
    });
    expect(followup.ok).toBe(true);
    if (followup.ok) expect(followup.rollout.waves[0].status).toBe('succeeded');
  });

  it('supports pause and resume of an in-progress rollout', () => {
    const { repo } = ctx;
    const { proposal } = setupApprovedProposal(repo);
    const started = repo.startRollout(proposal.id, threeWaves, null);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const rolloutId = started.rollout.id;

    const paused = repo.pauseRollout(rolloutId, 'investigate canary metrics');
    expect(paused.ok).toBe(true);
    if (!paused.ok) return;
    expect(paused.rollout.status).toBe('paused');
    expect(paused.rollout.waves[0].status).toBe('paused');

    const pauseAgain = repo.pauseRollout(rolloutId, 'nope');
    expect(pauseAgain.ok).toBe(false);

    const receiptWhilePaused = repo.reportReceipt({
      rolloutId,
      sequence: 1,
      result: 'success',
      adapterId: 'adapter-1',
      idempotencyKey: 'while-paused',
    });
    expect(receiptWhilePaused.ok).toBe(false);
    if (!receiptWhilePaused.ok) expect(receiptWhilePaused.reason).toContain('current');

    const resumed = repo.resumeRollout(rolloutId);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.rollout.status).toBe('in_progress');
    expect(resumed.rollout.waves[0].status).toBe('in_progress');

    const resumeAgain = repo.resumeRollout(rolloutId);
    expect(resumeAgain.ok).toBe(false);

    const done = repo.reportReceipt({
      rolloutId,
      sequence: 1,
      result: 'success',
      adapterId: 'adapter-1',
      idempotencyKey: 'post-resume',
    });
    expect(done.ok).toBe(true);
  });

  it('rolls back to a previous known version without altering the decision or reviving voided exemptions', () => {
    const { repo, clock } = ctx;
    repo.registerConsumer('c1', 'Consumer 1');
    const { proposal: parent } = repo.createProposal(compatibleCandidate, baselineSchema);
    const t = clock.now();
    const req = repo.requestExemption({
      candidateHash: parent.candidateHash,
      consumerId: 'c1',
      environment: 'production',
      direction: 'compatible',
      reason: 'offline during window',
      requesterId: 'alice',
      validFrom: t,
      validUntil: t + 100000,
    });
    expect(req.ok).toBe(true);
    if (!req.ok) return;
    repo.confirmExemption(req.exemption.id, 'bob');

    const successorRes = repo.createSuccessor(parent.id, {
      ...compatibleCandidate,
      properties: { ...compatibleCandidate.properties, extra: { type: 'string' } },
    });
    expect(successorRes.ok).toBe(true);
    if (!successorRes.ok) return;
    const successor = successorRes.successor;

    repo.submitEvidence({
      proposalId: successor.id,
      consumerId: 'c1',
      candidateHash: successor.candidateHash,
      verdict: 'compatible',
      details: 'green',
      idempotencyKey: 'succ-evidence',
    });
    const decisionRes = repo.decide(successor.id, 'approve', 'successor approved');
    expect(decisionRes.ok).toBe(true);
    if (!decisionRes.ok) return;
    const decisionId = decisionRes.decision.id;

    const oldExemptions = repo.listExemptions(parent.candidateHash);
    expect(oldExemptions.every((e) => e.status === 'voided')).toBe(true);

    const started = repo.startRollout(
      successor.id,
      [
        { sequence: 1, environment: 'canary' },
        { sequence: 2, environment: 'production' },
      ],
      'v9.0.0',
    );
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    repo.reportReceipt({
      rolloutId: started.rollout.id,
      sequence: 1,
      result: 'success',
      adapterId: 'a1',
      idempotencyKey: 'canary-done',
    });

    const rb = repo.rollback(started.rollout.id, 'v9.0.0', 'canary showed regression');
    expect(rb.ok).toBe(true);
    if (!rb.ok) return;
    expect(rb.rollout.status).toBe('rolled_back');
    expect(rb.rollout.rolledBackTo).toBe('v9.0.0');
    expect(rb.rollout.rolledBackAt).not.toBeNull();
    expect(rb.rollout.waves[0].status).toBe('succeeded');
    expect(rb.rollout.waves[1].status).toBe('rolled_back');

    const decisionAfter = repo.getDecision(successor.id)!;
    expect(decisionAfter.id).toBe(decisionId);
    expect(decisionAfter.decision).toBe('approved');
    expect(decisionAfter.snapshot.gateReady).toBe(true);

    const successorAfter = repo.getProposal(successor.id)!;
    expect(successorAfter.status).toBe('approved');

    const exemptionsAfter = repo.listExemptions(parent.candidateHash);
    expect(exemptionsAfter.every((e) => e.status === 'voided')).toBe(true);
    const successorExemptions = repo.listExemptions(successor.candidateHash);
    expect(successorExemptions).toHaveLength(0);

    const rollbackAgain = repo.rollback(started.rollout.id, 'v8.0.0', 'again');
    expect(rollbackAgain.ok).toBe(false);
  });

  it('rejects rollback of an already succeeded rollout', () => {
    const { repo } = ctx;
    const { proposal } = setupApprovedProposal(repo);
    const started = repo.startRollout(proposal.id, [{ sequence: 1, environment: 'canary' }], null);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    repo.reportReceipt({
      rolloutId: started.rollout.id,
      sequence: 1,
      result: 'success',
      adapterId: 'a1',
      idempotencyKey: 'done',
    });
    const after = repo.getRollout(started.rollout.id)!;
    expect(after.status).toBe('succeeded');
    const rb = repo.rollback(started.rollout.id, 'v0', 'nope');
    expect(rb.ok).toBe(false);
    if (!rb.ok) expect(rb.reason).toContain('completed');
  });

  it('binds every receipt to the same decision snapshot and candidate hash', () => {
    const { repo } = ctx;
    const { proposal, decision } = setupApprovedProposal(repo);
    const started = repo.startRollout(proposal.id, threeWaves, null);
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    repo.reportReceipt({
      rolloutId: started.rollout.id,
      sequence: 1,
      result: 'unknown',
      adapterId: 'a1',
      idempotencyKey: 'u1',
    });
    repo.reportReceipt({
      rolloutId: started.rollout.id,
      sequence: 1,
      result: 'success',
      adapterId: 'a1',
      idempotencyKey: 's1',
    });
    const wave1 = started.rollout.waves[0];
    const receipts = repo.listReceipts(wave1.id);
    expect(receipts).toHaveLength(2);
    for (const r of receipts) {
      expect(r.proposalId).toBe(proposal.id);
      expect(r.candidateHash).toBe(proposal.candidateHash);
      expect(r.decisionId).toBe(decision.id);
    }
  });

  it('records rollout lifecycle events in the causal chain', () => {
    const { repo } = ctx;
    const { proposal } = setupApprovedProposal(repo);
    const started = repo.startRollout(proposal.id, threeWaves, null);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const rolloutId = started.rollout.id;
    repo.reportReceipt({
      rolloutId,
      sequence: 1,
      result: 'failure',
      adapterId: 'a1',
      idempotencyKey: 'f',
    });
    repo.retryWave(rolloutId, 1);
    repo.pauseRollout(rolloutId, 'hold');
    repo.resumeRollout(rolloutId);
    repo.reportReceipt({
      rolloutId,
      sequence: 1,
      result: 'success',
      adapterId: 'a1',
      idempotencyKey: 's',
    });
    repo.rollback(rolloutId, 'v1', 'regression');

    const types = repo.listEvents().map((e) => e.type);
    expect(types).toContain('rollout_started');
    expect(types).toContain('wave_started');
    expect(types).toContain('wave_receipt');
    expect(types).toContain('wave_failed');
    expect(types).toContain('rollout_failed');
    expect(types).toContain('wave_retried');
    expect(types).toContain('rollout_paused');
    expect(types).toContain('rollout_resumed');
    expect(types).toContain('wave_succeeded');
    expect(types).toContain('rollout_rolled_back');
  });

  it('recovers rollout, waves, and receipts across a process restart', () => {
    const { repo, db, clock } = ctx;
    const { proposal } = setupApprovedProposal(repo);
    const started = repo.startRollout(proposal.id, threeWaves, 'v1.0.0');
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const rolloutId = started.rollout.id;
    repo.reportReceipt({
      rolloutId,
      sequence: 1,
      result: 'success',
      adapterId: 'a1',
      idempotencyKey: 'r1',
      message: 'canary green',
    });
    repo.reportReceipt({
      rolloutId,
      sequence: 2,
      result: 'unknown',
      adapterId: 'a2',
      idempotencyKey: 'u2',
    });
    const eventCount = repo.listEvents().length;
    const dbPath = (db as unknown as { name: string }).name;
    db.close();

    const db2 = openDatabase(dbPath);
    const repo2 = new Repository(db2, { clock: new VirtualClock(0) });
    const recovered = repo2.getRollout(rolloutId)!;
    expect(recovered).not.toBeNull();
    expect(recovered.status).toBe('in_progress');
    expect(recovered.candidateHash).toBe(proposal.candidateHash);
    expect(recovered.previousVersion).toBe('v1.0.0');
    expect(recovered.waves).toHaveLength(3);
    expect(recovered.waves[0].status).toBe('succeeded');
    expect(recovered.waves[1].status).toBe('in_progress');
    expect(recovered.waves[1].lastResult).toBe('unknown');
    expect(recovered.waves[2].status).toBe('pending');
    expect(repo2.listReceipts(recovered.waves[0].id)).toHaveLength(1);
    expect(repo2.listReceipts(recovered.waves[1].id)).toHaveLength(1);

    const dup = repo2.reportReceipt({
      rolloutId,
      sequence: 2,
      result: 'unknown',
      adapterId: 'a2',
      idempotencyKey: 'u2',
    });
    expect(dup.ok).toBe(true);
    if (dup.ok) expect(dup.duplicate).toBe(true);

    const cont = repo2.reportReceipt({
      rolloutId,
      sequence: 2,
      result: 'success',
      adapterId: 'a2',
      idempotencyKey: 'r2',
    });
    expect(cont.ok).toBe(true);
    if (cont.ok) expect(cont.rollout.waves[2].status).toBe('in_progress');

    expect(repo2.listEvents().length).toBe(eventCount + 3);
    expect(repo2.recover().lamport).toBeGreaterThan(0);
    db2.close();
  });
});
