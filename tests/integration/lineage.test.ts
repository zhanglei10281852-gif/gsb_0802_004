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
const v1 = { type: 'object', properties: { id: { type: 'string' }, a: { type: 'string' } }, required: ['id'] };
// A corrected candidate: different content -> different digest.
const v2 = { type: 'object', properties: { id: { type: 'string' }, b: { type: 'number' } }, required: ['id'] };

function newService(clock = new LogicalClock(0)) {
  const repo = new SqliteRepository(':memory:');
  const service = new ControlCenterService(repo, clock, new ArmableFaults());
  return { repo, service, clock };
}

function setup(service: ControlCenterService) {
  service.registerSubject({ subjectId: 's', requiredConsumers: ['c1', 'c2'], freshnessWindowMs: 1000 });
  const p1 = service.submitCandidate({ subjectId: 's', baselineSchema: baseline, candidateSchema: v1, submittedBy: 'dev' });
  return p1;
}

test('successor gets a new digest and explicit lineage; predecessor is SUPERSEDED', () => {
  const { service } = newService();
  const p1 = setup(service);
  const p2 = service.submitCandidate({ subjectId: 's', baselineSchema: baseline, candidateSchema: v2, submittedBy: 'dev' });

  assert.notEqual(p1.proposal.candidateDigest, p2.proposal.candidateDigest);
  assert.equal(p2.predecessorId, p1.proposal.proposalId);
  assert.equal(p2.proposal.predecessorId, p1.proposal.proposalId);

  const v1View = service.getProposalView(p1.proposal.proposalId)!;
  const v2View = service.getProposalView(p2.proposal.proposalId)!;
  assert.equal(v1View.proposal.state, 'SUPERSEDED');
  assert.equal(v2View.proposal.state, 'OPEN');
  // Lineage links both directions.
  assert.equal(v1View.lineage.successorId, p2.proposal.proposalId);
  assert.equal(v2View.lineage.predecessorId, p1.proposal.proposalId);
});

test("predecessor's build evidence is not carried forward to the successor", () => {
  const { service } = newService();
  const p1 = setup(service);
  // Both consumers pass on v1 -> v1 would be READY.
  service.reportEvidence({ reportId: 'e1', subjectId: 's', targetDigest: p1.proposal.candidateDigest, consumerId: 'c1', verdict: 'PASS', producedAt: 0 });
  service.reportEvidence({ reportId: 'e2', subjectId: 's', targetDigest: p1.proposal.candidateDigest, consumerId: 'c2', verdict: 'PASS', producedAt: 0 });
  assert.equal(service.getProposalView(p1.proposal.proposalId)!.gate.status, 'READY');

  const p2 = service.submitCandidate({ subjectId: 's', baselineSchema: baseline, candidateSchema: v2, submittedBy: 'dev' });
  // Successor starts from scratch: no inherited evidence.
  const v2gate = service.getProposalView(p2.proposal.proposalId)!.gate;
  assert.equal(v2gate.status, 'COLLECTING');
  assert.deepEqual(
    v2gate.consumers.map((c) => c.status).sort(),
    ['MISSING', 'MISSING']
  );
});

test('predecessor active waivers lapse by exact scope and are not inherited', () => {
  const { service } = newService();
  const p1 = setup(service);
  service.reportEvidence({ reportId: 'e1', subjectId: 's', targetDigest: p1.proposal.candidateDigest, consumerId: 'c1', verdict: 'PASS', producedAt: 0 });
  const req = service.requestWaiver({
    subjectId: 's', candidateDigest: p1.proposal.candidateDigest, consumerId: 'c2',
    compatDirection: 'COMPATIBLE', reason: 'c2 offline', requestedBy: 'alice', ttlMs: 100000
  });
  const waiverId = (req as any).waiver.waiverId;
  service.confirmWaiver(waiverId, 'bob');
  assert.equal(service.getProposalView(p1.proposal.proposalId)!.gate.status, 'READY');

  // Correct the candidate. The old waiver must lapse, not carry over.
  const p2 = service.submitCandidate({ subjectId: 's', baselineSchema: baseline, candidateSchema: v2, submittedBy: 'dev' });
  assert.equal(service.getWaiver(waiverId)!.status, 'LAPSED');

  // Even if a same-named consumer is missing on the successor, the old waiver
  // (scoped to the old digest) does not apply.
  const v2gate = service.getProposalView(p2.proposal.proposalId)!.gate;
  assert.equal(v2gate.status, 'COLLECTING');
  assert.ok(!v2gate.consumers.some((c) => c.status === 'WAIVED'));
});

