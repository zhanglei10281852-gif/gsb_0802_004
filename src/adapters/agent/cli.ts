import { ControlCenterClient } from './client.js';
import { AgentSimulator } from './simulator.js';
import { buildScenarios } from './scenarios.js';

/**
 * CLI entry for the build-agent simulator.
 *
 * Usage:
 *   node dist/src/adapters/agent/cli.js [baseUrl] [scenarioName]
 *
 * With no scenario name it runs every built-in scenario against the server at
 * baseUrl (default http://127.0.0.1:8080). The server must have been started
 * with CONTROLLABLE=1 so the simulator can drive logical time and arm faults.
 * Exit code is non-zero if any scenario fails, so it doubles as a check.
 */
async function main(): Promise<void> {
  const baseUrl = process.argv[2] ?? 'http://127.0.0.1:8080';
  const only = process.argv[3];
  const client = new ControlCenterClient(baseUrl);
  const sim = new AgentSimulator(client);

  const scenarios = buildScenarios().filter((s) => !only || s.name === only);
  if (scenarios.length === 0) {
    console.error(`no scenario named "${only}"`);
    process.exit(2);
  }

  let allPassed = true;
  for (const scenario of scenarios) {
    const result = await sim.run(scenario);
    allPassed &&= result.passed;
    console.log(`\n${result.passed ? 'PASS' : 'FAIL'}  ${result.scenario}`);
    for (const step of result.steps) {
      console.log(`  ${step.ok ? 'ok ' : 'ERR'} ${step.step}${step.detail ? ` — ${step.detail}` : ''}`);
    }
  }

  console.log(`\n${allPassed ? 'ALL SCENARIOS PASSED' : 'SOME SCENARIOS FAILED'}`);
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error('simulator error:', err);
  process.exit(1);
});
