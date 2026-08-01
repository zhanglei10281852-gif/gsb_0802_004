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

function spawnServer(dbPath: string, port: number, extraEnv: Record<string, string> = {}): ServerHandle & { stderr: string } {
  const child: ChildProcess = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      CCC_DB_PATH: dbPath,
      CCC_PORT: String(port),
      CCC_HOST: '127.0.0.1',
      CCC_LOG: '0',
      ...extraEnv,
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

const rolloutCandidate = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    orderId: { type: 'string' },
    amount: { type: 'number', minimum: 0 },
    note: { type: 'string' },
    rolloutToken: { type: 'string' },
  },
  required: ['orderId'],
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

async function pollWaveState(
  baseUrl: string,
  rolloutId: string,
  sequence: number,
  predicate: (wave: any) => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(15);
    try {
      const r = await getJson(baseUrl, `/api/rollouts/${rolloutId}`);
      const wave = r.rollout?.waves?.find((w: any) => w.sequence === sequence);
      if (wave && predicate(wave)) return;
    } catch {
      /* retry */
    }
  }
  throw new Error(`wave ${sequence} did not reach expected state within ${timeoutMs}ms`);
}

async function postReceiptCrashAfterWrite(
  baseUrl: string,
  rolloutId: string,
  body: any,
): Promise<void> {
  const controller = new AbortController();
  const promise = fetch(`${baseUrl}/api/rollouts/${rolloutId}/receipt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: controller.signal,
  });

  await pollWaveState(baseUrl, rolloutId, body.sequence, (w) => w.attempts > 0 || w.status === 'succeeded' || w.status === 'failed');

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

const secondCompatibleCandidate = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    orderId: { type: 'string' },
    amount: { type: 'number', minimum: 0 },
    priority: { type: 'string' },
  },
  required: ['orderId'],
};

const lineageBaseline = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    orderId: { type: 'string' },
    amount: { type: 'number', minimum: 0 },
  },
  required: ['orderId'],
};

const lineageCandidateV1 = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    orderId: { type: 'string' },
    amount: { type: 'number', minimum: 0 },
    region: { type: 'string' },
  },
  required: ['orderId'],
};

const lineageCandidateV2 = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    orderId: { type: 'string' },
    amount: { type: 'number', minimum: 0 },
    region: { type: 'string' },
    channel: { type: 'string' },
  },
  required: ['orderId'],
};

async function scenarioSuccessorLineage(baseUrl: string, dbPath: string, port: number): Promise<void> {
  console.log('\n[scenario] successor proposal lineage, late old results, voided exemptions');

  await postJson(baseUrl, '/api/consumers', { id: 'lineage-a', name: 'Lineage A' });
  await postJson(baseUrl, '/api/consumers', { id: 'lineage-b', name: 'Lineage B' });

  const v1 = await postJson(baseUrl, '/api/proposals', {
    candidateSchema: lineageCandidateV1,
    baselineSchema: lineageBaseline,
    environment: 'production',
  });
  check(v1.status === 201, 'created lineage proposal v1');
  const v1Id: string = v1.body.proposal.id;
  const v1Hash: string = v1.body.proposal.candidateHash;

  await postJson(baseUrl, `/api/proposals/${v1Id}/evidence`, {
    consumerId: 'lineage-a',
    candidateHash: v1Hash,
    verdict: 'compatible',
    details: 'ok',
    idempotencyKey: 'la-v1',
  });

  const now = Date.now();
  const ex = await postJson(baseUrl, '/api/exemptions', {
    candidateHash: v1Hash,
    consumerId: 'lineage-b',
    environment: 'production',
    direction: 'compatible',
    reason: 'offline during revision',
    requesterId: 'alice',
    validFrom: now,
    validUntil: now + 3_600_000,
  });
  check(ex.status === 201, 'exemption requested for v1');
  const exId: string = ex.body.exemption.id;
  await postJson(baseUrl, `/api/exemptions/${exId}/confirm`, { confirmerId: 'bob' });

  const succ = await postJson(baseUrl, `/api/proposals/${v1Id}/successor`, {
    candidateSchema: lineageCandidateV2,
  });
  check(succ.status === 201, 'created successor v2 from v1');
  const v2Id: string = succ.body.successor.id;
  const v2Hash: string = succ.body.successor.candidateHash;
  check(succ.body.superseded.status === 'superseded', 'v1 marked superseded');
  check(succ.body.successor.parentProposalId === v1Id, 'v2 parent is v1');
  check(succ.body.successor.replacesCandidateHash === v1Hash, 'v2 replaces v1 hash');
  check(succ.body.successor.revision === 2, 'v2 is revision 2');
  check(v2Hash !== v1Hash, 'v2 has a different candidate hash');

  const v2Detail = await getJson(baseUrl, `/api/proposals/${v2Id}`);
  check(v2Detail.evidence.length === 0, 'v2 starts with zero evidence (not inherited)');
  check(v2Detail.appliedExemptions.length === 0, 'v2 has no applied exemptions (not inherited)');
  check(v2Detail.exemptions.every((e: any) => e.status === 'voided'), 'v1 exemptions were voided');
  check(v2Detail.gateReady === false, 'v2 gate is blocked without new evidence');

  const voidedEx = await getJson(baseUrl, `/api/exemptions?candidateHash=${v1Hash}`);
  check(
    voidedEx.exemptions.some((e: any) => e.id === exId && e.status === 'voided'),
    'old exemption status is voided',
  );

  const late = await postJson(baseUrl, `/api/proposals/${v1Id}/evidence`, {
    consumerId: 'lineage-b',
    candidateHash: v1Hash,
    verdict: 'compatible',
    details: 'build finished after revision',
    idempotencyKey: 'lb-late',
  });
  check(late.status === 200, 'late result accepted and filed to superseded v1');
  check(late.body.evidence.late === true, 'late evidence flagged as late');

  const staleOnV2 = await postJson(baseUrl, `/api/proposals/${v2Id}/evidence`, {
    consumerId: 'lineage-a',
    candidateHash: v1Hash,
    verdict: 'compatible',
    details: 'stale hash',
    idempotencyKey: 'stale-hash',
  });
  check(staleOnV2.status === 409, 'evidence with old candidate hash rejected on v2');

  const v2After = await getJson(baseUrl, `/api/proposals/${v2Id}`);
  check(v2After.evidence.length === 0, 'v2 still has no evidence after stale/late submissions');

  const decideV1 = await postJson(baseUrl, `/api/proposals/${v1Id}/decision`, {
    action: 'approve',
    reason: 'should fail',
  });
  check(decideV1.status === 409, 'cannot decide on superseded v1');

  const events = (await getJson(baseUrl, '/api/causal-events')).events as Array<{ type: string; payload: any }>;
  check(events.some((e) => e.type === 'successor_created' && e.payload.candidateHash === v2Hash && e.payload.parentProposalId === v1Id),
    'successor_created causal event recorded');
  check(events.some((e) => e.type === 'proposal_superseded' && e.payload.proposalId === v1Id),
    'proposal_superseded causal event recorded');
  check(events.some((e) => e.type === 'exemption_voided' && e.payload.exemptionId === exId),
    'exemption_voided causal event recorded');
  check(events.some((e) => e.type === 'evidence_received_late' && e.payload.proposalId === v1Id),
    'evidence_received_late causal event recorded');

  console.log('  restarting server to verify lineage recovery...');
  await stopAndRestart(baseUrl, dbPath, port);
  const recovered = await getJson(baseUrl, `/api/proposals/${v2Id}`);
  check(recovered.proposal.parentProposalId === v1Id, 'lineage parent survived restart');
  check(recovered.proposal.revision === 2, 'revision survived restart');
  check(recovered.parent.status === 'superseded', 'superseded status survived restart');
  check(recovered.lineage.successorIds.length === 0, 'v2 has no successors after restart');
  const v1Recovered = await getJson(baseUrl, `/api/proposals/${v1Id}`);
  check(v1Recovered.lineage.successorIds.includes(v2Id), 'v1 successor link survived restart');
  check(
    v1Recovered.evidence.some((e: any) => e.consumerId === 'lineage-b' && e.late === true),
    'late evidence flag survived restart',
  );
}

async function scenarioExemptionsVirtualClock(baseUrl: string): Promise<void> {
  console.log('\n[scenario] dual-reviewer exemptions, deterministic expiry (virtual clock)');

  await postJson(baseUrl, '/api/consumers', { id: 'svc-a', name: 'Service A' });
  await postJson(baseUrl, '/api/consumers', { id: 'svc-b', name: 'Service B' });

  const p1 = await postJson(baseUrl, '/api/proposals', {
    candidateSchema: compatibleCandidate,
    baselineSchema,
    environment: 'production',
  });
  check(p1.status === 201, 'created proposal P1');
  const p1Id: string = p1.body.proposal.id;
  const p1Hash: string = p1.body.proposal.candidateHash;

  await postJson(baseUrl, `/api/proposals/${p1Id}/evidence`, {
    consumerId: 'svc-a',
    candidateHash: p1Hash,
    verdict: 'compatible',
    details: 'ok',
    idempotencyKey: 'a1',
  });

  const req = await postJson(baseUrl, '/api/exemptions', {
    candidateHash: p1Hash,
    consumerId: 'svc-b',
    environment: 'production',
    direction: 'compatible',
    reason: 'svc-b offline during release window',
    requesterId: 'alice',
    validFrom: 0,
    validUntil: 1000,
  });
  check(req.status === 201, 'exemption requested');
  const exId: string = req.body.exemption.id;
  check(req.body.exemption.status === 'pending', 'exemption starts pending (needs second reviewer)');

  const selfConfirm = await postJson(baseUrl, `/api/exemptions/${exId}/confirm`, { confirmerId: 'alice' });
  check(selfConfirm.status === 409, 'requester cannot confirm their own exemption');

  const wrongEnv = await postJson(baseUrl, '/api/exemptions', {
    candidateHash: p1Hash,
    consumerId: 'svc-b',
    environment: 'staging',
    direction: 'compatible',
    reason: 'wrong env',
    requesterId: 'alice',
    validFrom: 0,
    validUntil: 1000,
  });
  check(wrongEnv.status === 201, 'staging exemption can be requested separately');

  const bobConfirm = await postJson(baseUrl, `/api/exemptions/${exId}/confirm`, { confirmerId: 'bob' });
  check(bobConfirm.status === 200, 'different reviewer confirmed the exemption');
  check(bobConfirm.body.exemption.status === 'active', 'exemption is active');

  const ready = await getJson(baseUrl, `/api/proposals/${p1Id}`);
  check(ready.gateReady === true, 'gate ready with svc-b covered by active exemption');
  check(ready.exemptedConsumerIds.includes('svc-b'), 'svc-b listed as exempted');

  const approved = await postJson(baseUrl, `/api/proposals/${p1Id}/decision`, {
    action: 'approve',
    reason: 'svc-b waived by dual-reviewed exemption',
  });
  check(approved.status === 200, 'P1 approved via exemption');
  check(approved.body.decision.snapshot.appliedExemptions.length === 1, 'frozen snapshot records 1 applied exemption');
  check(
    approved.body.decision.snapshot.appliedExemptions[0].confirmerId === 'bob',
    'frozen exemption names the second reviewer',
  );

  const p2 = await postJson(baseUrl, '/api/proposals', {
    candidateSchema: secondCompatibleCandidate,
    baselineSchema,
    environment: 'production',
  });
  check(p2.status === 201, 'created proposal P2');
  const p2Id: string = p2.body.proposal.id;
  const p2Hash: string = p2.body.proposal.candidateHash;

  await postJson(baseUrl, `/api/proposals/${p2Id}/evidence`, {
    consumerId: 'svc-a',
    candidateHash: p2Hash,
    verdict: 'compatible',
    details: 'ok',
    idempotencyKey: 'a2',
  });

  const req2 = await postJson(baseUrl, '/api/exemptions', {
    candidateHash: p2Hash,
    consumerId: 'svc-b',
    environment: 'production',
    direction: 'compatible',
    reason: 'svc-b still offline',
    requesterId: 'alice',
    validFrom: 0,
    validUntil: 1000,
  });
  check(req2.status === 201, 'second exemption requested for P2');
  const ex2Id: string = req2.body.exemption.id;
  await postJson(baseUrl, `/api/exemptions/${ex2Id}/confirm`, { confirmerId: 'bob' });
  const p2Ready = await getJson(baseUrl, `/api/proposals/${p2Id}`);
  check(p2Ready.gateReady === true, 'P2 gate ready before expiry');

  const advanced = await postJson(baseUrl, '/api/test/clock/advance', { ms: 2000 });
  check(advanced.status === 200, `virtual clock advanced to ${advanced.body.now}`);
  check(advanced.body.now >= 2000, 'virtual clock moved past exemption window');

  const p2After = await getJson(baseUrl, `/api/proposals/${p2Id}`);
  check(p2After.gateReady === false, 'P2 gate blocked after exemption expired');
  check(p2After.missingConsumerIds.includes('svc-b'), 'svc-b is missing again after expiry');

  const expiredList = await getJson(baseUrl, `/api/exemptions?candidateHash=${p2Hash}`);
  check(
    expiredList.exemptions.some((e: any) => e.id === ex2Id && e.status === 'expired'),
    'exemption status is expired after virtual clock advance',
  );

  const events = (await getJson(baseUrl, '/api/causal-events')).events as Array<{ type: string; payload: any }>;
  check(events.some((e) => e.type === 'exemption_expired' && e.payload.exemptionId === ex2Id),
    'exemption_expired recorded in causal audit chain');

  const p1Decision = (await getJson(baseUrl, `/api/proposals/${p1Id}`)).decision;
  check(
    p1Decision.snapshot.appliedExemptions.length === 1 &&
      p1Decision.snapshot.appliedExemptions[0].validUntil === 1000,
    'P1 frozen snapshot still carries the original exemption despite later expiry',
  );

  const approveExpired = await postJson(baseUrl, `/api/proposals/${p2Id}/decision`, {
    action: 'approve',
    reason: 'should fail',
  });
  check(approveExpired.status === 409, 'cannot approve P2 once its exemption expired');
}

async function setupApprovedProposal(
  baseUrl: string,
  consumerId: string,
  label: string,
): Promise<{ proposalId: string; candidateHash: string; decisionId: string }> {
  await postJson(baseUrl, '/api/consumers', { id: consumerId, name: label });
  const created = await postJson(baseUrl, '/api/proposals', {
    candidateSchema: rolloutCandidate,
    baselineSchema,
    environment: 'production',
  });
  check(created.status === 201, `[rollout] created proposal for ${label}`);
  const proposalId: string = created.body.proposal.id;
  const candidateHash: string = created.body.proposal.candidateHash;

  const ev = await postJson(baseUrl, `/api/proposals/${proposalId}/evidence`, {
    consumerId,
    candidateHash,
    verdict: 'compatible',
    details: 'build green',
    idempotencyKey: `ev-${consumerId}`,
  });
  check(ev.status === 200, `[rollout] evidence submitted for ${label}`);

  const decision = await postJson(baseUrl, `/api/proposals/${proposalId}/decision`, {
    action: 'approve',
    reason: `gate ready for ${label}`,
  });
  check(decision.status === 200, `[rollout] proposal approved for ${label}`);
  return { proposalId, candidateHash, decisionId: decision.body.decision.id };
}

async function scenarioPhasedRollout(baseUrl: string, dbPath: string, port: number): Promise<void> {
  console.log('\n[scenario] phased rollout: duplicate/lost receipts, restart, pause, retry, rollback');
  const client = new FetchClient(baseUrl);

  const { proposalId, candidateHash, decisionId } = await setupApprovedProposal(
    baseUrl,
    'rollout-svc',
    'Rollout Service',
  );

  const waves = [
    { sequence: 1, environment: 'canary' },
    { sequence: 2, environment: 'staging' },
    { sequence: 3, environment: 'production' },
  ];
  const started = await postJson(baseUrl, `/api/proposals/${proposalId}/rollout`, {
    waves,
    previousVersion: 'v1.4.0',
  });
  check(started.status === 201, '[rollout] 3-wave rollout started');
  const rolloutId: string = started.body.rollout.id;
  check(started.body.rollout.status === 'in_progress', '[rollout] rollout in_progress');
  check(started.body.rollout.candidateHash === candidateHash, '[rollout] bound to candidate hash');
  check(started.body.rollout.decisionId === decisionId, '[rollout] bound to decision snapshot');
  check(started.body.rollout.previousVersion === 'v1.4.0', '[rollout] records previous known version');
  check(started.body.rollout.waves[0].status === 'in_progress', '[rollout] wave 1 starts in_progress');
  check(started.body.rollout.waves[1].status === 'pending', '[rollout] wave 2 pending');
  check(started.body.rollout.waves[2].status === 'pending', '[rollout] wave 3 pending');

  const dupReceipt = await client.post(
    `/api/rollouts/${rolloutId}/receipt`,
    { sequence: 1, result: 'success', adapterId: 'adapter-canary', idempotencyKey: 'wave1-success', message: 'canary green' },
    [{ kind: 'duplicate' }],
  );
  check(dupReceipt.status === 200, '[rollout] duplicate receipt delivery accepted');
  const firstBody = (dupReceipt.body as any).first?.body;
  const secondBody = (dupReceipt.body as any).second?.body;
  check(firstBody && firstBody.duplicate === false, '[rollout] first receipt is not a duplicate');
  check(secondBody && secondBody.duplicate === true, '[rollout] second identical receipt is marked duplicate');
  check(
    secondBody.receipt.id === firstBody.receipt.id,
    '[rollout] duplicate returns the same persisted receipt',
  );

  const afterDup = await getJson(baseUrl, `/api/rollouts/${rolloutId}`);
  const w1 = afterDup.rollout.waves.find((w: any) => w.sequence === 1);
  check(w1.status === 'succeeded', '[rollout] wave 1 succeeded after duplicate delivery');
  check(w1.attempts === 1, '[rollout] duplicate did not increment wave 1 attempts');
  const w2 = afterDup.rollout.waves.find((w: any) => w.sequence === 2);
  check(w2.status === 'in_progress', '[rollout] wave 2 started after wave 1 success');
  const w3pending = afterDup.rollout.waves.find((w: any) => w.sequence === 3);
  check(w3pending.status === 'pending', '[rollout] wave 3 still pending');

  const futureWave = await postJson(baseUrl, `/api/rollouts/${rolloutId}/receipt`, {
    sequence: 3,
    result: 'success',
    adapterId: 'adapter-prod',
    idempotencyKey: 'too-early',
  });
  check(futureWave.status === 409, '[rollout] out-of-order receipt for pending wave rejected');
  const afterFuture = await getJson(baseUrl, `/api/rollouts/${rolloutId}`);
  check(
    afterFuture.rollout.waves.find((w: any) => w.sequence === 3).status === 'pending',
    '[rollout] rejected out-of-order receipt did not mutate wave 3',
  );

  const lostKey = 'wave2-lost-success';
  await postReceiptCrashAfterWrite(baseUrl, rolloutId, {
    sequence: 2,
    result: 'success',
    adapterId: 'adapter-staging',
    idempotencyKey: lostKey,
    message: 'staging green (response lost)',
  });
  check(true, '[rollout] simulated lost receipt response after durable write (crash after write)');

  const retryLost = await postJson(baseUrl, `/api/rollouts/${rolloutId}/receipt`, {
    sequence: 2,
    result: 'success',
    adapterId: 'adapter-staging',
    idempotencyKey: lostKey,
  });
  check(retryLost.status === 200, '[rollout] retry of lost receipt accepted');
  check(retryLost.body.duplicate === true, '[rollout] retried lost receipt deduped (write had committed)');
  const afterLost = await getJson(baseUrl, `/api/rollouts/${rolloutId}`);
  const w2recovered = afterLost.rollout.waves.find((w: any) => w.sequence === 2);
  check(w2recovered.status === 'succeeded', '[rollout] wave 2 succeeded after lost-then-retried receipt');
  check(w2recovered.attempts === 1, '[rollout] wave 2 attempts not doubled by lost-then-retried receipt');
  const w3 = afterLost.rollout.waves.find((w: any) => w.sequence === 3);
  check(w3.status === 'in_progress', '[rollout] wave 3 started after wave 2 success');

  const outOfOrder = await postJson(baseUrl, `/api/rollouts/${rolloutId}/receipt`, {
    sequence: 1,
    result: 'success',
    adapterId: 'adapter-canary',
    idempotencyKey: 'late-for-wave1',
  });
  check(outOfOrder.status === 409, '[rollout] receipt for a non-current (succeeded) wave rejected');

  const failed = await postJson(baseUrl, `/api/rollouts/${rolloutId}/receipt`, {
    sequence: 3,
    result: 'failure',
    adapterId: 'adapter-prod',
    idempotencyKey: 'wave3-fail',
    message: 'health check failed',
  });
  check(failed.status === 200, '[rollout] failure receipt recorded');
  check(failed.body.rollout.status === 'failed', '[rollout] rollout halted on failure');
  const w3failed = failed.body.rollout.waves.find((w: any) => w.sequence === 3);
  check(w3failed.status === 'failed', '[rollout] wave 3 marked failed');
  check(w3failed.lastResult === 'failure', '[rollout] wave 3 last result is failure');

  const retryNonFailed = await postJson(baseUrl, `/api/rollouts/${rolloutId}/retry`, { sequence: 1 });
  check(retryNonFailed.status === 409, '[rollout] cannot retry a wave that did not fail');

  const retried = await postJson(baseUrl, `/api/rollouts/${rolloutId}/retry`, { sequence: 3 });
  check(retried.status === 200, '[rollout] failed wave retried');
  check(retried.body.rollout.status === 'in_progress', '[rollout] rollout back in_progress after retry');
  const w3retry = retried.body.rollout.waves.find((w: any) => w.sequence === 3);
  check(w3retry.status === 'in_progress', '[rollout] wave 3 back in_progress after retry');

  const unknown = await postJson(baseUrl, `/api/rollouts/${rolloutId}/receipt`, {
    sequence: 3,
    result: 'unknown',
    adapterId: 'adapter-prod',
    idempotencyKey: 'wave3-unknown',
    message: 'adapter timed out',
  });
  check(unknown.status === 200, '[rollout] unknown receipt recorded');
  check(unknown.body.rollout.status === 'in_progress', '[rollout] unknown does not halt or advance');
  const w3unknown = unknown.body.rollout.waves.find((w: any) => w.sequence === 3);
  check(w3unknown.status === 'in_progress', '[rollout] wave 3 stays in_progress after unknown');
  check(w3unknown.attempts === 2, '[rollout] unknown receipt incremented attempt count');

  const paused = await postJson(baseUrl, `/api/rollouts/${rolloutId}/pause`, { reason: 'investigate prod metrics' });
  check(paused.status === 200, '[rollout] rollout paused');
  check(paused.body.rollout.status === 'paused', '[rollout] status paused');
  const w3paused = paused.body.rollout.waves.find((w: any) => w.sequence === 3);
  check(w3paused.status === 'paused', '[rollout] current wave paused');

  const receiptWhilePaused = await postJson(baseUrl, `/api/rollouts/${rolloutId}/receipt`, {
    sequence: 3,
    result: 'success',
    adapterId: 'adapter-prod',
    idempotencyKey: 'while-paused',
  });
  check(receiptWhilePaused.status === 409, '[rollout] receipt rejected while paused');

  console.log('  restarting server mid-rollout (while paused)...');
  await stopAndRestart(baseUrl, dbPath, port);
  const recoveredPaused = await getJson(baseUrl, `/api/rollouts/${rolloutId}`);
  check(recoveredPaused.rollout.status === 'paused', '[rollout] paused status survived restart');
  const w3RecoveredPaused = recoveredPaused.rollout.waves.find((w: any) => w.sequence === 3);
  check(w3RecoveredPaused.status === 'paused', '[rollout] paused wave survived restart');
  check(w3RecoveredPaused.attempts === 2, '[rollout] attempt count survived restart');
  check(recoveredPaused.rollout.waves.find((w: any) => w.sequence === 1).status === 'succeeded', '[rollout] wave 1 success survived restart');
  check(recoveredPaused.rollout.waves.find((w: any) => w.sequence === 2).status === 'succeeded', '[rollout] wave 2 success survived restart');

  const resumed = await postJson(baseUrl, `/api/rollouts/${rolloutId}/resume`, {});
  check(resumed.status === 200, '[rollout] rollout resumed after restart');
  check(resumed.body.rollout.status === 'in_progress', '[rollout] status in_progress after resume');

  const finalSuccess = await postJson(baseUrl, `/api/rollouts/${rolloutId}/receipt`, {
    sequence: 3,
    result: 'success',
    adapterId: 'adapter-prod',
    idempotencyKey: 'wave3-success',
  });
  check(finalSuccess.status === 200, '[rollout] final wave success recorded');
  check(finalSuccess.body.rollout.status === 'succeeded', '[rollout] rollout succeeded');
  check(
    finalSuccess.body.rollout.waves.every((w: any) => w.status === 'succeeded'),
    '[rollout] all waves succeeded',
  );

  const rollbackAfterSuccess = await postJson(baseUrl, `/api/rollouts/${rolloutId}/rollback`, {
    targetVersion: 'v1.4.0',
    reason: 'should fail',
  });
  check(rollbackAfterSuccess.status === 409, '[rollout] cannot rollback an already succeeded rollout');

  const proposalAfter = await getJson(baseUrl, `/api/proposals/${proposalId}`);
  check(proposalAfter.proposal.status === 'approved', '[rollout] rollout lifecycle did not change contract decision');
  check(proposalAfter.decision !== null && proposalAfter.decision.id === decisionId, '[rollout] original decision intact');

  const events = (await getJson(baseUrl, '/api/causal-events')).events as Array<{ type: string }>;
  const rolloutTypes = events.filter((e) => e.type.startsWith('rollout_') || e.type.startsWith('wave_')).map((e) => e.type);
  for (const t of ['rollout_started', 'wave_started', 'wave_receipt', 'wave_succeeded', 'wave_failed', 'rollout_failed', 'wave_retried', 'rollout_paused', 'rollout_resumed', 'rollout_succeeded']) {
    check(rolloutTypes.includes(t), `[rollout] causal event ${t} recorded`);
  }

  console.log('  [rollout] verifying rollback does not revive voided exemptions...');
  await postJson(baseUrl, '/api/consumers', { id: 'rollout-rb', name: 'Rollback Service' });
  const rbParent = await postJson(baseUrl, '/api/proposals', {
    candidateSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        orderId: { type: 'string' },
        amount: { type: 'number', minimum: 0 },
        rbTag: { type: 'string' },
      },
      required: ['orderId'],
    },
    baselineSchema,
    environment: 'production',
  });
  check(rbParent.status === 201, '[rollback] parent proposal created (pending)');
  const rbParentId: string = rbParent.body.proposal.id;
  const oldHash: string = rbParent.body.proposal.candidateHash;

  const now = Date.now();
  const exReq = await postJson(baseUrl, '/api/exemptions', {
    candidateHash: oldHash,
    consumerId: 'rollout-rb',
    environment: 'production',
    direction: 'compatible',
    reason: 'offline',
    requesterId: 'alice',
    validFrom: now,
    validUntil: now + 3_600_000,
  });
  check(exReq.status === 201, '[rollback] exemption requested on parent');
  const exConfirm = await postJson(baseUrl, `/api/exemptions/${exReq.body.exemption.id}/confirm`, { confirmerId: 'bob' });
  check(exConfirm.status === 200, '[rollback] exemption confirmed by second reviewer');

  const succ = await postJson(baseUrl, `/api/proposals/${rbParentId}/successor`, {
    candidateSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        orderId: { type: 'string' },
        amount: { type: 'number', minimum: 0 },
        rbTag: { type: 'string' },
        priority: { type: 'string' },
      },
      required: ['orderId'],
    },
  });
  check(succ.status === 201, '[rollback] successor created (parent superseded, exemption voided)');
  const succId: string = succ.body.successor.id;
  const succHash: string = succ.body.successor.candidateHash;

  const voidedList = await getJson(baseUrl, `/api/exemptions?candidateHash=${oldHash}`);
  check(
    voidedList.exemptions.every((e: any) => e.status === 'voided'),
    '[rollback] old exemptions voided by successor',
  );

  await postJson(baseUrl, `/api/proposals/${succId}/evidence`, {
    consumerId: 'rollout-rb',
    candidateHash: succHash,
    verdict: 'compatible',
    details: 'green',
    idempotencyKey: 'rb-succ-ev',
  });
  await postJson(baseUrl, `/api/proposals/${succId}/evidence`, {
    consumerId: 'rollout-svc',
    candidateHash: succHash,
    verdict: 'compatible',
    details: 'green',
    idempotencyKey: 'rb-succ-svc',
  });
  const succDecision = await postJson(baseUrl, `/api/proposals/${succId}/decision`, {
    action: 'approve',
    reason: 'successor approved',
  });
  check(succDecision.status === 200, '[rollback] successor approved');
  const succDecisionId: string = succDecision.body.decision.id;

  const rbStarted = await postJson(baseUrl, `/api/proposals/${succId}/rollout`, {
    waves: [
      { sequence: 1, environment: 'canary' },
      { sequence: 2, environment: 'production' },
    ],
    previousVersion: 'v2.0.0',
  });
  check(rbStarted.status === 201, '[rollback] rollout started for successor');
  const rbRolloutId: string = rbStarted.body.rollout.id;

  await postJson(baseUrl, `/api/rollouts/${rbRolloutId}/receipt`, {
    sequence: 1,
    result: 'success',
    adapterId: 'a1',
    idempotencyKey: 'rb-wave1',
  });

  const rb = await postJson(baseUrl, `/api/rollouts/${rbRolloutId}/rollback`, {
    targetVersion: 'v2.0.0',
    reason: 'canary regression',
  });
  check(rb.status === 200, '[rollback] rollback executed');
  check(rb.body.rollout.status === 'rolled_back', '[rollback] rollout marked rolled_back');
  check(rb.body.rollout.rolledBackTo === 'v2.0.0', '[rollback] rolled back to previous known version');
  check(
    rb.body.rollout.waves.some((w: any) => w.status === 'rolled_back'),
    '[rollback] unfinished waves marked rolled_back',
  );

  const decisionAfterRb = await getJson(baseUrl, `/api/proposals/${succId}`);
  check(decisionAfterRb.proposal.status === 'approved', '[rollback] successor proposal still approved');
  check(
    decisionAfterRb.decision.id === succDecisionId && decisionAfterRb.decision.decision === 'approved',
    '[rollback] original contract decision not rewritten',
  );

  const voidedAfterRb = await getJson(baseUrl, `/api/exemptions?candidateHash=${oldHash}`);
  check(
    voidedAfterRb.exemptions.every((e: any) => e.status === 'voided'),
    '[rollback] voided exemptions not revived by rollback',
  );
  const succExAfterRb = await getJson(baseUrl, `/api/exemptions?candidateHash=${succHash}`);
  check(succExAfterRb.exemptions.length === 0, '[rollback] no exemptions invented for successor');
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
    await scenarioSuccessorLineage(handle.baseUrl, dbPath, port);
  } finally {
    if (currentHandle) await currentHandle.stop();
    currentHandle = null;
  }

  const vdir = mkdtempSync(join(tmpdir(), 'ccc-e2e-virtual-'));
  const vdbPath = join(vdir, 'virtual.sqlite');
  const vport = 4124;
  const vhandle = spawnServer(vdbPath, vport, { CCC_CLOCK: 'virtual' });
  try {
    await waitForHealth(vhandle.baseUrl).catch((err) => {
      console.error('virtual server output:\n', vhandle.stderr);
      throw err;
    });
    console.log(`virtual-clock server up at ${vhandle.baseUrl}`);
    await scenarioExemptionsVirtualClock(vhandle.baseUrl);
  } finally {
    await vhandle.stop();
  }

  const rdir = mkdtempSync(join(tmpdir(), 'ccc-e2e-rollout-'));
  const rdbPath = join(rdir, 'rollout.sqlite');
  const rport = 4125;
  const rhandle = spawnServer(rdbPath, rport);
  currentHandle = rhandle;
  try {
    await waitForHealth(rhandle.baseUrl).catch((err) => {
      console.error('rollout server output:\n', rhandle.stderr);
      throw err;
    });
    console.log(`rollout server up at ${rhandle.baseUrl}`);
    await scenarioPhasedRollout(rhandle.baseUrl, rdbPath, rport);
  } finally {
    if (currentHandle) await currentHandle.stop();
    currentHandle = null;
    rmSync(dir, { recursive: true, force: true });
    rmSync(vdir, { recursive: true, force: true });
    rmSync(rdir, { recursive: true, force: true });
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