test('concurrent late result for the old candidate stays with it and never releases the successor', () => {
  const { service } = newService();
  const p1 = setup(service);
  const p2 = service.submitCandidate({ subjectId: 's', baselineSchema: baseline, candidateSchema: v2, submittedBy: 'dev' });

  // A build agent finishes validating the OLD candidate after replacement.
  const outcome = service.reportEvidence({
    reportId: 'late-1', subjectId: 's', targetDigest: p1.proposal.candidateDigest, consumerId: 'c1', verdict: 'PASS', producedAt: 0
  });
  assert.equal(outcome.status, 'IGNORED');

  // Successor is untouched, and the ignored report is attributed to the old proposal.
  assert.equal(service.getProposalView(p2.proposal.proposalId)!.gate.status, 'COLLECTING');
  const old = service.getProposalView(p1.proposal.proposalId)!;
  assert.equal(old.gate.status, 'COLLECTING'); // it's SUPERSEDED; evidence not applied
});

test('expectedPredecessorId guards against replacing a different candidate', () => {
  const { service, repo } = newService();
  const p1 = setup(service);
  const p2 = service.submitCandidate({ subjectId: 's', baselineSchema: baseline, candidateSchema: v2, submittedBy: 'dev' });

  // Trying to succeed the stale p1 now fails: the current open proposal is p2.
  assert.throws(
    () =>
      service.submitCandidate({
        subjectId: 's', baselineSchema: baseline,
        candidateSchema: { type: 'object', properties: { id: { type: 'string' }, c: { type: 'boolean' } }, required: ['id'] },
        submittedBy: 'dev', expectedPredecessorId: p1.proposal.proposalId
      }),
    /expected to succeed proposal/
  );
  // p2 remains the single open proposal.
  assert.equal(repo.getOpenProposal('s')!.proposalId, p2.proposal.proposalId);
});

test('replacement, waiver lapse, and late results are recorded and recover from SQLite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccc-lineage-'));
  const dbPath = join(dir, 'db.sqlite');
  try {
    let p1Id: string;
    let p2Id: string;
    let waiverId: string;
    let p1Digest: string;
    {
      const repo = new SqliteRepository(dbPath);
      const service = new ControlCenterService(repo, new LogicalClock(0), new ArmableFaults());
      const p1 = setup(service);
      p1Id = p1.proposal.proposalId;
      p1Digest = p1.proposal.candidateDigest;
      const req = service.requestWaiver({
        subjectId: 's', candidateDigest: p1Digest, consumerId: 'c2',
        compatDirection: 'COMPATIBLE', reason: 'offline', requestedBy: 'alice', ttlMs: 100000
      });
      waiverId = (req as any).waiver.waiverId;
      service.confirmWaiver(waiverId, 'bob');
      const p2 = service.submitCandidate({ subjectId: 's', baselineSchema: baseline, candidateSchema: v2, submittedBy: 'dev' });
      p2Id = p2.proposal.proposalId;
      // Late result for the replaced candidate.
      service.reportEvidence({ reportId: 'late-1', subjectId: 's', targetDigest: p1Digest, consumerId: 'c1', verdict: 'PASS', producedAt: 0 });
      repo.close();
    }
    {
      const repo = new SqliteRepository(dbPath);
      const service = new ControlCenterService(repo, new LogicalClock(50), new ArmableFaults());
      // Lineage recovered.
      assert.equal(service.getProposalView(p2Id)!.lineage.predecessorId, p1Id);
      assert.equal(service.getProposalView(p1Id)!.lineage.successorId, p2Id);
      // Waiver lapsed and stays lapsed.
      assert.equal(service.getWaiver(waiverId)!.status, 'LAPSED');
      // Causal chain has the replacement, lapse, and ignored-late records.
      const types = service.listEvents(0).map((e) => e.type);
      assert.ok(types.includes('proposal.replaced'), 'proposal.replaced recorded');
      assert.ok(types.includes('waiver.lapsed'), 'waiver.lapsed recorded');
      assert.ok(types.includes('evidence.ignored'), 'late evidence.ignored recorded');
      // Successor still not releasable.
      assert.equal(service.getProposalView(p2Id)!.gate.status, 'COLLECTING');
      repo.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
