import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(here, "..", "..");
const cliPath = resolve(root, "dist", "agent", "cli.js");

interface ScenarioResult {
  name: string;
  exitCode: number | null;
  output: string;
}

const scenarios = [
  "happy-path",
  "duplicate-evidence",
  "stale-evidence",
  "crash-after-write",
  "wrong-digest",
  "unknown-consumer",
  "exemption-approved",
  "exemption-expiry",
  "exemption-revoked",
  "exemption-rejected",
  "exemption-scope-mismatch",
  "lineage-successor",
  "lineage-recovery",
  "rollout-phased",
  "rollout-duplicate-out-of-order",
  "rollout-pause-retry-rollback",
  "rollout-receipt-loss-recovery",
];

function runScenario(name: string, port: number): Promise<ScenarioResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [cliPath, name], {
      cwd: root,
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d) => {
      output += d.toString();
      process.stdout.write(`[${name}] ${d}`);
    });
    child.stderr.on("data", (d) => {
      output += d.toString();
      process.stderr.write(`[${name}:err] ${d}`);
    });
    child.on("exit", (code) =>
      resolvePromise({ name, exitCode: code, output }),
    );
  });
}

async function main(): Promise<void> {
  if (!existsSync(cliPath)) {
    console.error(
      `Compiled agent CLI not found at ${cliPath}. Run "npm run build" first.`,
    );
    process.exit(1);
  }

  console.log(
    "Running end-to-end scenarios against compiled service + agent simulator...\n",
  );
  const results: ScenarioResult[] = [];
  let port = 3200;
  for (const name of scenarios) {
    console.log(`\n========== ${name} ==========`);
    const r = await runScenario(name, port++);
    results.push(r);
    if (r.exitCode !== 0) {
      console.error(`SCENARIO FAILED: ${name} (exit ${r.exitCode})`);
    }
  }

  console.log("\n========== E2E SUMMARY ==========");
  let failed = 0;
  for (const r of results) {
    const ok = r.exitCode === 0;
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${r.name}`);
  }
  if (failed > 0) {
    console.error(`\n${failed} scenario(s) failed`);
    process.exit(1);
  }
  console.log("\nAll end-to-end scenarios passed.");
}

void main();
