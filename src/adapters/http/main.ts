import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ControlCenterService } from '../../app/control-center-service.js';
import { SqliteRepository } from '../store/sqlite-repository.js';
import { SystemClock, LogicalClock } from '../../domain/clock.js';
import { ArmableFaults, NoFaults } from '../../ports/faults.js';
import { buildServer, defaultWebDir } from './server.js';

/**
 * Composition root.
 *
 * Wires the concrete adapters (SQLite, clock, faults) into the application
 * service and the HTTP server. This is the only place production dependencies
 * are chosen; everything below the service depends on ports, not on these
 * concrete classes.
 *
 * Environment:
 *   PORT              HTTP port (default 8080)
 *   DB_PATH           SQLite file (default ./data/control-center.sqlite)
 *   CONTROLLABLE=1    use a LogicalClock + ArmableFaults and expose the
 *                     test-only control plane (used by the e2e harness)
 *   CLOCK_START       initial logical time when CONTROLLABLE=1 (default 0)
 */
export interface StartedServer {
  url: string;
  close: () => Promise<void>;
}

export async function startServer(): Promise<StartedServer> {
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? '127.0.0.1';
  const dbPath = process.env.DB_PATH ?? './data/control-center.sqlite';
  const controllable = process.env.CONTROLLABLE === '1';

  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const repo = new SqliteRepository(dbPath);
  const clock = controllable ? new LogicalClock(Number(process.env.CLOCK_START ?? 0)) : new SystemClock();
  const faults = controllable ? new ArmableFaults() : new NoFaults();
  const service = new ControlCenterService(repo, clock, faults);

  const app = await buildServer({
    service,
    logicalClock: controllable ? (clock as LogicalClock) : undefined,
    faults: controllable ? (faults as ArmableFaults) : undefined,
    webDir: defaultWebDir(),
    logger: process.env.LOG === '1'
  });

  await app.listen({ port, host });
  const url = `http://${host}:${port}`;
  // eslint-disable-next-line no-console
  console.log(`[control-center] listening on ${url} (db=${dbPath}, controllable=${controllable})`);

  return {
    url,
    close: async () => {
      await app.close();
      repo.close();
    }
  };
}

// Start when invoked directly (npm start / e2e).
startServer().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[control-center] failed to start:', err);
  process.exit(1);
});
