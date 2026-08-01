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
const candidate = { type: 'object', properties: { id: { type: 'string' }, extra: { type: 'string' } }, required: ['id'] };

test('full state and causal log recover from SQLite after restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccc-recover-'));
  const dbPath = join(dir, 'db.sqlite');
  try {
    let proposalId: string;
    let digest: string;

    // --- first "process" ---
    {
      const repo = new SqliteRepository(dbPath);
      const service = new ControlCenterService(repo, new LogicalClock(0), new ArmableFaults());
      service.registerSubject({ subjectId: 's', requiredConsumers: ['c'], freshnessWindowMs: 1000 });
      const p = service.submitCandidate({ subjectId: 's', baselineSchema: baseline, candidateSchema: candidate, submittedBy: 'dev' });
      proposalId = p.proposal.proposalId;
      digest = p.proposal.candidateDigest;
      service.reportEvidence({ reportId: 'e1', subjectId: 's', targetDigest: digest, consumerId: 'c', verdict: 'PASS', producedAt: 0 });
      const decided = service.decide({ proposalId, expectedDigest: digest, type: 'APPROVE', decidedBy: 'mgr' });
      assert.equal(decided.status, 'DECIDED');
      repo.close();
    }

    // --- restart: reopen the same file ---
    {
      const repo = new SqliteRepository(dbPath);
      const service = new ControlCenterService(repo, new LogicalClock(100), new ArmableFaults());
      const view = service.getProposalView(proposalId)!;
      assert.equal(view.proposal.state, 'APPROVED', 'decision survives restart');
      assert.ok(view.decision, 'decision snapshot survives restart');

      // Causal log is intact and explains the history.
      const events = service.listEvents(0);
      const types = events.map((e) => e.type);
      assert.ok(types.includes('subject.registered'));
      assert.ok(types.includes('proposal.submitted'));
      assert.ok(types.includes('evidence.applied'));
      assert.ok(types.includes('decision.committed'));

      // A late FAIL after restart must not change the frozen decision.
      const frozen = JSON.stringify(view.decision!.gateSnapshot);
      service.reportEvidence({ reportId: 'e-late', subjectId: 's', targetDigest: digest, consumerId: 'c', verdict: 'FAIL', producedAt: 100 });
      const after = service.getProposalView(proposalId)!;
      assert.equal(JSON.stringify(after.decision!.gateSnapshot), frozen);
      repo.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('crash before reply on decision: state committed, retry sees CONFLICT, no second decision', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccc-crash-'));
  const dbPath = join(dir, 'db.sqlite');
  try {
    const repo = new SqliteRepository(dbPath);
    const faults = new ArmableFaults();
    const service = new ControlCenterService(repo, new LogicalClock(0), faults);
    service.registerSubject({ subjectId: 's', requiredConsumers: ['c'], freshnessWindowMs: 1000 });
    const p = service.submitCandidate({ subjectId: 's', baselineSchema: baseline, candidateSchema: candidate, submittedBy: 'dev' });
    const digest = p.proposal.candidateDigest;
    service.reportEvidence({ reportId: 'e1', subjectId: 's', targetDigest: digest, consumerId: 'c', verdict: 'PASS', producedAt: 0 });

    faults.arm('decision.after-commit-before-reply', 1);
    assert.throws(
      () => service.decide({ proposalId: p.proposal.proposalId, expectedDigest: digest, type: 'APPROVE', decidedBy: 'mgr' }),
      InjectedCrash
    );

    // The decision committed before the crash. A retry must not create a
    // second (possibly contradictory) decision.
    const retry = service.decide({ proposalId: p.proposal.proposalId, expectedDigest: digest, type: 'REJECT', decidedBy: 'mgr' });
    assert.equal(retry.status, 'CONFLICT');
    const view = service.getProposalView(p.proposal.proposalId)!;
    assert.equal(view.proposal.state, 'APPROVED');
    repo.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
