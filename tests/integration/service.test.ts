import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ControlCenterService } from '../../src/app/control-center-service.ts';
import { SqliteRepository } from '../../src/adapters/store/sqlite-repository.ts';
import { LogicalClock } from '../../src/domain/clock.ts';
import { ArmableFaults, InjectedCrash } from '../../src/ports/faults.ts';
import { candidateDigest } from '../../src/domain/digest.ts';

const baseline = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };
const candidate = { type: 'object', properties: { id: { type: 'string' }, extra: { type: 'string' } }, required: ['id'] };
const candidate2 = { type: 'object', properties: { id: { type: 'string' }, other: { type: 'number' } }, required: ['id'] };

function newService(clock = new LogicalClock(0), faults = new ArmableFaults()) {
  const repo = new SqliteRepository(':memory:');
  const service = new ControlCenterService(repo, clock, faults);
  return { repo, service, clock, faults };
}

test('submit is idempotent by canonical digest', () => {
  const { service } = newService();
  service.registerSubject({ subjectId: 's', requiredConsumers: ['c'], freshnessWindowMs: 1000 });
  const r1 = service.submitCandidate({ subjectId: 's', baselineSchema: baseline, candidateSchema: candidate, submittedBy: 'dev' });
  // Resubmit same schema with reordered keys.
  const reordered = { required: ['id'], properties: { extra: { type: 'string' }, id: { type: 'string' } }, type: 'object' };
  const r2 = service.submitCandidate({ subjectId: 's', baselineSchema: baseline, candidateSchema: reordered, submittedBy: 'dev' });
  assert.equal(r2.deduplicated, true);
  assert.equal(r1.proposal.proposalId, r2.proposal.proposalId);
});

test('new candidate supersedes the previous open proposal', () => {
  const { service, repo } = newService();
  service.registerSubject({ subjectId: 's', requiredConsumers: ['c'], freshnessWindowMs: 1000 });
  const r1 = service.submitCandidate({ subjectId: 's', baselineSchema: baseline, candidateSchema: candidate, submittedBy: 'dev' });
  service.submitCandidate({ subjectId: 's', baselineSchema: baseline, candidateSchema: candidate2, submittedBy: 'dev' });
  assert.equal(repo.getProposal(r1.proposal.proposalId)!.state, 'SUPERSEDED');
});

test('duplicate evidence report id applied once', () => {
  const { service } = newService();
  service.registerSubject({ subjectId: 's', requiredConsumers: ['c'], freshnessWindowMs: 1000 });
  const p = service.submitCandidate({ subjectId: 's', baselineSchema: baseline, candidateSchema: candidate, submittedBy: 'dev' });
  const digest = p.proposal.candidateDigest;
  const first = service.reportEvidence({ reportId: 'r1', subjectId: 's', targetDigest: digest, consumerId: 'c', verdict: 'PASS', producedAt: 0 });
  const dup = service.reportEvidence({ reportId: 'r1', subjectId: 's', targetDigest: digest, consumerId: 'c', verdict: 'PASS', producedAt: 0 });
  assert.equal(first.status, 'APPLIED');
  assert.equal(dup.status, 'DUPLICATE');
  const view = service.getProposalView(p.proposal.proposalId)!;
  assert.equal(view.gate.status, 'READY');
});

test('late evidence for a superseded candidate is ignored', () => {
  const { service } = newService();
  service.registerSubject({ subjectId: 's', requiredConsumers: ['c'], freshnessWindowMs: 1000 });
  const old = service.submitCandidate({ subjectId: 's', baselineSchema: baseline, candidateSchema: candidate, submittedBy: 'dev' });
  const oldDigest = old.proposal.candidateDigest;
  const cur = service.submitCandidate({ subjectId: 's', baselineSchema: baseline, candidateSchema: candidate2, submittedBy: 'dev' });
  const outcome = service.reportEvidence({ reportId: 'r-late', subjectId: 's', targetDigest: oldDigest, consumerId: 'c', verdict: 'PASS', producedAt: 0 });
  assert.equal(outcome.status, 'IGNORED');
  assert.equal(service.getProposalView(cur.proposal.proposalId)!.gate.status, 'COLLECTING');
});

test('unknown consumer evidence is stored but not applied', () => {
  const { service } = newService();
  service.registerSubject({ subjectId: 's', requiredConsumers: ['c'], freshnessWindowMs: 1000 });
  const p = service.submitCandidate({ subjectId: 's', baselineSchema: baseline, candidateSchema: candidate, submittedBy: 'dev' });
  const outcome = service.reportEvidence({ reportId: 'r-x', subjectId: 's', targetDigest: p.proposal.candidateDigest, consumerId: 'rogue', verdict: 'PASS', producedAt: 0 });
  assert.equal(outcome.status, 'IGNORED');
});

