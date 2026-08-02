# Data Contract Change Control Center

A locally-runnable control center for evolving JSON Schema event contracts across dozens of collaborating services. It replaces the "producer shipped, one consumer silently breaks" accident with an evidence-based gate: producers submit a baseline and a candidate schema, every consumer's build agent reports verification evidence, and release managers can only decide on the exact candidate once evidence is complete. Every decision is frozen as an immutable snapshot.

Built with Node.js 20, TypeScript, React, Fastify, SQLite, and JSON Schema 2020-12. No Docker, no remote database, no external services.

## Quick start

```powershell
npm install
npm run build
npm start
```

Then open http://127.0.0.1:3000. The SQLite database is created at `dist/data/ccc.sqlite` by default; override with `CCC_DB_PATH`.

Other fixed entry points:

| Command         | What it does                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm install`   | Installs dependencies                                                                                                                             |
| `npm test`      | Runs the Vitest unit suite (domain + storage guarantees)                                                                                          |
| `npm run build` | Compiles the TypeScript server and builds the React UI into `dist/`                                                                               |
| `npm start`     | Starts the compiled server and serves the built workbench                                                                                         |
| `npm run e2e`   | Builds everything, spawns the real server, runs the scripted agent simulator against it (including a process restart), and asserts all invariants |

Environment variables: `CCC_PORT` (default 3000), `CCC_HOST` (default 127.0.0.1), `CCC_DB_PATH`, `CCC_WEB_ROOT`, `CCC_LOG=1` for request logging.

## Core semantics

### Stable candidate identity

A candidate is identified by `sha256(canonicalJSON(candidateSchema))`, where canonicalization recursively sorts object keys ([hash.ts](src/domain/hash.ts)). Key ordering, formatting, or whitespace differences between producers do not create duplicate proposals. Evidence is bound to this hash, so a report for a different candidate can never silently attach to the current proposal.

### Backward compatibility

At submission the system runs a sound 2020-12 compatibility check ([compatibility.ts](src/domain/compatibility.ts)): the candidate is backward-compatible iff every instance accepted by the baseline is also accepted by the candidate. It validates both schemas with Ajv 2020-12 and structurally compares `type`, `required`, `properties`, `additionalProperties`, `enum`, `const`, numeric/string/array bounds, and common combinators. When it cannot prove safety it reports a blocking issue rather than guessing.

### Evidence gate

A proposal is `gateReady` only when **all** of the following hold ([gate.ts](src/domain/gate.ts)):

1. Every registered consumer has exactly one evidence record for this candidate hash.
2. Every consumer verdict is `compatible`.
3. The system compatibility check passed.
4. The proposal is still `pending`.

The "Approve" button is disabled until the gate is ready; "Reject" is always available while pending. Blocking reasons are shown verbatim.

### Immutable decisions

When a decision is made, the system stores a full snapshot of the proposal, all evidence, required/missing consumers, and the gate evaluation inside the `decisions` row. After a decision:

- The proposal status is flipped atomically (`UPDATE ... WHERE status='pending'`).
- New evidence is rejected with HTTP 409 and an `evidence_rejected` causal event.
- The snapshot is never mutated, so a later arriving "incompatible" report cannot retroactively change what was approved.

### Idempotency and ordering

Each evidence submission carries an `idempotencyKey`. The same key retried for the same `(proposal, consumer)` is a no-op and returns the original record (`deduped: true`). A genuinely new key updates that consumer's latest evidence while pending. This collapses duplicate retries, dropped responses, and "wrote the DB then crashed before replying" into exactly one effective write.

Late results are quarantined:

- Unknown consumer id → rejected.
- `candidateHash` not equal to the proposal hash → rejected (old candidate / wrong proposal).
- Proposal already decided → rejected.

Every rejection is still written to the append-only causal log as `evidence_rejected` so anomalies are explainable rather than invisible.

### Concurrency

Approval runs in a single `BEGIN IMMEDIATE` SQLite transaction that re-evaluates the gate, performs a conditional status update, and inserts the decision. A `UNIQUE(proposal_id)` constraint on `decisions` is the hard backstop: two concurrent approvals cannot both succeed. One wins, the other receives HTTP 409.

### Causal log and recovery

Every mutation appends a row to `causal_events` with an auto-increment id, a monotonic Lamport `clock`, and a wall-clock `recordedAt`. SQLite (WAL mode) is the source of truth — there is no in-memory state that can disagree with it. On restart the repository re-reads all rows and resumes the Lamport clock from `MAX(clock)`, so history, ordering, and decisions survive a process kill.

### Snapshot-on-reconnect, not in-process hope

The web workbench connects to `/api/stream` (SSE). On every (re)connection the server sends a fresh full snapshot from SQLite. Incremental events only nudge the client to refresh; reconnecting after a network blip or server restart always reconciles to the persisted state rather than relying on events that happened while the socket was down.

### Time-limited, dual-reviewed exemptions

A consumer that is temporarily offline during a release window can be waived, but the waiver is deliberately narrow:

- **Scoped** — an exemption binds exactly one `(candidateHash, consumerId, environment, direction)`. It cannot cover a different candidate, a different environment, or a different compatibility direction.
- **Two reviewers** — a reviewer (the requester) files the exemption; a _different_ reviewer must confirm it before it becomes `active`. Self-confirmation is rejected with HTTP 409. Pending exemptions do not affect the gate.
- **Time-limited** — each exemption has `validFrom`/`validUntil`. Once `validUntil` passes it is swept to `expired` (on the next read/decision/clock advance) and stops participating in new decisions. It can also be `revoked` at any time. Expiry and revocation are recorded as causal events.
- **Does not dilute the candidate summary** — an exemption never changes the candidate hash or the system compatibility result. A breaking schema is still blocked by the system check even if every consumer is exempted.
- **Does not override real evidence** — if a consumer actually reports `incompatible`, that verdict blocks the gate regardless of any exemption.
- **Frozen in the decision snapshot** — when a decision is made, every applied exemption is copied into the immutable `DecisionSnapshot` (requester, confirmer, window, reason). Later expiry or revocation changes the exemption row for _future_ decisions but never mutates the historical snapshot. A new proposal after an exemption expired sees the gate blocked again.

Exemption lifecycle events (`exemption_requested`, `exemption_confirmed`, `exemption_rejected`, `exemption_revoked`, `exemption_expired`) are appended to the same causal audit chain as proposals, evidence, and decisions.

### Deterministic timing tests (virtual clock)

The e2e suite also starts a second server with `CCC_CLOCK=virtual`, which replaces the wall clock with a `VirtualClock`. A test-only endpoint `POST /api/test/clock/advance {ms}` advances the clock and immediately sweeps expired exemptions, so expiry can be asserted deterministically without sleeping real time. This endpoint is only registered when the virtual clock is enabled and is never present in normal operation.

### Successor proposals and lineage

When upstream revises a candidate while a proposal is still waiting, a release manager creates a successor from the current proposal (`POST /api/proposals/:id/successor` with a new `candidateSchema`). This happens in one SQLite transaction:

- The corrected content is hashed; the new proposal gets a **new candidate hash**, `revision + 1`, `parentProposalId`, `replacesCandidateHash`, and the same `lineageRootId`, so the chain is unambiguous.
- The parent is atomically flipped to `superseded` and can no longer be approved or rejected; its gate never reports ready.
- The successor starts with **zero evidence**. Build evidence is bound to `proposal_id`, so the parent's evidence is never inherited — a consumer must verify the new candidate.
- All **open exemptions** for the parent's candidate hash are set to `voided` (recorded as `exemption_voided` events). Even though the consumer name and environment may be identical, an exemption is scoped to the exact candidate hash and therefore cannot carry over. A fresh dual-reviewed exemption is required for the successor.
- If a build agent that was still running against the old candidate reports back after the successor is created, the result is accepted onto the **superseded parent** (flagged `late: true` and recorded as `evidence_received_late`) for audit. It never lands on the successor and cannot unblock it. A report submitted to the successor with the _old_ candidate hash is rejected with HTTP 409.
- The full replacement is captured as `proposal_superseded` and `successor_created` causal events. Lineage (parent, revision, successors) survives process restart because it is stored in SQLite.

The workbench shows a lineage strip (parent → current → successors), a "Create revised proposal" form for pending proposals without successors, a `superseded` badge, and a `late` badge on evidence received after supersession.

### Phased rollout

Once a proposal is approved, a release owner can connect it to a phased deployment flow (`POST /api/proposals/:id/rollout`). A rollout is an ordered list of waves — each wave targets one environment and has a 1-based sequence with no gaps or duplicates. The first wave starts `in_progress`; the rest are `pending`.

- **Bound to the decision** — every rollout, wave, and receipt stores the `candidateHash` and `decisionId` of the approved proposal. A receipt can never advance a wave belonging to a different decision snapshot or successor proposal.
- **Adapter receipts** — a deployment adapter reports `success`, `failure`, or `unknown` (`POST /api/rollouts/:id/receipt`) with an `idempotencyKey`, `adapterId`, and optional message. Each receipt carries `(waveId, idempotencyKey)`; a repeated key returns the original receipt with `duplicate: true` and does not increment attempts or re-advance.
  - `success` marks the wave `succeeded` and atomically starts the next wave (`in_progress`), or marks the whole rollout `succeeded` on the final wave.
  - `failure` marks the wave and rollout `failed`; deployment halts until a human retries.
  - `unknown` is recorded (attempt count and last result updated) but does not advance or halt — the adapter can report again later.
- **Only the current wave advances** — receipts for a `pending`, `succeeded`, `failed`, or `paused` wave are rejected with HTTP 409. Duplicate and out-of-order receipts cannot skip ahead or replay a finished wave.
- **Pause / resume / retry** — an in-progress rollout can be paused (current wave becomes `paused`; receipts are rejected until resumed). A failed wave can be retried, returning it to `in_progress` and the rollout to `in_progress`.
- **Rollback** — an in-progress, paused, or failed rollout can be rolled back to a previous known version (`POST /api/rollouts/:id/rollback`). Unfinished waves are marked `rolled_back`; the rollout records `rolledBackTo` and `rolledBackAt`. Rollback **does not** rewrite the original contract decision (the proposal stays `approved`, the `DecisionSnapshot` is untouched) and **does not revive** exemptions that were `voided` by a successor. A completed (`succeeded`) rollout cannot be rolled back through this endpoint.
- **Persistence and recovery** — rollouts, waves, and receipts are stored in SQLite with `UNIQUE(rollout_id, sequence)` and `UNIQUE(wave_id, idempotency_key)` constraints. Wave status, attempt counts, and rollout state survive a process kill and restart; the adapter can resume by querying `GET /api/rollouts/:id` and retrying with the same idempotency key.

The workbench shows a rollout panel for approved proposals: a start form (default canary → staging → production waves), per-wave status badges and attempt counts, an adapter receipt form with a rotating idempotency key, retry on failed waves, pause/resume, and a rollback control.

### Coverage gaps (dependency topology changes during rollout)

If a new consumer registers after the contract decision was frozen — meaning it was not in the `DecisionSnapshot.requiredConsumerIds` — the rollout detects a **coverage gap**:

- The historical decision snapshot is **never modified**. The new consumer is not retroactively added; `requiredConsumerIds`, evidence, and applied exemptions remain exactly as they were at decision time.
- A `coverage_gap_detected` causal event is recorded, linked to the same `proposalId`/`lineageRootId`. The rollout is **auto-paused** (`pauseReason = 'coverage_gap'`), and **not-yet-started waves are held**.
- The wave already in flight stays `in_progress` — an adapter receipt that was already dispatched is accepted deterministically. On success, that wave is marked `succeeded` but the next wave does **not** start; the rollout remains paused until the gap is resolved. On failure, the rollout halts as usual.
- To resolve a gap, the new consumer (or its build agent) submits a **re-verification** (`POST /api/rollouts/:id/verify`) with a verdict (`compatible`/`incompatible`/`error`), details, and an idempotency key. A `compatible` verdict resolves the gap; the rollout can then be manually resumed. An `incompatible`/`error` verdict resolves the gap as negative and fails the rollout.
- **Deterministic concurrency:** because every mutation runs in a single SQLite `BEGIN IMMEDIATE` transaction, the race between an in-flight receipt and a topology change has one serialized outcome: either the receipt commits first (wave advances, then the gap pauses before the next wave) or the gap commits first (the current wave still accepts its receipt, but no further wave starts). In both cases no wave is skipped and no receipt is silently lost.
- All gap detection, auto-pause, re-verification, and resolution events (`coverage_gap_detected`, `rollout_auto_paused_coverage`, `reverification_recorded`, `coverage_gap_resolved`) are appended to the causal audit chain and survive process restart from SQLite.

The workbench displays each gap with its consumer, detection time, resolution status, and a verification form. A banner explains why the rollout is paused and which consumers must verify before resume is enabled.

## Architecture

The contract/gate core is deliberately decoupled from adapters:

```
src/domain/        pure logic: hashing, compatibility, gate state machine, clock
src/storage/       SQLite schema + repository (transactions, idempotency, snapshots)
src/http/          Fastify routes, SSE hub, static serving
src/agent/         script-controlled build agent simulator + fault-injecting HTTP client
src/bin/server.ts  production entry
src/bin/e2e-runner.ts  end-to-end orchestrator (spawns/restarts the real server)
web/               React workbench (Vite)
test/              Vitest unit tests
```

- The repository depends only on the `Clock` interface and a DB handle. The simulator uses a `VirtualClock`; production uses `SystemClock`. Clocks are swappable.
- The HTTP layer never implements gate rules; it calls the domain/storage. The SSE `EventHub` is a tiny pub/sub that is fed by the repository's event sink — storage does not import Fastify.
- The fault-injecting HTTP client ([simulator.ts](src/agent/simulator.ts)) can `duplicate` a request or `dropResponse` (abort after send, modeling write-before-reply crash). The e2e runner composes these without sleeping real time except for small process-health polls.

## HTTP API

| Method   | Path                             | Purpose                                                                                           |
| -------- | -------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------ |
| GET      | `/api/health`                    | Liveness                                                                                          |
| GET/POST | `/api/consumers`                 | List / register consumers                                                                         |
| GET/POST | `/api/proposals`                 | List / submit `{candidateSchema, baselineSchema, environment?}`                                   |
| GET      | `/api/proposals/:id`             | Detail with evidence, exemptions, gate state, blocking reasons, decision                          |
| POST     | `/api/proposals/:id/evidence`    | Agent report `{consumerId, candidateHash, verdict, details, idempotencyKey}`                      |
| POST     | `/api/proposals/:id/decision`    | `{action: "approve"                                                                               | "reject", reason}` |
| POST     | `/api/proposals/:id/successor`   | Create a revised candidate; supersedes the parent, voids its exemptions                           |
| GET      | `/api/proposals/:id/lineage`     | Full revision chain by lineage root                                                               |
| GET/POST | `/api/proposals/:id/rollout`     | Get / start a phased rollout (`{waves:[{sequence,environment}], previousVersion?}`)               |
| GET      | `/api/rollouts/:id`              | Rollout state with all waves                                                                      |
| POST     | `/api/rollouts/:id/receipt`      | Adapter receipt `{sequence, result, adapterId, idempotencyKey, message?}`                         |
| POST     | `/api/rollouts/:id/pause`        | Pause an in-progress rollout (`{reason?}`)                                                        |
| POST     | `/api/rollouts/:id/resume`       | Resume a paused rollout                                                                           |
| POST     | `/api/rollouts/:id/retry`        | Retry a failed wave (`{sequence}`)                                                                |
| POST     | `/api/rollouts/:id/rollback`     | Roll back to a previous known version (`{targetVersion, reason?}`)                                |
| POST     | `/api/rollouts/:id/verify`       | Re-verification for a coverage gap (`{consumerId, verdict, details, idempotencyKey, adapterId?}`) |
| GET/POST | `/api/exemptions?candidateHash=` | List / request a dual-reviewed, time-limited exemption                                            |
| POST     | `/api/exemptions/:id/confirm`    | Second reviewer confirms (`{confirmerId}`, must differ from requester)                            |
| POST     | `/api/exemptions/:id/reject`     | Reject a pending exemption (`{reviewerId, note}`)                                                 |
| POST     | `/api/exemptions/:id/revoke`     | Revoke an active exemption (`{reviewerId, note}`)                                                 |
| GET      | `/api/snapshot`                  | Full state snapshot (consumers + exemptions + proposal details + events)                          |
| GET      | `/api/causal-events`             | Append-only causal log                                                                            |
| GET      | `/api/stream`                    | Server-Sent Events: snapshot on connect, then causal events                                       |
| POST     | `/api/test/clock/advance`        | Test-only: advance virtual clock (`{ms}`); only when `CCC_CLOCK=virtual`                          |

## Fault recovery boundaries

- **Crash after write, before reply:** the evidence transaction commits before the response is written. The agent retries with the same `idempotencyKey`; the server returns the existing record. No duplicate evidence, no lost write.
- **Duplicate / out-of-order delivery:** idempotency keys collapse duplicates; hash + consumer validation rejects stale/unknown deliveries. The unique `(proposal_id, consumer_id)` index guarantees one current evidence per consumer.
- **Concurrent decisions:** SQLite transaction + unique constraint guarantee one effective decision.
- **Process restart:** all durable state is in SQLite; the Lamport clock and causal log are reconstructed on boot.
- **New evidence after a decision:** rejected; the stored snapshot is immutable.
- **Exemption expiry/revocation after a decision:** the exemption row changes status for future decisions, but the `appliedExemptions` already frozen inside the decision snapshot are never altered.
- **Duplicate/lost adapter receipts:** the `(wave_id, idempotency_key)` unique constraint collapses retries; a crash-after-write before the HTTP response is resolved by retrying with the same key (returns the stored receipt, no double advance). Out-of-order receipts for a non-current wave are rejected.
- **Rollback:** rollback marks unfinished waves `rolled_back` and records the target version, but never mutates the `decisions` row, the proposal's `approved` status, or any exemption (voided exemptions stay voided).
- **Process restart mid-rollout:** wave status, attempt counts, receipts, coverage gaps, and rollout status are all in SQLite; after restart the adapter queries the rollout, finds the current wave, and resumes. A paused rollout stays paused; resolved gaps stay resolved.
- **Topology change during rollout (coverage gap):** a new consumer registration in the same SQLite transaction creates a gap and auto-pauses the rollout. The in-flight wave's receipt is still accepted (deterministic serialization), but no subsequent wave starts until the gap is resolved with a re-verification. The frozen decision snapshot is never altered.
- **Incompatible re-verification:** a negative verdict resolves the gap as `resolved_incompatible` and fails the rollout; the proposal stays approved but deployment is halted for human review.
- **Web disconnect:** SSE auto-reconnects and receives a fresh full snapshot; missed events are not required for correctness.

## End-to-end scenarios

`npm run e2e` exercises, against the compiled server:

1. Registering consumers and submitting a compatible proposal.
2. Duplicate evidence delivery (asserted deduped).
3. Dropped-response / crash-after-write followed by a retry (asserted one evidence, deduped).
4. Unknown-consumer and wrong-hash late results (asserted rejected, no pollution).
5. Two concurrent approvals (asserted exactly one wins).
6. Post-decision evidence (asserted rejected, snapshot frozen).
7. SSE snapshot on connect.
8. Killing and restarting the server process on the same SQLite file (asserted status, evidence, snapshot, and causal log all survive with identical clocks/order).
9. A breaking candidate that all consumers claim is fine (asserted system gate still blocks approval; rejection allowed).
10. On a separate **virtual-clock** server: dual-reviewer exemption request (self-confirm rejected, different reviewer accepted), approval through the exemption, frozen snapshot containing the exemption, then a second proposal whose exemption expires deterministically after advancing the virtual clock (asserted gate re-blocks, `exemption_expired` audited, and the earlier frozen snapshot is unchanged).
11. **Successor lineage:** create a revised candidate from a pending proposal (asserted parent superseded, new hash, revision 2, zero inherited evidence, old open exemptions voided); a late result for the old candidate is filed to the superseded parent as `late` and never reaches the successor; a report to the successor carrying the old hash is rejected; `proposal_superseded`/`successor_created`/`exemption_voided`/`evidence_received_late` are audited; after a process restart the lineage links and late flag are recovered.
12. **Phased rollout (on a dedicated server):** an approved proposal starts a 3-wave rollout bound to its decision snapshot; a duplicate receipt delivery is deduped (one receipt, one attempt); a lost-response/crash-after-write receipt is retried with the same key and deduped; out-of-order receipts for pending/succeeded waves are rejected; a failure halts the rollout, retry returns the wave to `in_progress`, an `unknown` receipt is recorded without advancing; the rollout is paused, the server is killed and restarted (paused state, attempt counts, and prior waves survive), then resumed and completed; rollback of a succeeded rollout is rejected; a separate successor-based rollout verifies that rollback leaves the contract decision `approved` and does not revive `voided` exemptions. All rollout/wave lifecycle events are audited in the causal chain.
13. **Coverage gaps (on a dedicated server):** after wave 1 succeeds and wave 2 is in flight, a new consumer registers (topology change). The rollout auto-pauses with `pauseReason=coverage_gap`; the in-flight wave 2 receipt is still accepted (deterministic) but wave 3 is held; resume is blocked until the gap is resolved. A compatible re-verification resolves the gap, resume starts wave 3, and the rollout completes — while the frozen decision snapshot still records only the original consumers. Duplicate verification submissions are deduped. After a process restart the gap and its resolution persist. A second rollout verifies that an incompatible re-verification fails the rollout, and that verification on an already-succeeded rollout is rejected.

## Local development workflow

```powershell
# run the server directly from TS (no UI build; use Vite dev server for UI)
npm run dev

# in another terminal, run the UI with HMR (proxies /api to :3000)
npx vite
```

The Vite dev server runs on http://localhost:5173 and proxies `/api` to the Fastify server on port 3000.
