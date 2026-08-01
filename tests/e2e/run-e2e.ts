import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ControlCenterClient } from '../../src/adapters/agent/client.js';
import { AgentSimulator } from '../../src/adapters/agent/simulator.js';
import { buildScenarios } from '../../src/adapters/agent/scenarios.js';

/**
 * End-to-end entry.
 *
 * This launches the COMPILED, real HTTP service (dist/src/adapters/http/main.js)
 * as its own OS process in CONTROLLABLE mode against a fresh SQLite file, then
 * drives it entirely over HTTP using the compiled build-agent simulator. It
 * asserts the hard properties (idempotency, late/unknown filtering, freshness,
 * single-conclusion concurrency, crash-then-retry) and, critically, restarts
 * the server process to prove the conclusion and causal log survive a crash
 * and reload from disk.
 *
 * No mocks, no in-process shortcuts, no real-time waiting: time is the server's
 * logical clock advanced via the control plane.
 */
const PORT = Number(process.env.E2E_PORT ?? 8199);
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;

function serverMainPath(): string {
  return fileURLToPath(new URL('../../src/adapters/http/main.js', import.meta.url));
}

function startServer(dbPath: string): ChildProcess {
  return spawn(process.execPath, [serverMainPath()], {
    env: { ...process.env, PORT: String(PORT), HOST, DB_PATH: dbPath, CONTROLLABLE: '1', CLOCK_START: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

async function waitForHealth(client: ControlCenterClient, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  // This wait is for process startup only (not domain timing); it polls the
  // real socket rather than sleeping a fixed duration.
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await client.health();
      if (r.status === 200) return;
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error('server did not become healthy in time');
}

async function stopServer(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    proc.once('exit', () => resolve());
    proc.kill('SIGKILL'); // hard kill == crash, to prove disk durability
  });
}

function fail(msg: string): never {
  console.error(`\nE2E FAILED: ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ccc-e2e-'));
  const dbPath = join(dir, 'e2e.sqlite');
  const client = new ControlCenterClient(BASE);
  let proc = startServer(dbPath);
  let serverLog = '';
  proc.stdout?.on('data', (d) => (serverLog += d));
  proc.stderr?.on('data', (d) => (serverLog += d));

  try {
    await waitForHealth(client);

    // 1) Run every built-in scenario against the real server.
    const sim = new AgentSimulator(client);
    let allPassed = true;
    for (const scenario of buildScenarios()) {
      const result = await sim.run(scenario);
      allPassed &&= result.passed;
      console.log(`${result.passed ? 'PASS' : 'FAIL'}  ${result.scenario}`);
      for (const step of result.steps) {
        if (!step.ok) console.log(`    ERR ${step.step} — ${step.detail}`);
      }
    }
    if (!allPassed) fail('one or more simulator scenarios failed');

    // 2) Durability across a real process crash. Set up an approved decision,
    //    then hard-kill and restart the server pointing at the same DB file.
    console.log('\n--- durability across process restart ---');
    await client.registerSubject({ subjectId: 'restart-subj', requiredConsumers: ['c'], freshnessWindowMs: 100_000 });
    const sub = await client.submitCandidate('restart-subj', {
      baselineSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      candidateSchema: { type: 'object', properties: { id: { type: 'string' }, x: { type: 'string' } }, required: ['id'] },
      submittedBy: 'dev'
    });
    const proposalId = sub.body.proposalId;
    const digest = sub.body.candidateDigest;
    await client.reportEvidence({ reportId: 'rr-1', subjectId: 'restart-subj', targetDigest: digest, consumerId: 'c', verdict: 'PASS', producedAt: 0 });
    const decided = await client.decide(proposalId, { expectedDigest: digest, type: 'APPROVE', decidedBy: 'mgr' });
    if (decided.body.status !== 'DECIDED') fail(`expected DECIDED, got ${JSON.stringify(decided.body)}`);
    const eventsBefore = (await client.events(0)).body.events.length;

    // Hard crash + restart.
    await stopServer(proc);
    proc = startServer(dbPath);
    serverLog = '';
    proc.stdout?.on('data', (d) => (serverLog += d));
    proc.stderr?.on('data', (d) => (serverLog += d));
    await waitForHealth(client);

    const recovered = await client.getProposal(proposalId);
    if (recovered.body.proposal.state !== 'APPROVED') fail('decision did not survive restart');
    if (!recovered.body.decision) fail('decision snapshot did not survive restart');
    const eventsAfter = (await client.events(0)).body.events.length;
    if (eventsAfter < eventsBefore) fail('causal event log shrank after restart');
    console.log(`ok  decision + causal log (${eventsAfter} events) recovered from SQLite`);

    // 3) Reconnecting client gets a consistent snapshot from durable storage.
    const snap = await client.snapshot();
    const subj = snap.body.subjects.find((s: any) => s.subject.subjectId === 'restart-subj');
    if (!subj || subj.history.find((h: any) => h.proposalId === proposalId)?.state !== 'APPROVED') {
      fail('snapshot after reconnect is not consistent with durable state');
    }
    console.log('ok  reconnect snapshot is consistent with durable state');

    // 4) Late evidence after the decision does not change the frozen snapshot.
    const frozen = JSON.stringify(recovered.body.decision.gateSnapshot);
    await client.reportEvidence({ reportId: 'rr-late', subjectId: 'restart-subj', targetDigest: digest, consumerId: 'c', verdict: 'FAIL', producedAt: 50 });
    const afterLate = await client.getProposal(proposalId);
    if (JSON.stringify(afterLate.body.decision.gateSnapshot) !== frozen) {
      fail('late evidence mutated a committed decision snapshot');
    }
    console.log('ok  late evidence did not alter the committed decision');

    console.log('\nE2E PASSED');
  } catch (err) {
    console.error('server log:\n' + serverLog);
    fail((err as Error).message);
  } finally {
    await stopServer(proc);
    rmSync(dir, { recursive: true, force: true });
  }
}

main();
