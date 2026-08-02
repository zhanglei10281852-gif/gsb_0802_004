import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DB } from '../src/storage/schema.js';
import { ProposalRepository, type EvidenceInput } from '../src/storage/repository.js';
import { ExemptionRepository } from '../src/storage/exemption-repository.js';
import { ManualClock } from '../src/core/clock.js';
import { evaluateGate } from '../src/core/gate.js';
import { ConflictError, ValidationError } from '../src/core/errors.js';
import type { ExemptionRecord, ProposalInput } from '../src/core/types.js';

function setup(): { db: DB; repo: ProposalRepository; ex: ExemptionRepository; clock: ManualClock; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gate-ex-'));
  const db = openDatabase(join(dir, 'ex.sqlite'));
  const clock = new ManualClock(1_000_000);
  const repo = new ProposalRepository(db, clock);
  const ex = new ExemptionRepository(db, clock, repo.events);
  repo.setExemptionRepository(ex);
  return { db, repo, ex, clock, dir };
}

function sampleProposal(): ProposalInput {
  return {
    topic: 'order.events',
    baseline: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: true,
    },
    candidate: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { id: { type: 'string' }, note: { type: 'string' } },
      required: ['id'],
      additionalProperties: true,
    },
    consumers: [
      { consumerId: 'billing', schema: { type: 'object' } },
      { consumerId: 'payments', schema: { type: 'object' } },
    ],
    author: 'alice',
    ttlMs: 60000,
  };
}

function pass(proposalId: string, digest: string, consumerId: string, key: string, clock: ManualClock): EvidenceInput {
  return {
    proposalId,
    candidateDigest: digest,
    consumerId,
    status: 'pass',
    detail: 'ok',
    reportedAt: clock.now(),
    idempotencyKey: key,
    agentRunId: 'r',
  };
}

