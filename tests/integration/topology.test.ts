import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ControlCenterService } from '../../src/app/control-center-service.ts';
import { SqliteRepository } from '../../src/adapters/store/sqlite-repository.ts';
import { LogicalClock } from '../../src/domain/clock.ts';
import { ArmableFaults } from '../../src/ports/faults.ts';

const baseline = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };
const cand = { type: 'object', properties: { id: { type: 'string' }, a: { type: 'string' } }, required: ['id'] };

function newService(clock = new LogicalClock(0)) {
  const repo = new SqliteRepository(':memory:');
  const service = new ControlCenterService(repo, clock, new ArmableFaults());
  return { repo, service, clock };
}

/**
 * Register a subject with `consumers`, submit + evidence + APPROVE the candidate,
 * create a rollout, and start its first wave. Returns handles.
 */
function releaseAndStart(service: ControlCenterService, consumers: string[], waves: string[]) {
  service.registerSubject({ subjectId: 's', requiredConsumers: consumers, freshnessWindowMs: 10_000_000 });
  const p = service.submitCandidate({ subjectId: 's', baselineSchema: baseline, candidateSchema: cand, submittedBy: 'dev' });
  const digest = p.proposal.candidateDigest;
  for (const c of consumers) {
    service.reportEvidence({ reportId: `e-${c}`, subjectId: 's', targetDigest: digest, consumerId: c, verdict: 'PASS', producedAt: 0 });
  }
  const decided = service.decide({ proposalId: p.proposal.proposalId, expectedDigest: digest, type: 'APPROVE', decidedBy: 'mgr' });
  assert.equal(decided.status, 'DECIDED');
  const created = service.createRollout({ decisionId: (decided as any).decision.decisionId, waves, createdBy: 'mgr' });
  assert.equal(created.status, 'CREATED');
  if (created.status !== 'CREATED') throw new Error('unreachable');
  service.startNextWave(created.rollout.rolloutId);
  return { proposal: p.proposal, digest, decision: (decided as any).decision, rolloutId: created.rollout.rolloutId, waves: created.waves };
}

test('a new required consumer mid-rollout auto-holds future waves and opens a revalidation on the same proposal', () => {
  const { service } = newService();
  const r = releaseAndStart(service, ['cart'], ['canary', 'full']);
  // Finish the in-flight canary wave.
  service.reportReceipt({ receiptId: 'rc-canary', rolloutId: r.rolloutId, waveId: r.waves[0].waveId, attempt: 1, result: 'SUCCESS', evidenceFingerprint: r.decision.evidenceFingerprint });

  // Topology grows: 'fraud' becomes required.
  service.registerSubject({ subjectId: 's', requiredConsumers: ['cart', 'fraud'], freshnessWindowMs: 10_000_000 });

  const detail = service.getRolloutDetail(r.rolloutId)!;
  assert.ok(detail.rollout.holdReason, 'rollout should be auto-held');
  assert.equal(detail.revalidations.length, 1);
  const reval = detail.revalidations[0];
  assert.equal(reval.status, 'OPEN');
  assert.deepEqual(reval.addedConsumers, ['fraud']);
  // The revalidation is bound to the SAME proposal lineage.
  assert.equal(reval.proposalId, r.proposal.proposalId);
  assert.equal(reval.candidateDigest, r.digest);

  // The next wave cannot start while held.
  const start = service.startNextWave(r.rolloutId);
  assert.equal(start.status, 'DENIED');
  assert.match(start.reason, /re-validation/);
});

test('the historical decision snapshot is NOT modified by a topology change', () => {
  const { service } = newService();
  const r = releaseAndStart(service, ['cart'], ['canary', 'full']);
  const before = JSON.stringify(service.getProposalView(r.proposal.proposalId)!.decision);

  service.registerSubject({ subjectId: 's', requiredConsumers: ['cart', 'fraud'], freshnessWindowMs: 10_000_000 });

  const after = JSON.stringify(service.getProposalView(r.proposal.proposalId)!.decision);
  assert.equal(after, before, 'decision snapshot must be immutable across topology change');
  // Candidate digest and proposal state are untouched too.
  const view = service.getProposalView(r.proposal.proposalId)!;
  assert.equal(view.proposal.candidateDigest, r.digest);
  assert.equal(view.proposal.state, 'APPROVED');
});

