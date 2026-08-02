import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './storage/database.js';
import { Repository } from './storage/repository.js';
import { SystemClock, VirtualClock } from './domain/clock.js';
import { EventHub } from './http/event-hub.js';
import { buildServer } from './http/server.js';
import type { Clock } from './domain/clock.js';
import type { FastifyInstance } from 'fastify';

const here = dirname(fileURLToPath(import.meta.url));

export interface AppConfig {
  dbPath: string;
  webRoot: string;
  port: number;
  host: string;
  logger: boolean;
  virtualClock: boolean;
}

export function defaultConfig(): AppConfig {
  return {
    dbPath: process.env.CCC_DB_PATH ?? join(here, '..', 'data', 'ccc.sqlite'),
    webRoot: process.env.CCC_WEB_ROOT ?? join(here, 'web'),
    port: Number(process.env.CCC_PORT ?? 3000),
    host: process.env.CCC_HOST ?? '127.0.0.1',
    logger: process.env.CCC_LOG === '1',
    virtualClock: process.env.CCC_CLOCK === 'virtual',
  };
}

export interface App {
  server: FastifyInstance;
  repository: Repository;
  eventHub: EventHub;
  clock: Clock;
  config: AppConfig;
  advanceClock?: (ms: number) => number;
}

export async function createApp(config: Partial<AppConfig> = {}, clock?: Clock): Promise<App> {
  const cfg = { ...defaultConfig(), ...config };
  const db = openDatabase(cfg.dbPath);
  const virtualClock = cfg.virtualClock ? new VirtualClock(0) : undefined;
  const resolvedClock = clock ?? virtualClock ?? new SystemClock();
  const eventHub = new EventHub();
  const repository = new Repository(db, {
    clock: resolvedClock,
    eventSink: (event) => eventHub.publish(event),
  });
  const server = await buildServer({
    repository,
    eventHub,
    webRoot: cfg.webRoot,
    logger: cfg.logger,
    testMode: cfg.virtualClock,
    onAdvanceClock: virtualClock
      ? (ms: number) => {
          const t = virtualClock.advance(ms);
          repository.sweepExpiredExemptions();
          return t;
        }
      : undefined,
  });
  return {
    server,
    repository,
    eventHub,
    clock: resolvedClock,
    config: cfg,
    advanceClock: virtualClock ? (ms: number) => virtualClock.advance(ms) : undefined,
  };
}
