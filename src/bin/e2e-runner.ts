import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FetchClient } from '../agent/simulator.js';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, 'server.js');

interface ServerHandle {
  port: number;
  baseUrl: string;
  dbPath: string;
  stop: () => Promise<void>;
}

let totalChecks = 0;
let failedChecks = 0;
const failures: string[] = [];

function check(condition: unknown, message: string): void {
  totalChecks++;
  if (condition) {
    console.log(`  ✓ ${message}`);
  } else {
    failedChecks++;
    failures.push(message);
    console.error(`  ✗ ${message}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(baseUrl: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await sleep(150);
  }
  throw new Error(`server at ${baseUrl} did not become healthy`);
}

function spawnServer(dbPath: string, port: number): ServerHandle & { stderr: string } {
  const child: ChildProcess = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      CCC_DB_PATH: dbPath,
      CCC_PORT: String(port),
      CCC_HOST: '127.0.0.1',
      CCC_LOG: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  let stdout = '';
  child.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString();
  });
  child.stdout?.on('data', (d: Buffer) => {
    stdout += d.toString();
  });

  const baseUrl = `http://127.0.0.1:${port}`;

  const stop = (): Promise<void> =>
    new Promise((resolve) => {
      const t = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      child.kill('SIGTERM');
    });

  return { port, baseUrl, dbPath, stop, get stderr() { return stderr + stdout; } };
}

async function postJson(baseUrl: string, path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let parsed: any = null;
  try {
    parsed = await res.json();
  } catch {
    /* ignore */
  }
  return { status: res.status, body: parsed };
}

async function getJson(baseUrl: string, path: string): Promise<any> {
  const res = await fetch(`${baseUrl}${path}`);
  return res.json();
}

const baselineSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    orderId: { type: 'string' },
    amount: { type: 'number', minimum: 0 },
  },
  required: ['orderId'],
};

const compatibleCandidate = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    orderId: { type: 'string' },
    amount: { type: 'number', minimum: 0 },
    note: { type: 'string' },
  },
  required: ['orderId'],
};

const breakingCandidate = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    orderId: { type: 'string' },
    amount: { type: 'number', minimum: 0 },
  },
  required: ['orderId', 'amount'],
};

async function postEvidenceCrashAfterWrite(
  baseUrl: string,
  proposalId: string,
  body: unknown,
  idempotencyKey: string,
): Promise<void> {
  const controller = new AbortController();
  const promise = fetch(`${baseUrl}/api/proposals/${proposalId}/evidence`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: controller.signal,
  });

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await sleep(15);
    const detail = await getJson(baseUrl, `/api/proposals/${proposalId}`);
    if (detail.evidence.some((e: any) => e.idempotencyKey === idempotencyKey)) {
      break;
    }
  }
  controller.abort();
  try {
    await promise;
  } catch {
    /* expected: connection reset before response */
  }
}

async function readSseSnapshot(baseUrl: string): Promise<any> {
  const res = await fetch(`${baseUrl}/api/stream`, { headers: { accept: 'text/event-stream' } });
  if (!res.ok || !res.body) throw new Error('SSE connection failed');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const msg = JSON.parse(line.slice(6));
        try {
          await reader.cancel();
        } catch {
          /* stream already closed */
        }
        if (msg.type === 'snapshot') return msg.data;
      }
    }
  }
  throw new Error('did not receive SSE snapshot');
}

