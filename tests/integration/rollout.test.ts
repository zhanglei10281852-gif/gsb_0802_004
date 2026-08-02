import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ControlCenterService } from '../../src/app/control-center-service.ts';
import { SqliteRepository } from '../../src/adapters/store/sqlite-repository.ts';
import { LogicalClock } from '../../src/domain/clock.ts';
import { ArmableFaults, InjectedCrash } from '../../src/ports/faults.ts';

const baseline = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };
const v1 = { type: 'object', properties: { id: { type: 'string' }, a: { type: 'string' } }, required: ['id'] };
const v2 = { type: 'object', properties: { id: { type: 'string' }, b: { type: 'number' } }, required: ['id'] };

function newService(clock = new LogicalClock(0), faults = new ArmableFaults()) {
  const repo = new SqliteRepository(':memory:');
  const service = new ControlCenterService(repo, clock, faults);
  return { repo, service, clock, faults };
}

/** Register a subject, submit a candidate, pass evidence, and APPROVE it. */
function approve(service: ControlCenterService, subjectId = 's', schema = v1) {
  service.registerSubject({ subjectId, requiredConsumers: ['c'], freshnessWindowMs: 10_000_000 });
  const p = service.submitCandidate({ subjectId, baselineSchema: baseline, candidateSchema: schema, submittedBy: 'dev' });
  const digest = p.proposal.candidateDigest;
  service.reportEvidence({ reportId: `e-${subjectId}-${digest.slice(7, 15)}`, subjectId, targetDigest: digest, consumerId: 'c', verdict: 'PASS', producedAt: 0 });
  const decided = service.decide({ proposalId: p.proposal.proposalId, expectedDigest: digest, type: 'APPROVE', decidedBy: 'mgr' });
  assert.equal(decided.status, 'DECIDED');
  return { proposal: p.proposal, digest, decision: (decided as any).decision };
}

test('a rollout can only be created from an APPROVE decision and binds its snapshot', () => {
  const { service } = newService();
  const { decision, proposal, digest } = approve(service);
  const out = service.createRollout({ decisionId: decision.decisionId, waves: ['canary', 'full'], createdBy: 'mgr' });
  assert.equal(out.status, 'CREATED');
  if (out.status !== 'CREATED') return;
  assert.equal(out.rollout.decisionId, decision.decisionId);
  assert.equal(out.rollout.proposalId, proposal.proposalId);
  assert.equal(out.rollout.candidateDigest, digest);
  assert.equal(out.rollout.evidenceFingerprint, decision.evidenceFingerprint);
  assert.equal(out.rollout.kind, 'RELEASE');
  assert.equal(out.waves.length, 2);
});

test('a rollout cannot be created from a REJECT decision', () => {
  const { service } = newService();
  service.registerSubject({ subjectId: 's', requiredConsumers: ['c'], freshnessWindowMs: 10_000 });
  const p = service.submitCandidate({ subjectId: 's', baselineSchema: baseline, candidateSchema: v1, submittedBy: 'dev' });
  const decided = service.decide({ proposalId: p.proposal.proposalId, expectedDigest: p.proposal.candidateDigest, type: 'REJECT', decidedBy: 'mgr' });
  assert.equal(decided.status, 'DECIDED');
  const out = service.createRollout({ decisionId: (decided as any).decision.decisionId, waves: ['a'], createdBy: 'mgr' });
  assert.equal(out.status, 'DENIED');
});

test('only one non-terminal rollout per (subject, environment)', () => {
  const { service } = newService();
  const { decision } = approve(service);
  const first = service.createRollout({ decisionId: decision.decisionId, waves: ['a'], createdBy: 'mgr' });
  assert.equal(first.status, 'CREATED');
  const second = service.createRollout({ decisionId: decision.decisionId, waves: ['a'], createdBy: 'mgr' });
  assert.equal(second.status, 'DENIED');
});

