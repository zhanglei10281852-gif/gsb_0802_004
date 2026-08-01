import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ManualClock, SystemClock, type Clock } from '../core/clock.js';
import { buildApp } from './app.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const port = Number(process.env.PORT ?? 4730);
const dbPath = process.env.DB_PATH ?? path.join(process.cwd(), 'data', 'control.db');
const ttlMs = Number(process.env.EVIDENCE_TTL_MS ?? 15 * 60 * 1000);
const clockMode = process.env.CONTRACT_CLOCK ?? 'system';

const clock: Clock =
  clockMode === 'manual'
    ? new ManualClock(Number(process.env.CLOCK_START ?? 1_700_000_000_000))
    : new SystemClock();

mkdirSync(path.dirname(dbPath), { recursive: true });

const app = await buildApp({
  dbPath,
  clock,
  defaultTtlMs: ttlMs,
  webRoot: path.join(here, '..', 'web'),
});

await app.listen({ port, host: '0.0.0.0' });
console.log(`[server] 数据契约变更控制中心已启动: http://localhost:${port}`);
console.log(`[server] SQLite: ${dbPath}`);
console.log(`[server] 时钟: ${clockMode}，证据 TTL: ${ttlMs}ms`);

let closing = false;
const shutdown = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
