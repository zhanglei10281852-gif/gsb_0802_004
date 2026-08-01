import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Deterministic clean step used by `npm run build`. Removes compiled output
// so builds never mix stale artifacts across runs.
const targets = ['../dist', '../web/dist'];

for (const t of targets) {
  const p = fileURLToPath(new URL(t, import.meta.url));
  await rm(p, { recursive: true, force: true });
  console.log(`cleaned ${p}`);
}