test('receipts only advance the current wave attempt bound to the decision snapshot', () => {
  const { service } = newService();
  const { decision } = approve(service);
  const created = service.createRollout({ decisionId: decision.decisionId, waves: ['canary', 'full'], createdBy: 'mgr' });
  assert.equal(created.status, 'CREATED');
  if (created.status !== 'CREATED') return;
  const rolloutId = created.rollout.rolloutId;
  const fp = created.rollout.evidenceFingerprint;
  const canary = created.waves[0];
  const full = created.waves[1];

  service.startNextWave(rolloutId);

  // A receipt with a mismatched fingerprint is inert.
  const bad = service.reportReceipt({ receiptId: 'rc-bad', rolloutId, waveId: canary.waveId, attempt: 1, result: 'SUCCESS', evidenceFingerprint: 'sha256:wrong' });
  assert.equal(bad.status, 'IGNORED');

  // A receipt for the wrong (not-current) wave is inert.
  const wrongWave = service.reportReceipt({ receiptId: 'rc-wrongwave', rolloutId, waveId: full.waveId, attempt: 1, result: 'SUCCESS', evidenceFingerprint: fp });
  assert.equal(wrongWave.status, 'IGNORED');

  // A stale attempt is inert.
  const staleAttempt = service.reportReceipt({ receiptId: 'rc-stale', rolloutId, waveId: canary.waveId, attempt: 2, result: 'SUCCESS', evidenceFingerprint: fp });
  assert.equal(staleAttempt.status, 'IGNORED');

  // The correct receipt advances; a duplicate delivery is idempotent.
  const ok = service.reportReceipt({ receiptId: 'rc-ok', rolloutId, waveId: canary.waveId, attempt: 1, result: 'SUCCESS', evidenceFingerprint: fp });
  assert.equal(ok.status, 'ADVANCED');
  const dup = service.reportReceipt({ receiptId: 'rc-ok', rolloutId, waveId: canary.waveId, attempt: 1, result: 'SUCCESS', evidenceFingerprint: fp });
  assert.equal(dup.status, 'DUPLICATE');

  const detail = service.getRolloutDetail(rolloutId)!;
  assert.equal(detail.waves.find((w) => w.waveId === canary.waveId)!.status, 'SUCCEEDED');
  // Rollout still IN_PROGRESS (a wave remains).
  assert.equal(detail.rollout.status, 'IN_PROGRESS');
  assert.equal(detail.receipts.filter((r) => r.applied).length, 1);
});

test('a SUCCESS on the last wave completes the rollout', () => {
  const { service } = newService();
  const { decision } = approve(service);
  const created = service.createRollout({ decisionId: decision.decisionId, waves: ['only'], createdBy: 'mgr' });
  assert.equal(created.status, 'CREATED');
  if (created.status !== 'CREATED') return;
  const rolloutId = created.rollout.rolloutId;
  service.startNextWave(rolloutId);
  service.reportReceipt({ receiptId: 'rc', rolloutId, waveId: created.waves[0].waveId, attempt: 1, result: 'SUCCESS', evidenceFingerprint: created.rollout.evidenceFingerprint });
  assert.equal(service.getRolloutDetail(rolloutId)!.rollout.status, 'COMPLETED');
});

test('pause blocks receipts and start; resume + retry re-open the wave and stale receipts do not settle it', () => {
  const { service } = newService();
  const { decision } = approve(service);
  const created = service.createRollout({ decisionId: decision.decisionId, waves: ['w'], createdBy: 'mgr' });
  assert.equal(created.status, 'CREATED');
  if (created.status !== 'CREATED') return;
  const rolloutId = created.rollout.rolloutId;
  const fp = created.rollout.evidenceFingerprint;
  const waveId = created.waves[0].waveId;

  service.startNextWave(rolloutId);
  assert.equal(service.pauseRollout(rolloutId).status, 'PAUSED');

  // A receipt during pause is inert; starting a wave is refused.
  assert.equal(service.reportReceipt({ receiptId: 'rc-pause', rolloutId, waveId, attempt: 1, result: 'SUCCESS', evidenceFingerprint: fp }).status, 'IGNORED');
  assert.equal(service.startNextWave(rolloutId).status, 'DENIED');

  assert.equal(service.resumeRollout(rolloutId).status, 'RESUMED');

  // Fail the wave, then retry: attempt bumps to 2.
  service.reportReceipt({ receiptId: 'rc-fail', rolloutId, waveId, attempt: 1, result: 'FAILURE', evidenceFingerprint: fp });
  assert.equal(service.getRolloutDetail(rolloutId)!.rollout.status, 'FAILED');
  const retried = service.retryWave(rolloutId, waveId);
  assert.equal(retried.status, 'RETRIED');
  if (retried.status === 'RETRIED') assert.equal(retried.attempt, 2);

  // A late receipt for attempt 1 is now stale and cannot settle the retried wave.
  const stale = service.reportReceipt({ receiptId: 'rc-late', rolloutId, waveId, attempt: 1, result: 'SUCCESS', evidenceFingerprint: fp });
  assert.equal(stale.status, 'IGNORED');
  assert.equal(service.getRolloutDetail(rolloutId)!.waves[0].status, 'IN_PROGRESS');

  // A receipt for the live attempt settles it.
  service.reportReceipt({ receiptId: 'rc-ok2', rolloutId, waveId, attempt: 2, result: 'SUCCESS', evidenceFingerprint: fp });
  assert.equal(service.getRolloutDetail(rolloutId)!.rollout.status, 'COMPLETED');
});

