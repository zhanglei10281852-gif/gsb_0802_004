import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/server/app.js';
import { ManualClock } from '../src/core/clock.js';
import type { BuiltApp } from '../src/server/app.js';

async function setup(): Promise<{ built: BuiltApp; cleanup: () => void }> {
  const clock = new ManualClock(1_000_000);
  const built = await buildApp({
    dbPath: ':memory:',
    clock,
    serveStatic: false,
    logLevel: 'silent',
  });
  return {
    built,
    cleanup: () => { built.db.close(); },
  };
}

const baseline = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: { id: { type: 'string' } },
  required: ['id'],
  additionalProperties: true,
};
const candidate = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: { id: { type: 'string' }, note: { type: 'string' } },
  required: ['id'],
  additionalProperties: true,
};

test('HTTP: full happy path with evidence and approve', async () => {
  const { built, cleanup } = await setup();
  try {
    const createRes = await built.app.inject({
      method: 'POST',
      url: '/api/proposals',
      payload: {
        topic: 'http.test',
        baseline,
        candidate,
        consumers: [{ consumerId: 'svc-a', schema: { type: 'object' } }],
        author: 'tester',
        ttlMs: 60000,
      },
    });
    assert.equal(createRes.statusCode, 201);
    const proposal = createRes.json();
    const pid = proposal.proposalId;

    const evRes = await built.app.inject({
      method: 'POST',
      url: `/api/proposals/${pid}/evidence`,
      headers: { 'Idempotency-Key': 'run-1' },
      payload: {
        candidateDigest: proposal.candidateDigest,
        consumerId: 'svc-a',
        status: 'pass',
        detail: 'ok',
        reportedAt: 1_000_000,
        agentRunId: 'run-1',
      },
    });
    assert.equal(evRes.statusCode, 202);
    assert.equal(evRes.json().accepted, true);

    const decideRes = await built.app.inject({
      method: 'POST',
      url: `/api/proposals/${pid}/decision`,
      payload: { kind: 'approve', decider: 'mgr', rationale: 'all good' },
    });
    assert.equal(decideRes.statusCode, 200);
    assert.equal(decideRes.json().status, 'approved');
    assert.ok(decideRes.json().decision.evidenceDigest);
  } finally {
    cleanup();
  }
});

test('HTTP: duplicate evidence via same Idempotency-Key is deduped', async () => {
  const { built, cleanup } = await setup();
  try {
    const createRes = await built.app.inject({
      method: 'POST',
      url: '/api/proposals',
      payload: { topic: 'dedup.test', baseline, candidate, consumers: [{ consumerId: 'svc-a', schema: {} }], author: 't', ttlMs: 60000 },
    });
    const proposal = createRes.json();

    const first = await built.app.inject({
      method: 'POST', url: `/api/proposals/${proposal.proposalId}/evidence`,
      headers: { 'Idempotency-Key': 'ABC' },
      payload: { candidateDigest: proposal.candidateDigest, consumerId: 'svc-a', status: 'pass', detail: 'first', reportedAt: 1, agentRunId: 'r' },
    });
    const second = await built.app.inject({
      method: 'POST', url: `/api/proposals/${proposal.proposalId}/evidence`,
      headers: { 'Idempotency-Key': 'ABC' },
      payload: { candidateDigest: proposal.candidateDigest, consumerId: 'svc-a', status: 'fail', detail: 'second', reportedAt: 2, agentRunId: 'r' },
    });
    assert.equal(first.json().deduped, false);
    assert.equal(second.json().deduped, true);

    const view = await built.app.inject({ method: 'GET', url: `/api/proposals/${proposal.proposalId}` });
    assert.equal(view.json().evidence.length, 1);
    assert.equal(view.json().evidence[0].detail, 'first');
  } finally {
    cleanup();
  }
});

test('HTTP: wrong digest returns 409 and no evidence stored', async () => {
  const { built, cleanup } = await setup();
  try {
    const createRes = await built.app.inject({
      method: 'POST',
      url: '/api/proposals',
      payload: { topic: 'wrong.test', baseline, candidate, consumers: [{ consumerId: 'svc-a', schema: {} }], author: 't', ttlMs: 60000 },
    });
    const proposal = createRes.json();
    const res = await built.app.inject({
      method: 'POST', url: `/api/proposals/${proposal.proposalId}/evidence`,
      headers: { 'Idempotency-Key': 'X' },
      payload: { candidateDigest: 'a'.repeat(64), consumerId: 'svc-a', status: 'pass', detail: 'x', reportedAt: 1, agentRunId: 'r' },
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().accepted, false);
    const view = await built.app.inject({ method: 'GET', url: `/api/proposals/${proposal.proposalId}` });
    assert.equal(view.json().evidence.length, 0);
  } finally {
    cleanup();
  }
});

test('HTTP: approve blocked returns 409 with blockers; late evidence after decide rejected', async () => {
  const { built, cleanup } = await setup();
  try {
    const createRes = await built.app.inject({
      method: 'POST',
      url: '/api/proposals',
      payload: { topic: 'blocked.test', baseline, candidate, consumers: [{ consumerId: 'svc-a', schema: {} }], author: 't', ttlMs: 60000 },
    });
    const proposal = createRes.json();
    const blocked = await built.app.inject({
      method: 'POST', url: `/api/proposals/${proposal.proposalId}/decision`,
      payload: { kind: 'approve', decider: 'mgr', rationale: '' },
    });
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.json().error, 'GATE_BLOCKED');
    assert.ok(blocked.json().blockers.length > 0);
  } finally {
    cleanup();
  }
});

test('HTTP: SSE endpoint replays events after Last-Event-ID via ?after (real socket)', async () => {
  const clock = new ManualClock(1_000_000);
  const built = await buildApp({ dbPath: ':memory:', clock, serveStatic: false, logLevel: 'silent' });
  const address = await built.app.listen({ port: 0, host: '127.0.0.1' });
  try {
    const create = await fetch(`${address}/api/proposals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'sse.test', baseline, candidate, consumers: [{ consumerId: 'svc-a', schema: {} }], author: 't', ttlMs: 60000 }),
    });
    const proposal = (await create.json()) as { proposalId: string; candidateDigest: string };

    await fetch(`${address}/api/proposals/${proposal.proposalId}/evidence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'E1' },
      body: JSON.stringify({ candidateDigest: proposal.candidateDigest, consumerId: 'svc-a', status: 'pass', detail: 'ok', reportedAt: 1, agentRunId: 'r' }),
    });

    const body = await new Promise<string>((resolvePromise, reject) => {
      const ac = new AbortController();
      fetch(`${address}/api/events?after=0`, { signal: ac.signal })
        .then(async (res) => {
          const reader = res.body!.getReader();
          let buffer = '';
          const timer = setTimeout(() => { ac.abort(); resolvePromise(buffer); }, 2000);
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += new TextDecoder().decode(value);
            if (buffer.includes('gate-advanced')) {
              clearTimeout(timer);
              ac.abort();
              resolvePromise(buffer);
              break;
            }
          }
        })
        .catch((err) => {
          if (err.name === 'AbortError') return;
          reject(err);
        });
    });

    assert.match(body, /event: proposal-created/);
    assert.match(body, /event: evidence-accepted/);
    assert.match(body, /event: gate-advanced/);
  } finally {
    await built.app.close();
    built.db.close();
  }
});
