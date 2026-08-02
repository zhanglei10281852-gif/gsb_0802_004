import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DB } from '../src/storage/schema.js';
import { ProposalRepository, type EvidenceInput } from '../src/storage/repository.js';
import { ManualClock } from '../src/core/clock.js';
import { GateBlockedError, ConflictError, ProposalAlreadyDecidedError } from '../src/core/errors.js';
import type { ProposalInput } from '../src/core/types.js';

function makeRepo(): { repo: ProposalRepository; db: DB; clock: ManualClock; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gate-test-'));
  const db = openDatabase(join(dir, 'test.sqlite'));
  const clock = new ManualClock(1_000_000);
  const repo = new ProposalRepository(db, clock);
  return { repo, db, clock, dir };
}

function sampleProposal(overrides: Partial<ProposalInput> = {}): ProposalInput {
  return {
    topic: 'order.events',
    baseline: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { id: { type: 'string' }, amt: { type: 'number', minimum: 0 } },
      required: ['id', 'amt'],
      additionalProperties: true,
    },
    candidate: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { id: { type: 'string' }, amt: { type: 'number', minimum: 0 }, note: { type: 'string' } },
      required: ['id', 'amt'],
      additionalProperties: true,
    },
    consumers: [
      { consumerId: 'billing', schema: { type: 'object' } },
      { consumerId: 'payments', schema: { type: 'object' } },
    ],
    author: 'alice',
    ttlMs: 60000,
    ...overrides,
  };
}

function evidence(proposalId: string, digest: string, consumerId: string, key: string, status: 'pass' | 'fail' | 'error' = 'pass', clock: ManualClock): EvidenceInput {
  return {
    proposalId,
    candidateDigest: digest,
    consumerId,
    status,
    detail: `${status} result`,
    reportedAt: clock.now(),
    idempotencyKey: key,
    agentRunId: 'run-1',
  };
}