test('resolving RESUMED is refused while the gap persists, allowed once the new consumer passes', () => {
  const { service } = newService();
  const r = releaseAndStart(service, ['cart'], ['canary', 'full']);
  // Settle the in-flight canary so that, once resumed, a next wave is startable.
  service.reportReceipt({ receiptId: 'rc-canary', rolloutId: r.rolloutId, waveId: r.waves[0].waveId, attempt: 1, result: 'SUCCESS', evidenceFingerprint: r.decision.evidenceFingerprint });
  service.registerSubject({ subjectId: 's', requiredConsumers: ['cart', 'fraud'], freshnessWindowMs: 10_000_000 });
  const reval = service.getRolloutDetail(r.rolloutId)!.revalidations[0];

  // Cannot resume while 'fraud' still has no fresh PASS.
  const denied = service.resolveRevalidation(reval.revalidationId, 'RESUMED', 'mgr');
  assert.equal(denied.status, 'DENIED');
  assert.match(denied.reason, /fraud/);

  // The new consumer now reports PASS for the deployed candidate.
  service.reportEvidence({ reportId: 'e-fraud', subjectId: 's', targetDigest: r.digest, consumerId: 'fraud', verdict: 'PASS', producedAt: 0 });
  const ok = service.resolveRevalidation(reval.revalidationId, 'RESUMED', 'mgr');
  assert.equal(ok.status, 'RESOLVED');

  // Hold lifted; the next wave can start again.
  const detail = service.getRolloutDetail(r.rolloutId)!;
  assert.equal(detail.rollout.holdReason, null);
  assert.equal(detail.revalidations[0].status, 'RESOLVED');
  assert.equal(detail.revalidations[0].resolution, 'RESUMED');
  assert.equal(service.startNextWave(r.rolloutId).status, 'STARTED');
});

test('resolving HELD keeps the rollout paused with a traceable conclusion', () => {
  const { service } = newService();
  const r = releaseAndStart(service, ['cart'], ['canary', 'full']);
  service.registerSubject({ subjectId: 's', requiredConsumers: ['cart', 'fraud'], freshnessWindowMs: 10_000_000 });
  const reval = service.getRolloutDetail(r.rolloutId)!.revalidations[0];

  const held = service.resolveRevalidation(reval.revalidationId, 'HELD', 'mgr', 'wait for fraud team');
  assert.equal(held.status, 'RESOLVED');

  const detail = service.getRolloutDetail(r.rolloutId)!;
  // Hold remains; the conclusion is recorded for traceability.
  assert.ok(detail.rollout.holdReason, 'HELD keeps the rollout on hold');
  assert.equal(detail.revalidations[0].status, 'RESOLVED');
  assert.equal(detail.revalidations[0].resolution, 'HELD');
  assert.equal(service.startNextWave(r.rolloutId).status, 'DENIED');
});

test('a waiver cannot be requested against the already-deployed (closed) candidate; coverage closes via fresh PASS only', () => {
  const { service } = newService();
  const r = releaseAndStart(service, ['cart'], ['canary', 'full']);
  service.registerSubject({ subjectId: 's', requiredConsumers: ['cart', 'fraud'], freshnessWindowMs: 10_000_000 });
  const reval = service.getRolloutDetail(r.rolloutId)!.revalidations[0];

  // Waivers only apply to an OPEN candidate — the deployed candidate is
  // APPROVED, so a waiver request is refused. This keeps the round-4 waiver
  // boundary consistent: re-validation coverage is established by fresh PASS.
  const req = service.requestWaiver({
    subjectId: 's', candidateDigest: r.digest, consumerId: 'fraud',
    compatDirection: 'COMPATIBLE', reason: 'fraud offline', requestedBy: 'alice', ttlMs: 10_000_000
  });
  assert.equal(req.status, 'DENIED');

  // The new consumer reports a fresh PASS for the deployed candidate; the gap
  // closes and the re-validation may resume.
  service.reportEvidence({ reportId: 'e-fraud', subjectId: 's', targetDigest: r.digest, consumerId: 'fraud', verdict: 'PASS', producedAt: 0 });
  const ok = service.resolveRevalidation(reval.revalidationId, 'RESUMED', 'mgr');
  assert.equal(ok.status, 'RESOLVED');
  assert.equal(service.getRolloutDetail(r.rolloutId)!.rollout.holdReason, null);
});