test('cannot approve until evidence complete; then approve freezes snapshot', () => {
  const { service } = newService();
  service.registerSubject({ subjectId: 's', requiredConsumers: ['c1', 'c2'], freshnessWindowMs: 1000 });
  const p = service.submitCandidate({ subjectId: 's', baselineSchema: baseline, candidateSchema: candidate, submittedBy: 'dev' });
  const digest = p.proposal.candidateDigest;
  service.reportEvidence({ reportId: 'e1', subjectId: 's', targetDigest: digest, consumerId: 'c1', verdict: 'PASS', producedAt: 0 });

  const tooEarly = service.decide({ proposalId: p.proposal.proposalId, expectedDigest: digest, type: 'APPROVE', decidedBy: 'mgr' });
  assert.equal(tooEarly.status, 'REJECTED_PRECONDITION');

  service.reportEvidence({ reportId: 'e2', subjectId: 's', targetDigest: digest, consumerId: 'c2', verdict: 'PASS', producedAt: 0 });
  const ok = service.decide({ proposalId: p.proposal.proposalId, expectedDigest: digest, type: 'APPROVE', decidedBy: 'mgr' });
  assert.equal(ok.status, 'DECIDED');

  // Later evidence must NOT change the frozen decision snapshot.
  const snapshotBefore = JSON.stringify((ok as any).decision.gateSnapshot);
  service.reportEvidence({ reportId: 'e3', subjectId: 's', targetDigest: digest, consumerId: 'c1', verdict: 'FAIL', producedAt: 10 });
  const view = service.getProposalView(p.proposal.proposalId)!;
  assert.equal(JSON.stringify(view.decision!.gateSnapshot), snapshotBefore);
  assert.equal(view.proposal.state, 'APPROVED');
});

test('digest mismatch on decide is rejected (stale view)', () => {
  const { service } = newService();
  service.registerSubject({ subjectId: 's', requiredConsumers: ['c'], freshnessWindowMs: 1000 });
  const p = service.submitCandidate({ subjectId: 's', baselineSchema: baseline, candidateSchema: candidate, submittedBy: 'dev' });
  const bad = service.decide({ proposalId: p.proposal.proposalId, expectedDigest: 'sha256:wrong', type: 'APPROVE', decidedBy: 'mgr' });
  assert.equal(bad.status, 'REJECTED_PRECONDITION');
});

test('second decision on a decided proposal conflicts (immutable)', () => {
  const { service } = newService();
  service.registerSubject({ subjectId: 's', requiredConsumers: ['c'], freshnessWindowMs: 1000 });
  const p = service.submitCandidate({ subjectId: 's', baselineSchema: baseline, candidateSchema: candidate, submittedBy: 'dev' });
  const digest = p.proposal.candidateDigest;
  service.reportEvidence({ reportId: 'e1', subjectId: 's', targetDigest: digest, consumerId: 'c', verdict: 'PASS', producedAt: 0 });
  const first = service.decide({ proposalId: p.proposal.proposalId, expectedDigest: digest, type: 'APPROVE', decidedBy: 'mgr' });
  assert.equal(first.status, 'DECIDED');
  const second = service.decide({ proposalId: p.proposal.proposalId, expectedDigest: digest, type: 'REJECT', decidedBy: 'other' });
  assert.equal(second.status, 'CONFLICT');
});

test('freshness expires with logical time', () => {
  const clock = new LogicalClock(0);
  const { service } = newService(clock);
  service.registerSubject({ subjectId: 's', requiredConsumers: ['c'], freshnessWindowMs: 1000 });
  const p = service.submitCandidate({ subjectId: 's', baselineSchema: baseline, candidateSchema: candidate, submittedBy: 'dev' });
  service.reportEvidence({ reportId: 'e1', subjectId: 's', targetDigest: p.proposal.candidateDigest, consumerId: 'c', verdict: 'PASS', producedAt: 0 });
  assert.equal(service.getProposalView(p.proposal.proposalId)!.gate.status, 'READY');
  clock.advance(1500);
  assert.equal(service.getProposalView(p.proposal.proposalId)!.gate.status, 'COLLECTING');
});

test('injected crash after evidence write leaves durable state; retry is DUPLICATE', () => {
  const clock = new LogicalClock(0);
  const faults = new ArmableFaults();
  const { service } = newService(clock, faults);
  service.registerSubject({ subjectId: 's', requiredConsumers: ['c'], freshnessWindowMs: 1000 });
  const p = service.submitCandidate({ subjectId: 's', baselineSchema: baseline, candidateSchema: candidate, submittedBy: 'dev' });
  const digest = p.proposal.candidateDigest;

  faults.arm('evidence.after-write-before-reply', 1);
  assert.throws(
    () => service.reportEvidence({ reportId: 'e1', subjectId: 's', targetDigest: digest, consumerId: 'c', verdict: 'PASS', producedAt: 0 }),
    InjectedCrash
  );
  // The write committed before the crash; a retry reconciles to DUPLICATE.
  const retry = service.reportEvidence({ reportId: 'e1', subjectId: 's', targetDigest: digest, consumerId: 'c', verdict: 'PASS', producedAt: 0 });
  assert.equal(retry.status, 'DUPLICATE');
  assert.equal(service.getProposalView(p.proposal.proposalId)!.gate.status, 'READY');
});
