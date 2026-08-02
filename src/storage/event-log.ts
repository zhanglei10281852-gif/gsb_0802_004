import type { DB } from './schema.js';
import { digestString } from '../core/digest.js';
import type { CausalEvent } from '../core/types.js';

interface EventRow {
  event_id: number;
  proposal_id: string;
  occurred_at: number;
  event_type: string;
  payload_json: string;
  prev_hash: string;
  hash: string;
}

const GENESIS = '0'.repeat(64);

export function hashEvent(
  eventId: number,
  proposalId: string,
  occurredAt: number,
  eventType: string,
  payloadJson: string,
  prevHash: string,
): string {
  return digestString(
    `${prevHash}:${eventId}:${proposalId}:${occurredAt}:${eventType}:${payloadJson}`,
  );
}

function rowToEvent(row: EventRow): CausalEvent {
  return {
    eventId: row.event_id,
    proposalId: row.proposal_id,
    occurredAt: row.occurred_at,
    eventType: row.event_type,
    prevHash: row.prev_hash,
    hash: row.hash,
    payload: JSON.parse(row.payload_json),
  } as CausalEvent;
}

export class EventLog {
  constructor(private readonly db: DB) {}

  getLastHash(proposalId: string): string {
    const row = this.db
      .prepare(
        'SELECT hash FROM event_log WHERE proposal_id = ? ORDER BY event_id DESC LIMIT 1',
      )
      .get(proposalId) as { hash: string } | undefined;
    return row?.hash ?? GENESIS;
  }

  getLastEventId(): number {
    const row = this.db
      .prepare('SELECT MAX(event_id) AS m FROM event_log')
      .get() as { m: number | null };
    return row?.m ?? 0;
  }

  append(
    proposalId: string,
    occurredAt: number,
    eventType: CausalEvent['eventType'],
    payload: unknown,
  ): CausalEvent {
    const payloadJson = JSON.stringify(payload);
    const prevHash = this.getLastHash(proposalId);
    const info = this.db
      .prepare(
        `INSERT INTO event_log (proposal_id, occurred_at, event_type, payload_json, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(proposalId, occurredAt, eventType, payloadJson, prevHash, '__pending__');
    const eventId = Number(info.lastInsertRowid);
    const hash = hashEvent(eventId, proposalId, occurredAt, eventType, payloadJson, prevHash);
    this.db.prepare('UPDATE event_log SET hash = ? WHERE event_id = ?').run(hash, eventId);
    return {
      eventId,
      proposalId,
      occurredAt,
      eventType,
      prevHash,
      hash,
      payload,
    } as CausalEvent;
  }

  readAfter(eventId: number, limit = 1000): CausalEvent[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM event_log WHERE event_id > ? ORDER BY event_id ASC LIMIT ?',
      )
      .all(eventId, limit) as EventRow[];
    return rows.map(rowToEvent);
  }

  readForProposal(proposalId: string): CausalEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM event_log WHERE proposal_id = ? ORDER BY event_id ASC')
      .all(proposalId) as EventRow[];
    return rows.map(rowToEvent);
  }

  verifyChain(proposalId: string): boolean {
    const events = this.readForProposal(proposalId);
    let prev = GENESIS;
    for (const e of events) {
      const expected = hashEvent(
        e.eventId,
        e.proposalId,
        e.occurredAt,
        e.eventType,
        JSON.stringify(e.payload),
        prev,
      );
      if (expected !== e.hash || e.prevHash !== prev) return false;
      prev = e.hash;
    }
    return true;
  }
}
