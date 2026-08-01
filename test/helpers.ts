import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/storage/database.js';
import { Repository } from '../src/storage/repository.js';
import { VirtualClock } from '../src/domain/clock.js';
import type { Database as DB } from 'better-sqlite3';

export function createTestRepo(): { repo: Repository; db: DB; clock: VirtualClock; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'ccc-test-'));
  const dbPath = join(dir, 'test.sqlite');
  const db = openDatabase(dbPath);
  const clock = new VirtualClock(1000);
  const repo = new Repository(db, { clock });
  return {
    repo,
    db,
    clock,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const baselineSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    orderId: { type: 'string' },
    amount: { type: 'number', minimum: 0 },
  },
  required: ['orderId'],
};

export const compatibleCandidate = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    orderId: { type: 'string' },
    amount: { type: 'number', minimum: 0 },
    note: { type: 'string' },
  },
  required: ['orderId'],
};

export const breakingCandidate = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    orderId: { type: 'string' },
    amount: { type: 'number', minimum: 0 },
  },
  required: ['orderId', 'amount'],
};