test('a receipt for one rollout never advances another (cross-proposal isolation)', () => {
  const { service } = newService();
  // v1 approved + rolled out, then v2 supersedes it and is approved + rolled out.
  const a = approve(service, 's', v1);
  const roA = service.createRollout({ decisionId: a.decision.decisionId, waves: ['w'], createdBy: 'mgr' });
  assert.equal(roA.status, 'CREATED');
  if (roA.status !== 'CREATED') return;
  service.startNextWave(roA.rollout.rolloutId);
  service.reportReceipt({ receiptId: 'rcA', rolloutId: roA.rollout.rolloutId, waveId: roA.waves[0].waveId, attempt: 1, result: 'SUCCESS', evidenceFingerprint: roA.rollout.evidenceFingerprint });

  // v2 supersedes v1 for the same subject.
  const p2 = service.submitCandidate({ subjectId: 's', baselineSchema: baseline, candidateSchema: v2, submittedBy: 'dev' });
  service.reportEvidence({ reportId: 'e-v2', subjectId: 's', targetDigest: p2.proposal.candidateDigest, consumerId: 'c', verdict: 'PASS', producedAt: 0 });
  const d2 = service.decide({ proposalId: p2.proposal.proposalId, expectedDigest: p2.proposal.candidateDigest, type: 'APPROVE', decidedBy: 'mgr' });
  const roB = service.createRollout({ decisionId: (d2 as any).decision.decisionId, waves: ['w'], createdBy: 'mgr' });
  assert.equal(roB.status, 'CREATED');
  if (roB.status !== 'CREATED') return;
  service.startNextWave(roB.rollout.rolloutId);

  // A's fingerprint on B's rollout is inert — receipts cannot cross snapshots.
  const cross = service.reportReceipt({ receiptId: 'rc-cross', rolloutId: roB.rollout.rolloutId, waveId: roB.waves[0].waveId, attempt: 1, result: 'SUCCESS', evidenceFingerprint: roA.rollout.evidenceFingerprint });
  assert.equal(cross.status, 'IGNORED');
  assert.notEqual(roA.rollout.evidenceFingerprint, roB.rollout.evidenceFingerprint);
});

