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
// COMPATIBLE candidate (adds an optional field only).
const candidate = { type: 'object', properties: { id: { type: 'string' }, extra: { type: 'string' } }, required: ['id'] };

function newService(clock = new LogicalClock(0)) {
  const repo = new SqliteRepository(':memory:');
  const service = new ControlCenterService(repo, clock, new ArmableFaults());
  return { repo, service, clock };
}

/** Register a subject with two consumers and submit the compatible candidate. */
function setup(service: ControlCenterService) {
  service.registerSubject({ subjectId: 's', requiredConsumers: ['c1', 'c2'], freshnessWindowMs: 1000 });
  const p = service.submitCandidate({ subjectId: 's', baselineSchema: baseline, candidateSchema: candidate, submittedBy: 'dev' });
  return p.proposal;
}

test('waiver requires two distinct reviewers to become ACTIVE', () => {
  const { service } = newService();
  const proposal = setup(service);
  service.reportEvidence({ reportId: 'e1', subjectId: 's', targetDigest: proposal.candidateDigest, consumerId: 'c1', verdict: 'PASS', producedAt: 0 });

  const req = service.requestWaiver({
    subjectId: 's',
    candidateDigest: proposal.candidateDigest,
    consumerId: 'c2',
    compatDirection: 'COMPATIBLE',
    reason: 'c2 offline in release window',
    requestedBy: 'alice',
    ttlMs: 5000
  });
  assert.equal(req.status, 'REQUESTED');
  const waiverId = (req as any).waiver.waiverId;

  // Same reviewer cannot confirm their own request.
  const selfConfirm = service.confirmWaiver(waiverId, 'alice');
  assert.equal(selfConfirm.status, 'DENIED');

  // While only REQUESTED, it does not participate: gate still COLLECTING.
  assert.equal(service.getProposalView(proposal.proposalId)!.gate.status, 'COLLECTING');

  // A distinct reviewer confirms -> ACTIVE, gate READY (c2 WAIVED).
  const confirm = service.confirmWaiver(waiverId, 'bob');
  assert.equal(confirm.status, 'CONFIRMED');
  const view = service.getProposalView(proposal.proposalId)!;
  assert.equal(view.gate.status, 'READY');
  assert.equal(view.gate.consumers.find((c) => c.consumerId === 'c2')!.status, 'WAIVED');
});

test('waiver only covers its exact scope (consumer/direction/environment)', () => {
  const { service } = newService();
  const proposal = setup(service);
  service.reportEvidence({ reportId: 'e1', subjectId: 's', targetDigest: proposal.candidateDigest, consumerId: 'c1', verdict: 'PASS', producedAt: 0 });

  // Wrong compat direction is denied at request time (candidate is COMPATIBLE).
  const wrongDir = service.requestWaiver({
    subjectId: 's', candidateDigest: proposal.candidateDigest, consumerId: 'c2',
    compatDirection: 'BREAKING', reason: 'x', requestedBy: 'alice', ttlMs: 5000
  });
  assert.equal(wrongDir.status, 'DENIED');

  // A waiver in a different environment does not satisfy the production gate.
  const stg = service.requestWaiver({
    subjectId: 's', candidateDigest: proposal.candidateDigest, consumerId: 'c2', environment: 'staging',
    compatDirection: 'COMPATIBLE', reason: 'staging only', requestedBy: 'alice', ttlMs: 5000
  });
  assert.equal(stg.status, 'REQUESTED');
  service.confirmWaiver((stg as any).waiver.waiverId, 'bob');
  // Default environment view (production) is unaffected.
  assert.equal(service.getProposalView(proposal.proposalId)!.gate.status, 'COLLECTING');
  // Staging view is satisfied.
  assert.equal(service.getProposalView(proposal.proposalId, 'staging')!.gate.status, 'READY');
});

test('expired waiver stops participating and is not revived', () => {
  const clock = new LogicalClock(0);
  const { service } = newService(clock);
  const proposal = setup(service);
  service.reportEvidence({ reportId: 'e1', subjectId: 's', targetDigest: proposal.candidateDigest, consumerId: 'c1', verdict: 'PASS', producedAt: 0 });
  const req = service.requestWaiver({
    subjectId: 's', candidateDigest: proposal.candidateDigest, consumerId: 'c2',
    compatDirection: 'COMPATIBLE', reason: 'offline', requestedBy: 'alice', ttlMs: 500
  });
  service.confirmWaiver((req as any).waiver.waiverId, 'bob');
  assert.equal(service.getProposalView(proposal.proposalId)!.gate.status, 'READY');

  clock.advance(600); // past the 500ms TTL
  const view = service.getProposalView(proposal.proposalId)!;
  assert.equal(view.gate.status, 'COLLECTING');
  assert.equal(service.getWaiver((req as any).waiver.waiverId)!.status, 'EXPIRED');
});