test('exemption needs two distinct reviewers; requester cannot self-review', () => {
  const { repo, ex, db, dir } = setup();
  try {
    const { proposal } = repo.create(sampleProposal());
    const rec = ex.request({
      proposalId: proposal.proposalId,
      consumerId: 'payments',
      environment: 'prod',
      direction: 'backward',
      reason: 'offline',
      requestedBy: 'alice',
      ttlMs: 60000,
    });
    assert.equal(rec.status, 'pending');

    assert.throws(
      () => ex.review({ exemptionId: rec.exemptionId, reviewer: 'alice', approved: true, comment: '' }),
      ConflictError,
    );

    const afterFirst = ex.review({ exemptionId: rec.exemptionId, reviewer: 'bob', approved: true, comment: '' });
    assert.equal(afterFirst.status, 'pending');

    assert.throws(
      () => ex.review({ exemptionId: rec.exemptionId, reviewer: 'bob', approved: true, comment: 'again' }),
      ConflictError,
    );

    const afterSecond = ex.review({ exemptionId: rec.exemptionId, reviewer: 'carol', approved: true, comment: '' });
    assert.equal(afterSecond.status, 'approved');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a rejection is final and no further reviews are allowed', () => {
  const { repo, ex, db, dir } = setup();
  try {
    const { proposal } = repo.create(sampleProposal());
    const rec = ex.request({
      proposalId: proposal.proposalId,
      consumerId: 'payments',
      environment: 'prod',
      direction: 'backward',
      reason: 'offline',
      requestedBy: 'alice',
      ttlMs: 60000,
    });
    const rejected = ex.review({ exemptionId: rec.exemptionId, reviewer: 'bob', approved: false, comment: 'no' });
    assert.equal(rejected.status, 'rejected');
    assert.throws(
      () => ex.review({ exemptionId: rec.exemptionId, reviewer: 'carol', approved: true, comment: '' }),
      ConflictError,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('active exemption for an offline consumer clears its missing-evidence blocker', () => {
  const { repo, ex, clock, db, dir } = setup();
  try {
    const { proposal } = repo.create(sampleProposal());
    repo.ingestEvidence(pass(proposal.proposalId, proposal.candidateDigest, 'billing', 'k1', clock));

    let view = evaluateGate({
      compatibility: proposal.compatibility,
      consumers: proposal.consumers,
      evidence: repo.getEvidence(proposal.proposalId),
      exemptions: ex.listEffectiveForProposal(proposal.proposalId),
      ttlMs: proposal.ttlMs,
      environment: 'prod',
      clock,
      currentStatus: proposal.status,
    });
    assert.equal(view.blockers.length, 1);
    assert.equal(view.blockers[0]!.code, 'missing-evidence');

    const rec = ex.request({
      proposalId: proposal.proposalId,
      consumerId: 'payments',
      environment: 'prod',
      direction: 'backward',
      reason: 'offline',
      requestedBy: 'alice',
      ttlMs: 60000,
    });
    ex.review({ exemptionId: rec.exemptionId, reviewer: 'bob', approved: true, comment: '' });
    ex.review({ exemptionId: rec.exemptionId, reviewer: 'carol', approved: true, comment: '' });

    view = evaluateGate({
      compatibility: proposal.compatibility,
      consumers: proposal.consumers,
      evidence: repo.getEvidence(proposal.proposalId),
      exemptions: ex.listEffectiveForProposal(proposal.proposalId),
      ttlMs: proposal.ttlMs,
      environment: 'prod',
      clock,
      currentStatus: proposal.status,
    });
    assert.equal(view.blockers.length, 0);
    assert.equal(view.appliedExemptions.length, 1);
    assert.equal(view.appliedExemptions[0]!.consumerId, 'payments');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exemption scope must match environment and consumer', () => {
  const { repo, ex, clock, db, dir } = setup();
  try {
    const { proposal } = repo.create(sampleProposal());
    repo.ingestEvidence(pass(proposal.proposalId, proposal.candidateDigest, 'billing', 'k1', clock));
    const rec = ex.request({
      proposalId: proposal.proposalId,
      consumerId: 'payments',
      environment: 'staging',
      direction: 'backward',
      reason: 'offline',
      requestedBy: 'alice',
      ttlMs: 60000,
    });
    ex.review({ exemptionId: rec.exemptionId, reviewer: 'bob', approved: true, comment: '' });
    ex.review({ exemptionId: rec.exemptionId, reviewer: 'carol', approved: true, comment: '' });

    const prodView = evaluateGate({
      compatibility: proposal.compatibility,
      consumers: proposal.consumers,
      evidence: repo.getEvidence(proposal.proposalId),
      exemptions: ex.listEffectiveForProposal(proposal.proposalId),
      ttlMs: proposal.ttlMs,
      environment: 'prod',
      clock,
      currentStatus: proposal.status,
    });
    assert.equal(prodView.blockers.length, 1);
    assert.equal(prodView.appliedExemptions.length, 0);

    const stagingView = evaluateGate({
      compatibility: proposal.compatibility,
      consumers: proposal.consumers,
      evidence: repo.getEvidence(proposal.proposalId),
      exemptions: ex.listEffectiveForProposal(proposal.proposalId),
      ttlMs: proposal.ttlMs,
      environment: 'staging',
      clock,
      currentStatus: proposal.status,
    });
    assert.equal(stagingView.blockers.length, 0);
    assert.equal(stagingView.appliedExemptions.length, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('expired exemption no longer applies after TTL; revive only via new exemption', () => {
  const { repo, ex, clock, db, dir } = setup();
  try {
    const { proposal } = repo.create(sampleProposal());
    repo.ingestEvidence(pass(proposal.proposalId, proposal.candidateDigest, 'billing', 'k1', clock));
    const rec = ex.request({
      proposalId: proposal.proposalId,
      consumerId: 'payments',
      environment: 'prod',
      direction: 'backward',
      reason: 'offline',
      requestedBy: 'alice',
      ttlMs: 30000,
    });
    ex.review({ exemptionId: rec.exemptionId, reviewer: 'bob', approved: true, comment: '' });
    ex.review({ exemptionId: rec.exemptionId, reviewer: 'carol', approved: true, comment: '' });

    clock.advance(31000);
    const view = evaluateGate({
      compatibility: proposal.compatibility,
      consumers: proposal.consumers,
      evidence: repo.getEvidence(proposal.proposalId),
      exemptions: ex.listEffectiveForProposal(proposal.proposalId),
      ttlMs: proposal.ttlMs,
      environment: 'prod',
      clock,
      currentStatus: proposal.status,
    });
    assert.equal(view.blockers.length, 1);
    assert.equal(view.blockers[0]!.code, 'missing-evidence');
    assert.equal(view.appliedExemptions.length, 0);
    assert.equal(ex.getById(rec.exemptionId)?.status, 'expired');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('revoked exemption no longer applies and cannot be re-reviewed', () => {
  const { repo, ex, clock, db, dir } = setup();
  try {
    const { proposal } = repo.create(sampleProposal());
    repo.ingestEvidence(pass(proposal.proposalId, proposal.candidateDigest, 'billing', 'k1', clock));
    const rec = ex.request({
      proposalId: proposal.proposalId,
      consumerId: 'payments',
      environment: 'prod',
      direction: 'backward',
      reason: 'offline',
      requestedBy: 'alice',
      ttlMs: 60000,
    });
    ex.review({ exemptionId: rec.exemptionId, reviewer: 'bob', approved: true, comment: '' });
    ex.review({ exemptionId: rec.exemptionId, reviewer: 'carol', approved: true, comment: '' });
    const revoked = ex.revoke(rec.exemptionId, 'bob');
    assert.equal(revoked.status, 'revoked');
    assert.throws(
      () => ex.review({ exemptionId: rec.exemptionId, reviewer: 'dave', approved: true, comment: '' }),
      ConflictError,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('approved decision freezes applied exemptions into snapshot; revocation after decision does not mutate it', () => {
  const { repo, ex, clock, db, dir } = setup();
  try {
    const { proposal } = repo.create(sampleProposal());
    repo.ingestEvidence(pass(proposal.proposalId, proposal.candidateDigest, 'billing', 'k1', clock));
    const rec = ex.request({
      proposalId: proposal.proposalId,
      consumerId: 'payments',
      environment: 'prod',
      direction: 'backward',
      reason: 'offline',
      requestedBy: 'alice',
      ttlMs: 60000,
    });
    ex.review({ exemptionId: rec.exemptionId, reviewer: 'bob', approved: true, comment: '' });
    ex.review({ exemptionId: rec.exemptionId, reviewer: 'carol', approved: true, comment: '' });
    repo.refreshGateStatus(proposal.proposalId);

    const decided = repo.decide({
      proposalId: proposal.proposalId,
      kind: 'approve',
      decider: 'mgr',
      rationale: 'payments offline but exempted',
    });
    const snapshot = decided.proposal.decision!;
    assert.equal(snapshot.appliedExemptions.length, 1);
    assert.equal(snapshot.appliedExemptions[0]!.exemptionId, rec.exemptionId);
    assert.match(snapshot.exemptionsDigest, /^[0-9a-f]{64}$/);
    const frozenDigest = snapshot.exemptionsDigest;

    assert.throws(
      () => ex.revoke(rec.exemptionId, 'bob'),
      ConflictError,
    );
    const after = repo.requireById(proposal.proposalId);
    assert.equal(after.decision!.exemptionsDigest, frozenDigest);
    assert.equal(after.decision!.appliedExemptions.length, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exemption does not dilute candidate digest', () => {
  const { repo, ex, db, dir } = setup();
  try {
    const { proposal } = repo.create(sampleProposal());
    const before = proposal.candidateDigest;
    ex.request({
      proposalId: proposal.proposalId,
      consumerId: 'payments',
      environment: 'prod',
      direction: 'backward',
      reason: 'offline',
      requestedBy: 'alice',
      ttlMs: 60000,
    });
    const after = repo.requireById(proposal.proposalId);
    assert.equal(after.candidateDigest, before);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exemption lifecycle is recorded in the hash-chained audit log', () => {
  const { repo, ex, db, dir } = setup();
  try {
    const { proposal } = repo.create(sampleProposal());
    const rec = ex.request({
      proposalId: proposal.proposalId,
      consumerId: 'payments',
      environment: 'prod',
      direction: 'backward',
      reason: 'offline',
      requestedBy: 'alice',
      ttlMs: 60000,
    });
    ex.review({ exemptionId: rec.exemptionId, reviewer: 'bob', approved: true, comment: '' });
    ex.review({ exemptionId: rec.exemptionId, reviewer: 'carol', approved: true, comment: '' });
    ex.revoke(rec.exemptionId, 'bob');

    const events = repo.events.readForProposal(proposal.proposalId);
    const types = events.map((e) => e.eventType);
    assert.ok(types.includes('exemption-requested'));
    assert.ok(types.includes('exemption-approved'));
    assert.ok(types.includes('exemption-revoked'));
    assert.equal(repo.events.verifyChain(proposal.proposalId), true);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exemption cannot target unknown consumer or invalid direction', () => {
  const { repo, ex, db, dir } = setup();
  try {
    const { proposal } = repo.create(sampleProposal());
    assert.throws(
      () =>
        ex.request({
          proposalId: proposal.proposalId,
          consumerId: 'analytics',
          environment: 'prod',
          direction: 'backward',
          reason: 'x',
          requestedBy: 'alice',
          ttlMs: 60000,
        }),
      ValidationError,
    );
    assert.throws(
      () =>
        ex.request({
          proposalId: proposal.proposalId,
          consumerId: 'billing',
          environment: 'prod',
          direction: 'sideways' as unknown as ExemptionRecord['direction'],
          reason: 'x',
          requestedBy: 'alice',
          ttlMs: 60000,
        }),
      ValidationError,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