test('re-registering with no new consumer does NOT hold the rollout', () => {
  const { service } = newService();
  const r = releaseAndStart(service, ['cart'], ['canary', 'full']);
  // Settle the in-flight canary so a next wave is startable.
  service.reportReceipt({ receiptId: 'rc', rolloutId: r.rolloutId, waveId: r.waves[0].waveId, attempt: 1, result: 'SUCCESS', evidenceFingerprint: r.decision.evidenceFingerprint });
  // Same required set (only freshness window changed): no topology growth.
  service.registerSubject({ subjectId: 's', requiredConsumers: ['cart'], freshnessWindowMs: 20_000_000 });
  const detail = service.getRolloutDetail(r.rolloutId)!;
  assert.equal(detail.rollout.holdReason, null);
  assert.equal(detail.revalidations.length, 0);
  assert.equal(service.startNextWave(r.rolloutId).status, 'STARTED');
});

test('topology change survives a restart: hold + OPEN revalidation recover from SQLite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccc-topo-'));
  const dbPath = join(dir, 'db.sqlite');
  try {
    let rolloutId: string;
    let proposalId: string;

    {
      const repo = new SqliteRepository(dbPath);
      const service = new ControlCenterService(repo, new LogicalClock(0), new ArmableFaults());
      const r = releaseAndStart(service, ['cart'], ['canary', 'full']);
      rolloutId = r.rolloutId;
      proposalId = r.proposal.proposalId;
      service.registerSubject({ subjectId: 's', requiredConsumers: ['cart', 'fraud'], freshnessWindowMs: 10_000_000 });
      assert.ok(service.getRolloutDetail(rolloutId)!.rollout.holdReason);
      repo.close();
    }

    {
      const repo = new SqliteRepository(dbPath);
      const service = new ControlCenterService(repo, new LogicalClock(100), new ArmableFaults());
      const detail = service.getRolloutDetail(rolloutId!)!;
      assert.ok(detail.rollout.holdReason, 'hold survives restart');
      assert.equal(detail.revalidations.length, 1);
      assert.equal(detail.revalidations[0].status, 'OPEN');
      // Decision snapshot still intact.
      assert.equal(service.getProposalView(proposalId!)!.proposal.state, 'APPROVED');
      // Causal log explains the hold.
      const types = service.listEvents(0).map((e) => e.type);
      assert.ok(types.includes('rollout.held'));
      assert.ok(types.includes('rollout.revalidation.opened'));
      repo.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a receipt that lands before the topology change still settles its in-flight wave (deterministic)', () => {
  const { service } = newService();
  const r = releaseAndStart(service, ['cart'], ['canary', 'full']);
  // Receipt for the in-flight canary lands first (committed), settling it.
  const rc = service.reportReceipt({ receiptId: 'rc', rolloutId: r.rolloutId, waveId: r.waves[0].waveId, attempt: 1, result: 'SUCCESS', evidenceFingerprint: r.decision.evidenceFingerprint });
  assert.equal(rc.status, 'ADVANCED');

  // Then the topology grows: the settled wave stays SUCCEEDED; only future
  // waves are held.
  service.registerSubject({ subjectId: 's', requiredConsumers: ['cart', 'fraud'], freshnessWindowMs: 10_000_000 });
  const detail = service.getRolloutDetail(r.rolloutId)!;
  assert.equal(detail.waves.find((w) => w.ordinal === 1)!.status, 'SUCCEEDED');
  assert.ok(detail.rollout.holdReason);
  assert.equal(service.startNextWave(r.rolloutId).status, 'DENIED');
});
