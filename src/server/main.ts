import { buildApp } from './app.js';
import { createClockFromEnv } from './clock-control.js';
import { ScriptableFaults } from './faults.js';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
const dbPath = process.env.DB_PATH ?? 'data/contract-gate.sqlite';
const controllableClock = createClockFromEnv();
const debugFaults = process.env.DEBUG_FAULTS === '1' ? new ScriptableFaults() : undefined;

const built = await buildApp({
  dbPath,
  port,
  host,
  serveStatic: true,
  clock: controllableClock,
  controllableClock,
  enableDebugClock: controllableClock.mode === 'manual',
  scriptableFaults: debugFaults,
  enableDebugFaults: Boolean(debugFaults),
});

try {
  await built.app.listen({ port, host });
  built.app.log.info(
    `contract-gate listening on http://${host}:${port} (clock=${controllableClock.mode})`,
  );
} catch (err) {
  built.app.log.error(err);
  process.exit(1);
}

const shutdown = async (signal: string): Promise<void> => {
  built.app.log.info(`received ${signal}, shutting down`);
  await built.app.close();
  built.db.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
