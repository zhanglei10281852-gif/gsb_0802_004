#!/usr/bin/env node
import { resolve } from 'node:path';
import { AgentSimulator } from './simulator.js';
import { scenarios } from './scenarios.js';

async function main(): Promise<void> {
  const scenarioName = process.argv[2] ?? 'happy-path';
  const port = process.env.PORT ?? '3100';
  const baseUrl = `http://127.0.0.1:${port}`;
  const dbPath = resolve(process.cwd(), 'data', `sim-${scenarioName}.sqlite`);
  const serverEntry = resolve(process.cwd(), 'dist/server/main.js');

  const factory = scenarios[scenarioName];
  if (!factory) {
    console.error(`unknown scenario: ${scenarioName}. available: ${Object.keys(scenarios).join(', ')}`);
    process.exit(2);
  }

  const sim = new AgentSimulator({ baseUrl, dbPath, serverEntry });
  try {
    await sim.startServer();
    const { proposalId, finalView } = await sim.runScenario(factory());
    console.log('\n=== SCENARIO COMPLETE ===');
    console.log('proposal:', proposalId);
    console.log('status:', finalView.proposal.status);
    console.log('blockers:', finalView.blockers.length);
    console.log('evidence:', finalView.evidence.length, 'records');
    console.log('events:', finalView.eventLog.length, 'causal events');
  } catch (err) {
    console.error('scenario failed:', err);
    process.exitCode = 1;
  } finally {
    await sim.stopServer();
  }
}

void main();