async function scenarioAnomaliesAndRestart(baseUrl: string, dbPath: string, port: number): Promise<void> {
  const client = new FetchClient(baseUrl);
  console.log('\n[scenario] duplicates, dropped responses, late results, restart recovery');

  const consumers = [
    { id: 'billing', name: 'Billing Service' },
    { id: 'shipping', name: 'Shipping Service' },
    { id: 'notifications', name: 'Notifications Service' },
  ];
  for (const c of consumers) {
    const r = await postJson(baseUrl, '/api/consumers', c);
    check(r.status === 201, `registered consumer ${c.id}`);
  }

  let prop = await postJson(baseUrl, '/api/proposals', {
    candidateSchema: compatibleCandidate,
    baselineSchema,
  });
  check(prop.status === 201, 'created compatible proposal');
  const proposalId: string = prop.body.proposal.id;
  const candidateHash: string = prop.body.proposal.candidateHash;

  const idemKey = 'evidence-billing-v1';
  const evidenceBody = {
    consumerId: 'billing',
    candidateHash,
    verdict: 'compatible',
    details: 'validated 1000 events',
    idempotencyKey: idemKey,
  };

  const dup = await client.post(`/api/proposals/${proposalId}/evidence`, evidenceBody, [{ kind: 'duplicate' }]);
  check(dup.status === 200, 'duplicate evidence submission accepted');
  const second = (dup.body as any).second;
  check(second && second.body && second.body.deduped === true, 'second identical delivery was deduped');

  const shipKey = 'ship-crash-1';
  const shipBody = {
    consumerId: 'shipping',
    candidateHash,
    verdict: 'compatible',
    details: 'validated in build 42',
    idempotencyKey: shipKey,
  };
  await postEvidenceCrashAfterWrite(baseUrl, proposalId, shipBody, shipKey);
  check(true, 'simulated crash after write (committed before reply, connection reset)');
  const shipRetry = await postJson(baseUrl, `/api/proposals/${proposalId}/evidence`, shipBody);
  check(shipRetry.status === 200, 'retry after crash succeeded');
  check(shipRetry.body.deduped === true, 'retry after crash was deduped (write had committed)');

  const afterDrop = await getJson(baseUrl, `/api/proposals/${proposalId}`);
  check(afterDrop.evidence.length === 2, 'billing + shipping evidence after duplicate+crash+retry');

  const unknown = await postJson(baseUrl, `/api/proposals/${proposalId}/evidence`, {
    consumerId: 'ghost-service',
    candidateHash,
    verdict: 'compatible',
    details: 'late',
    idempotencyKey: 'ghost-1',
  });
  check(unknown.status === 409, 'evidence from unknown consumer rejected');
  check(unknown.body.reason.includes('unknown consumer'), 'rejection reason mentions unknown consumer');

  const stale = await postJson(baseUrl, `/api/proposals/${proposalId}/evidence`, {
    consumerId: 'billing',
    candidateHash: '0000000000000000000000000000000000000000000000000000000000000000',
    verdict: 'incompatible',
    details: 'old candidate late result',
    idempotencyKey: 'stale-1',
  });
  check(stale.status === 409, 'evidence from old candidate (hash mismatch) rejected');

  const afterRejects = await getJson(baseUrl, `/api/proposals/${proposalId}`);
  check(afterRejects.evidence.length === 2, 'rejected late results did not pollute the proposal');

  await postJson(baseUrl, `/api/proposals/${proposalId}/evidence`, {
    consumerId: 'notifications',
    candidateHash,
    verdict: 'compatible',
    details: 'ok',
    idempotencyKey: 'notif-1',
  });

  const ready = await getJson(baseUrl, `/api/proposals/${proposalId}`);
  check(ready.evidence.length === 3, 'all three consumers reported evidence');
  check(ready.gateReady === true, 'gate became ready once all consumers reported compatible');

  const [a, b] = await Promise.all([
    postJson(baseUrl, `/api/proposals/${proposalId}/decision`, { action: 'approve', reason: 'concurrent A' }),
    postJson(baseUrl, `/api/proposals/${proposalId}/decision`, { action: 'approve', reason: 'concurrent B' }),
  ]);
  const okCount = [a, b].filter((r) => r.status === 200).length;
  const conflictCount = [a, b].filter((r) => r.status === 409).length;
  check(okCount === 1 && conflictCount === 1, 'exactly one of two concurrent approvals succeeded');

  const afterDecision = await getJson(baseUrl, `/api/proposals/${proposalId}`);
  check(afterDecision.proposal.status === 'approved', 'proposal is approved');
  check(afterDecision.decision !== null, 'decision was persisted');

  const lateEvidence = await postJson(baseUrl, `/api/proposals/${proposalId}/evidence`, {
    consumerId: 'shipping',
    candidateHash,
    verdict: 'incompatible',
    details: 'changed my mind after decision',
    idempotencyKey: 'ship-late',
  });
  check(lateEvidence.status === 409, 'evidence arriving after decision is rejected');
  const frozen = await getJson(baseUrl, `/api/proposals/${proposalId}`);
  check(
    frozen.decision.snapshot.evidence.length === 3,
    'decision snapshot remains frozen at 3 evidence entries',
  );
  check(
    frozen.decision.snapshot.evidence.every((e: any) => e.verdict === 'compatible'),
    'snapshot evidence verdicts are unchanged by the late report',
  );

  const sseSnapshot = await readSseSnapshot(baseUrl);
  check(
    sseSnapshot.proposals.some((p: any) => p.proposal.id === proposalId),
    'SSE delivers a consistent snapshot on connect',
  );

  console.log('\n[scenario] restart recovery');
  const eventsBefore = (await getJson(baseUrl, '/api/causal-events')).events;
  await stopAndRestart(baseUrl, dbPath, port);

  const recovered = await getJson(baseUrl, `/api/proposals/${proposalId}`);
  check(recovered.proposal.status === 'approved', 'approved status survived restart');
  check(recovered.evidence.length === 3, 'evidence survived restart');
  check(recovered.decision.snapshot.evidence.length === 3, 'frozen decision snapshot survived restart');
  const eventsAfter = (await getJson(baseUrl, '/api/causal-events')).events;
  check(eventsAfter.length === eventsBefore.length, 'causal event log survived restart unchanged');
  check(
    eventsAfter.every((e: any, i: number) => e.id === eventsBefore[i].id && e.clock === eventsBefore[i].clock),
    'causal event ordering and clocks are preserved across restart',
  );

  const sseAfterRestart = await readSseSnapshot(baseUrl);
  check(
    sseAfterRestart.proposals.some((p: any) => p.proposal.id === proposalId && p.proposal.status === 'approved'),
    'SSE snapshot after restart is consistent with SQLite state',
  );
}