test('revoked waiver stops participating immediately', () => {
  const { service } = newService();
  const proposal = setup(service);
  service.reportEvidence({ reportId: 'e1', subjectId: 's', targetDigest: proposal.candidateDigest, consumerId: 'c1', verdict: 'PASS', producedAt: 0 });
  const req = service.requestWaiver({
    subjectId: 's', candidateDigest: proposal.candidateDigest, consumerId: 'c2',
    compatDirection: 'COMPATIBLE', reason: 'offline', requestedBy: 'alice', ttlMs: 5000
  });
  const waiverId = (req as any).waiver.waiverId;
  service.confirmWaiver(waiverId, 'bob');
  assert.equal(service.getProposalView(proposal.proposalId)!.gate.status, 'READY');

  const rev = service.revokeWaiver(waiverId, 'carol', 'no longer needed');
  assert.equal(rev.status, 'REVOKED');
  assert.equal(service.getProposalView(proposal.proposalId)!.gate.status, 'COLLECTING');
});

test('approval via waiver freezes snapshot; later expiry does not change history', () => {
  const clock = new LogicalClock(0);
  const { service } = newService(clock);
  const proposal = setup(service);
  service.reportEvidence({ reportId: 'e1', subjectId: 's', targetDigest: proposal.candidateDigest, consumerId: 'c1', verdict: 'PASS', producedAt: 0 });
  const req = service.requestWaiver({
    subjectId: 's', candidateDigest: proposal.candidateDigest, consumerId: 'c2',
    compatDirection: 'COMPATIBLE', reason: 'offline', requestedBy: 'alice', ttlMs: 500
  });
  const waiverId = (req as any).waiver.waiverId;
  service.confirmWaiver(waiverId, 'bob');

  const decided = service.decide({ proposalId: proposal.proposalId, expectedDigest: proposal.candidateDigest, type: 'APPROVE', decidedBy: 'mgr' });
  assert.equal(decided.status, 'DECIDED');
  const snapshotAtDecision = JSON.stringify((decided as any).decision.gateSnapshot);
  // The frozen snapshot recorded which waiver it relied on.
  assert.ok((decided as any).decision.gateSnapshot.appliedWaivers.some((w: any) => w.waiverId === waiverId));

  // Advance past expiry; the waiver expires, but the historical decision is intact.
  clock.advance(1000);
  const view = service.getProposalView(proposal.proposalId)!;
  assert.equal(view.proposal.state, 'APPROVED');
  assert.equal(JSON.stringify(view.decision!.gateSnapshot), snapshotAtDecision);
  assert.equal(service.getWaiver(waiverId)!.status, 'EXPIRED');
});

test('waiver never masks a FAIL', () => {
  const { service } = newService();
  const proposal = setup(service);
  service.reportEvidence({ reportId: 'e1', subjectId: 's', targetDigest: proposal.candidateDigest, consumerId: 'c1', verdict: 'PASS', producedAt: 0 });
  service.reportEvidence({ reportId: 'e2', subjectId: 's', targetDigest: proposal.candidateDigest, consumerId: 'c2', verdict: 'FAIL', producedAt: 0 });
  const req = service.requestWaiver({
    subjectId: 's', candidateDigest: proposal.candidateDigest, consumerId: 'c2',
    compatDirection: 'COMPATIBLE', reason: 'try to mask fail', requestedBy: 'alice', ttlMs: 5000
  });
  service.confirmWaiver((req as any).waiver.waiverId, 'bob');
  const view = service.getProposalView(proposal.proposalId)!;
  assert.equal(view.gate.status, 'BLOCKED');
  assert.equal(view.gate.consumers.find((c) => c.consumerId === 'c2')!.status, 'FAIL');
  const dec = service.decide({ proposalId: proposal.proposalId, expectedDigest: proposal.candidateDigest, type: 'APPROVE', decidedBy: 'mgr' });
  assert.equal(dec.status, 'REJECTED_PRECONDITION');
});

test('waiver lifecycle is recorded in the causal audit chain and survives restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccc-waiver-'));
  const dbPath = join(dir, 'db.sqlite');
  try {
    let waiverId: string;
    {
      const repo = new SqliteRepository(dbPath);
      const service = new ControlCenterService(repo, new LogicalClock(0), new ArmableFaults());
      const proposal = setup(service);
      const req = service.requestWaiver({
        subjectId: 's', candidateDigest: proposal.candidateDigest, consumerId: 'c2',
        compatDirection: 'COMPATIBLE', reason: 'offline', requestedBy: 'alice', ttlMs: 5000
      });
      waiverId = (req as any).waiver.waiverId;
      service.confirmWaiver(waiverId, 'bob');
      repo.close();
    }
    {
      const repo = new SqliteRepository(dbPath);
      const service = new ControlCenterService(repo, new LogicalClock(10), new ArmableFaults());
      const w = service.getWaiver(waiverId)!;
      assert.equal(w.status, 'ACTIVE');
      assert.equal(w.requestedBy, 'alice');
      assert.equal(w.confirmedBy, 'bob');
      const types = service.listEvents(0).map((e) => e.type);
      assert.ok(types.includes('waiver.requested'));
      assert.ok(types.includes('waiver.confirmed'));
      repo.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