test('proposal creation computes stable digest and advances to collecting once evidence arrives', () => {
  const { repo, db, clock, dir } = makeRepo();
  try {
    const { proposal } = repo.create(sampleProposal());
    assert.equal(proposal.status, 'open');
    assert.match(proposal.candidateDigest, /^[0-9a-f]{64}$/);
    const ing = repo.ingestEvidence(evidence(proposal.proposalId, proposal.candidateDigest, 'billing', 'k1', 'pass', clock));
    assert.equal(ing.accepted, true);
    repo.refreshGateStatus(proposal.proposalId);
    const p = repo.requireById(proposal.proposalId);
    assert.equal(p.status, 'collecting');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('same idempotency key is only effective once (duplicate retries deduped)', () => {
  const { repo, db, clock, dir } = makeRepo();
  try {
    const { proposal } = repo.create(sampleProposal());
    const e1 = repo.ingestEvidence(evidence(proposal.proposalId, proposal.candidateDigest, 'billing', 'same-key', 'pass', clock));
    assert.equal(e1.accepted, true);
    assert.equal(e1.deduped, false);
    const e2 = repo.ingestEvidence(evidence(proposal.proposalId, proposal.candidateDigest, 'billing', 'same-key', 'fail', clock));
    assert.equal(e2.accepted, true);
    assert.equal(e2.deduped, true);
    if (e2.accepted && e2.evidence) {
      assert.equal(e2.evidence.status, 'pass');
    }
    const all = repo.getEvidence(proposal.proposalId);
    assert.equal(all.length, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('different consumers with separate keys both count', () => {
  const { repo, db, clock, dir } = makeRepo();
  try {
    const { proposal } = repo.create(sampleProposal());
    repo.ingestEvidence(evidence(proposal.proposalId, proposal.candidateDigest, 'billing', 'k1', 'pass', clock));
    repo.ingestEvidence(evidence(proposal.proposalId, proposal.candidateDigest, 'payments', 'k2', 'pass', clock));
    const all = repo.getEvidence(proposal.proposalId);
    assert.equal(all.length, 2);
    const refreshed = repo.refreshGateStatus(proposal.proposalId);
    assert.equal(refreshed.proposal.status, 'ready');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('wrong candidate digest is rejected and cannot pollute proposal', () => {
  const { repo, db, clock, dir } = makeRepo();
  try {
    const { proposal } = repo.create(sampleProposal());
    const r = repo.ingestEvidence(evidence(proposal.proposalId, 'f'.repeat(64), 'billing', 'k1', 'pass', clock));
    assert.equal(r.accepted, false);
    assert.equal(r.reason, 'candidate-mismatch');
    const all = repo.getEvidence(proposal.proposalId);
    assert.equal(all.length, 0);
    const events = repo.events.readForProposal(proposal.proposalId);
    assert.ok(events.some((e) => e.eventType === 'evidence-rejected'));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown consumer evidence is rejected', () => {
  const { repo, db, clock, dir } = makeRepo();
  try {
    const { proposal } = repo.create(sampleProposal());
    const r = repo.ingestEvidence(evidence(proposal.proposalId, proposal.candidateDigest, 'analytics', 'k1', 'pass', clock));
    assert.equal(r.accepted, false);
    assert.equal(r.reason, 'unknown-consumer');
    assert.equal(repo.getEvidence(proposal.proposalId).length, 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cannot approve when blockers exist', () => {
  const { repo, db, clock, dir } = makeRepo();
  try {
    const { proposal } = repo.create(sampleProposal());
    repo.ingestEvidence(evidence(proposal.proposalId, proposal.candidateDigest, 'billing', 'k1', 'pass', clock));
    assert.throws(
      () => repo.decide({ proposalId: proposal.proposalId, kind: 'approve', decider: 'mgr', rationale: 'x' }),
      GateBlockedError,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reject is allowed even with blockers', () => {
  const { repo, db, clock, dir } = makeRepo();
  try {
    const { proposal } = repo.create(sampleProposal());
    const result = repo.decide({ proposalId: proposal.proposalId, kind: 'reject', decider: 'mgr', rationale: 'incomplete' });
    assert.equal(result.proposal.status, 'rejected');
    assert.ok(result.proposal.decision);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent approve decisions cannot both succeed (compare-and-swap)', () => {
  const { repo, db, clock, dir } = makeRepo();
  try {
    const { proposal } = repo.create(sampleProposal());
    repo.ingestEvidence(evidence(proposal.proposalId, proposal.candidateDigest, 'billing', 'k1', 'pass', clock));
    repo.ingestEvidence(evidence(proposal.proposalId, proposal.candidateDigest, 'payments', 'k2', 'pass', clock));
    repo.refreshGateStatus(proposal.proposalId);
    let firstOk = false;
    let secondRejected = false;
    try {
      repo.decide({ proposalId: proposal.proposalId, kind: 'approve', decider: 'mgr-1', rationale: 'first' });
      firstOk = true;
    } catch { /* ignore */ }
    try {
      repo.decide({ proposalId: proposal.proposalId, kind: 'reject', decider: 'mgr-2', rationale: 'second' });
    } catch (e) {
      if (e instanceof ConflictError || e instanceof ProposalAlreadyDecidedError) secondRejected = true;
      else throw e;
    }
    assert.equal(firstOk, true);
    assert.equal(secondRejected, true);
    const final = repo.requireById(proposal.proposalId);
    assert.equal(final.status, 'approved');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cross-connection CAS: two concurrent decision writers cannot both win', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-cas-'));
  const dbPath = join(dir, 'cas.sqlite');
  const clock = new ManualClock(1_000_000);
  const db1 = openDatabase(dbPath);
  const repo1 = new ProposalRepository(db1, clock);
  const { proposal } = repo1.create(sampleProposal());
  repo1.ingestEvidence(evidence(proposal.proposalId, proposal.candidateDigest, 'billing', 'k1', 'pass', clock));
  repo1.ingestEvidence(evidence(proposal.proposalId, proposal.candidateDigest, 'payments', 'k2', 'pass', clock));
  repo1.refreshGateStatus(proposal.proposalId);

  const db2 = openDatabase(dbPath);
  const repo2 = new ProposalRepository(db2, new ManualClock(1_000_000));
  try {
    const r1 = repo1.decide({ proposalId: proposal.proposalId, kind: 'approve', decider: 'writer-1', rationale: 'a' });
    assert.equal(r1.proposal.status, 'approved');
    assert.throws(
      () => repo2.decide({ proposalId: proposal.proposalId, kind: 'reject', decider: 'writer-2', rationale: 'b' }),
      (e: unknown) => e instanceof ConflictError || e instanceof ProposalAlreadyDecidedError,
    );
    const final = repo1.requireById(proposal.proposalId);
    assert.equal(final.status, 'approved');
    assert.equal(final.decision!.decider, 'writer-1');
  } finally {
    db1.close();
    db2.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('decision snapshot captures exact evidence digest and late evidence does not change it', () => {
  const { repo, db, clock, dir } = makeRepo();
  try {
    const { proposal } = repo.create(sampleProposal());
    repo.ingestEvidence(evidence(proposal.proposalId, proposal.candidateDigest, 'billing', 'k1', 'pass', clock));
    repo.ingestEvidence(evidence(proposal.proposalId, proposal.candidateDigest, 'payments', 'k2', 'pass', clock));
    repo.refreshGateStatus(proposal.proposalId);
    const decided = repo.decide({ proposalId: proposal.proposalId, kind: 'approve', decider: 'mgr', rationale: 'ok' });
    const snapshotDigest = decided.proposal.decision!.evidenceDigest;

    clock.advance(1000);
    const late = repo.ingestEvidence(evidence(proposal.proposalId, proposal.candidateDigest, 'billing', 'k3', 'fail', clock));
    assert.equal(late.accepted, false);
    assert.equal(late.reason, 'proposal-decided');
    const after = repo.requireById(proposal.proposalId);
    assert.equal(after.status, 'approved');
    assert.equal(after.decision!.evidenceDigest, snapshotDigest);
    assert.equal(after.decision!.kind, 'approve');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restart from SQLite restores full state and verifies hash chain', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-restart-'));
  const dbPath = join(dir, 'restart.sqlite');
  const clock = new ManualClock(1_000_000);
  const db1 = openDatabase(dbPath);
  let repo = new ProposalRepository(db1, clock);
  let proposalId = '';
  let db2: DB | null = null;
  try {
    const { proposal } = repo.create(sampleProposal());
    proposalId = proposal.proposalId;
    repo.ingestEvidence(evidence(proposalId, proposal.candidateDigest, 'billing', 'k1', 'pass', clock));
    repo.ingestEvidence(evidence(proposalId, proposal.candidateDigest, 'payments', 'k2', 'pass', clock));
    repo.refreshGateStatus(proposalId);
    repo.decide({ proposalId, kind: 'approve', decider: 'mgr', rationale: 'ok' });
    db1.close();

    db2 = openDatabase(dbPath);
    const clock2 = new ManualClock(1_000_000);
    repo = new ProposalRepository(db2, clock2);
    const restored = repo.requireById(proposalId);
    assert.equal(restored.status, 'approved');
    assert.ok(restored.decision);
    assert.equal(restored.decision!.candidateDigest, restored.candidateDigest);
    const ev = repo.getEvidence(proposalId);
    assert.equal(ev.length, 2);
    assert.equal(repo.events.verifyChain(proposalId), true);
    const events = repo.events.readForProposal(proposalId);
    assert.ok(events.length >= 4);
    let prev = '0'.repeat(64);
    for (const e of events) {
      assert.equal(e.prevHash, prev);
      prev = e.hash;
    }
    db2.close();
    db2 = null;
  } finally {
    try { db1.open && db1.close(); } catch { /* already closed */ }
    if (db2) { try { db2.close(); } catch { /* ignore */ } }
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
  }
});

test('event log hash chain is tamper-evident', () => {
  const { repo, db, dir } = makeRepo();
  try {
    const { proposal } = repo.create(sampleProposal());
    assert.equal(repo.events.verifyChain(proposal.proposalId), true);
    db.prepare('UPDATE event_log SET payload_json = ? WHERE event_id = 1').run('{"tampered":true}');
    assert.equal(repo.events.verifyChain(proposal.proposalId), false);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