let currentHandle: ServerHandle | null = null;

async function stopAndRestart(_baseUrl: string, dbPath: string, port: number): Promise<void> {
  if (currentHandle) {
    await currentHandle.stop();
    currentHandle = null;
  }
  await sleep(500);
  currentHandle = spawnServer(dbPath, port);
  await waitForHealth(currentHandle.baseUrl);
}

async function scenarioBreakingChange(baseUrl: string): Promise<void> {
  console.log('\n[scenario] breaking change cannot be approved');
  const r = await postJson(baseUrl, '/api/proposals', {
    candidateSchema: breakingCandidate,
    baselineSchema,
  });
  check(r.status === 201, 'created breaking proposal');
  check(r.body.proposal.systemCompatibility.compatible === false, 'system detects breaking change');
  const id: string = r.body.proposal.id;

  const existing = (await getJson(baseUrl, '/api/consumers')).consumers as Array<{ id: string }>;
  for (const c of existing) {
    await postJson(baseUrl, `/api/proposals/${id}/evidence`, {
      consumerId: c.id,
      candidateHash: r.body.proposal.candidateHash,
      verdict: 'compatible',
      details: 'consumer says ok',
      idempotencyKey: `break-${c.id}`,
    });
  }
  const decision = await postJson(baseUrl, `/api/proposals/${id}/decision`, {
    action: 'approve',
    reason: 'should fail',
  });
  check(decision.status === 409, 'approval blocked even though all consumers reported compatible');
  const reject = await postJson(baseUrl, `/api/proposals/${id}/decision`, {
    action: 'reject',
    reason: 'breaking',
  });
  check(reject.status === 200, 'rejection of a breaking proposal is allowed');
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ccc-e2e-'));
  const dbPath = join(dir, 'e2e.sqlite');
  const port = 4123;
  const handle = spawnServer(dbPath, port);
  currentHandle = handle;

  try {
    await waitForHealth(handle.baseUrl).catch((err) => {
      console.error('server output:\n', handle.stderr);
      throw err;
    });
    console.log(`server up at ${handle.baseUrl} (db=${dbPath})`);

    await scenarioAnomaliesAndRestart(handle.baseUrl, dbPath, port);
    await scenarioBreakingChange(handle.baseUrl);
  } finally {
    if (currentHandle) await currentHandle.stop();
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${totalChecks - failedChecks}/${totalChecks} checks passed`);
  if (failedChecks > 0) {
    console.error('\nFailures:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('end-to-end scenarios succeeded');
}

main().catch((err) => {
  console.error('e2e run failed:', err);
  process.exit(1);
});
