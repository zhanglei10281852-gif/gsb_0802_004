import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, type DB } from '../storage/schema.js';
import { GateService, type FaultInjector } from '../service/gate-service.js';
import type { Clock } from '../core/clock.js';
import { SystemClock } from '../core/clock.js';
import { EventHub } from './event-hub.js';
import { registerRoutes } from './routes.js';
import type { ControllableClock } from './clock-control.js';
import type { ScriptableFaults } from './faults.js';

export interface AppOptions {
  dbPath?: string;
  db?: DB;
  clock?: Clock;
  controllableClock?: ControllableClock;
  faults?: FaultInjector;
  scriptableFaults?: ScriptableFaults;
  port?: number;
  host?: string;
  serveStatic?: boolean;
  logLevel?: string;
  enableDebugClock?: boolean;
  enableDebugFaults?: boolean;
}

export interface BuiltApp {
  app: FastifyInstance;
  service: GateService;
  hub: EventHub;
  db: DB;
  clock: Clock;
  controllableClock?: ControllableClock;
}

export async function buildApp(options: AppOptions = {}): Promise<BuiltApp> {
  const db = options.db ?? openDatabase(options.dbPath ?? resolve('data/contract-gate.sqlite'));
  const clock = options.clock ?? new SystemClock();
  const hub = new EventHub();
  const service = new GateService(db, clock, options.faults ?? options.scriptableFaults ?? new (class {
    shouldCrashAfterWrite(): boolean { return false; }
  })(), (ev) => hub.publish(ev));

  const app = Fastify({
    logger: { level: options.logLevel ?? (process.env.LOG_LEVEL ?? 'info') },
    disableRequestLogging: false,
  });

  await app.register(cors, { origin: '*' });
  await registerRoutes(app, { service, hub });

  if (options.enableDebugClock && options.controllableClock) {
    app.post<{ Body: { ms?: number } }>('/api/debug/clock/advance', async (req) => {
      const ms = Number(req.body?.ms ?? 0);
      const now = options.controllableClock!.advance(ms);
      return { now, mode: options.controllableClock!.mode };
    });
    app.post<{ Body: { ms?: number } }>('/api/debug/clock/set', async (req) => {
      const ms = Number(req.body?.ms ?? Date.now());
      const now = options.controllableClock!.set(ms);
      return { now };
    });
    app.get('/api/debug/clock', async () => ({ now: options.controllableClock!.now(), mode: options.controllableClock!.mode }));
  }

  if (options.enableDebugFaults && options.scriptableFaults) {
    app.post<{ Body: { stage?: 'after-evidence-insert' | 'before-evidence-insert' } }>('/api/debug/faults/crash-after-write', async (req) => {
      options.scriptableFaults!.armCrashAfterWrite(req.body?.stage ?? 'after-evidence-insert');
      return { armed: true };
    });
  }

  if (options.serveStatic !== false) {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const publicDir = resolve(here, '..', 'public');
    if (existsSync(publicDir)) {
      await app.register(fastifyStatic, { root: publicDir });
      app.setNotFoundHandler((req, reply) => {
        if (req.raw.url?.startsWith('/api/')) {
          reply.status(404).send({ error: 'NOT_FOUND' });
        } else {
          reply.sendFile('index.html');
        }
      });
    }
  }

  return { app, service, hub, db, clock, controllableClock: options.controllableClock };
}