test('rollback is deployment-only: it does not rewrite the contract decision or revive waivers', () => {
  const { service, clock } = newService();
  // v1 approved + fully rolled out (known good).
  const a = approve(service, 's', v1);
  const roA = service.createRollout({ decisionId: a.decision.decisionId, waves: ['w'], createdBy: 'mgr' });
  assert.equal(roA.status, 'CREATED');
  if (roA.status !== 'CREATED') return;
  service.startNextWave(roA.rollout.rolloutId);
  service.reportReceipt({ receiptId: 'rcA', rolloutId: roA.rollout.rolloutId, waveId: roA.waves[0].waveId, attempt: 1, result: 'SUCCESS', evidenceFingerprint: roA.rollout.evidenceFingerprint });

  // v2 supersedes v1 (this lapses any v1 waiver by scope) and is approved + started.
  const p2 = service.submitCandidate({ subjectId: 's', baselineSchema: baseline, candidateSchema: v2, submittedBy: 'dev' });
  service.reportEvidence({ reportId: 'e-v2', subjectId: 's', targetDigest: p2.proposal.candidateDigest, consumerId: 'c', verdict: 'PASS', producedAt: 0 });
  const d2 = service.decide({ proposalId: p2.proposal.proposalId, expectedDigest: p2.proposal.candidateDigest, type: 'APPROVE', decidedBy: 'mgr' });
  const roB = service.createRollout({ decisionId: (d2 as any).decision.decisionId, waves: ['w'], createdBy: 'mgr' });
  assert.equal(roB.status, 'CREATED');
  if (roB.status !== 'CREATED') return;
  service.startNextWave(roB.rollout.rolloutId);

  const v2StateBefore = service.getProposalView(p2.proposal.proposalId)!;
  const frozenDecision = JSON.stringify(v2StateBefore.decision);

  // Roll back to v1's known-good digest.
  const rb = service.rollback({ subjectId: 's', targetDigest: a.digest, waves: ['revert'], createdBy: 'mgr' });
  assert.equal(rb.status, 'CREATED');
  if (rb.status !== 'CREATED') return;
  assert.equal(rb.rollout.kind, 'ROLLBACK');
  assert.equal(rb.rollout.candidateDigest, a.digest);
  assert.equal(rb.rollout.evidenceFingerprint, a.decision.evidenceFingerprint);
  assert.equal(rb.rollout.supersedesRolloutId, roB.rollout.rolloutId);

  // The v2 rollout it superseded is now ROLLED_BACK.
  assert.equal(service.getRolloutDetail(roB.rollout.rolloutId)!.rollout.status, 'ROLLED_BACK');

  // The v2 contract decision is unchanged; the proposal stays APPROVED.
  const v2StateAfter = service.getProposalView(p2.proposal.proposalId)!;
  assert.equal(v2StateAfter.proposal.state, 'APPROVED');
  assert.equal(JSON.stringify(v2StateAfter.decision), frozenDecision);
});

test('rollback target must have been approved for the environment', () => {
  const { service } = newService();
  const { decision } = approve(service);
  service.createRollout({ decisionId: decision.decisionId, waves: ['w'], createdBy: 'mgr' });
  const rb = service.rollback({ subjectId: 's', targetDigest: 'sha256:never-approved', waves: ['revert'], createdBy: 'mgr' });
  assert.equal(rb.status, 'DENIED');
});

test('crash after write, before reply on a receipt: effect happens once, retry reconciles as DUPLICATE, survives restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccc-rollout-crash-'));
  const dbPath = join(dir, 'db.sqlite');
  try {
    let rolloutId: string;
    let waveId: string;
    let fp: string;

    // --- first process: arm the crash on the decisive receipt ---
    {
      const repo = new SqliteRepository(dbPath);
      const faults = new ArmableFaults();
      const service = new ControlCenterService(repo, new LogicalClock(0), faults);
      const { decision } = approve(service);
      const created = service.createRollout({ decisionId: decision.decisionId, waves: ['w'], createdBy: 'mgr' });
      assert.equal(created.status, 'CREATED');
      if (created.status !== 'CREATED') return;
      rolloutId = created.rollout.rolloutId;
      waveId = created.waves[0].waveId;
      fp = created.rollout.evidenceFingerprint;
      service.startNextWave(rolloutId);

      faults.arm('rollout.receipt.after-write-before-reply', 1);
      assert.throws(
        () => service.reportReceipt({ receiptId: 'rc-crash', rolloutId, waveId, attempt: 1, result: 'SUCCESS', evidenceFingerprint: fp }),
        InjectedCrash
      );
      repo.close();
    }

    // --- restart: the receipt was durably written; retry is idempotent ---
    {
      const repo = new SqliteRepository(dbPath);
      const service = new ControlCenterService(repo, new LogicalClock(100), new ArmableFaults());
      // The wave already settled before the crash.
      assert.equal(service.getRolloutDetail(rolloutId!)!.rollout.status, 'COMPLETED');
      const retry = service.reportReceipt({ receiptId: 'rc-crash', rolloutId: rolloutId!, waveId: waveId!, attempt: 1, result: 'SUCCESS', evidenceFingerprint: fp! });
      assert.equal(retry.status, 'DUPLICATE');
      assert.equal(service.getRolloutDetail(rolloutId!)!.receipts.filter((r) => r.applied).length, 1);

      // Causal log records the rollout lifecycle for recovery/audit.
      const types = service.listEvents(0).map((e) => e.type);
      assert.ok(types.includes('rollout.created'));
      assert.ok(types.includes('rollout.wave.started'));
      assert.ok(types.includes('rollout.receipt.applied'));
      repo.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
