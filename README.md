# Contract Gate

A local-first **data contract change control center**. Dozens of services collaborate over shared
events; this system makes a JSON Schema change safe by requiring every consumer to verify the exact
candidate before a release manager can approve it.

- **Stack:** Node.js 20, TypeScript, Fastify, SQLite (better-sqlite3), React/Vite, JSON Schema 2020-12 (Ajv).
- **No Docker, no remote database, no external services.** Everything runs on `localhost`.
- The **compatibility engine and gate state machine are pure, decoupled modules** with no knowledge
  of HTTP, storage, UI or agents. The clock and fault points are injectable/replaceable.

---

## Core Semantics

### 1. Stable candidate identity

Every schema is **canonicalized** (recursive key sort) and hashed with SHA-256. Producers, the server
and all build agents reference a candidate only by its `candidateDigest`. A re-submission with the
same logical schema but different key order produces the **same digest**, so agents cannot be fooled
by cosmetic JSON differences.

### 2. Backward-compatibility report

`src/core/compatibility.ts` validates both schemas against the JSON Schema 2020-12 meta-schema and
applies rule-based diffs. Removing/narrowing a required field, narrowing an `enum`, raising
`minimum`, lowering `maximum`, restricting `additionalProperties`, etc. are flagged as breaking. The
report is part of the proposal and later frozen into the decision snapshot.

### 3. Evidence-based gate

A proposal moves `open → collecting → ready → approved/rejected`. It is **ready only when**:

- the schema is backward compatible,
- **every** registered consumer has reported evidence,
- the latest evidence per consumer is `pass`,
- every report is **fresh** (age ≤ `ttlMs`, measured against the server clock).

Each blocker carries a machine code (`incompatible-schema`, `missing-evidence`, `failing-evidence`,
`stale-evidence`) so the workbench can explain _why_ a release is blocked.

### 4. Idempotent evidence ingestion

Agents MUST send an `Idempotency-Key` header. Evidence is deduplicated on
`(proposal_id, idempotency_key)`. A retried report — identical key, even with a different status —
returns the original result (`deduped: true`) and never mutates stored evidence. This makes "write
succeeds, reply is lost, agent retries" exactly-once effective.

### 5. Late / stale / unknown results cannot pollute a proposal

- A report whose `candidateDigest` does not match the proposal is rejected (`candidate-mismatch`)
  and recorded as an `evidence-rejected` event — old candidates' late results are ignored.
- A report from a consumer not registered on the proposal is rejected (`unknown-consumer`).
- After a decision, any further evidence is rejected (`proposal-decided`).
- Freshness is always recomputed from the server clock, so stale evidence blocks even when present.

### 6. Immutable decision snapshots

A decision freezes an **immutable snapshot**: the exact candidate digest, compatibility digest, a
digest of the latest-per-consumer evidence set at that instant, counts, the full proposal snapshot,
the decider/rationale, and the `lastEventId`. The snapshot is stored as JSON on the proposal row and
is **never mutated**. New evidence arriving afterward cannot retroactively change the conclusion.

### 7. No contradictory concurrent decisions

The decision update uses a conditional UPDATE
(`... WHERE status NOT IN ('approved','rejected')`). If two approvals race, one wins and the other
receives a `409 CONFLICT`. The database is the single source of truth, not in-process state.

### 8. Causal, hash-chained event log

Every state change (`proposal-created`, `evidence-accepted`, `evidence-rejected`, `gate-advanced`,
`decision-recorded`, `proposal-superseded`, `exemption-requested`, `exemption-approved`,
`exemption-rejected`, `exemption-revoked`) is appended to an append-only `event_log`. Each event's hash
commits to the previous event's hash (`prev_hash`), forming a tamper-evident chain. The chain can be
verified with `EventLog.verifyChain(proposalId)`.

### 9. Time-boxed, two-reviewer exemptions (豁免)

A consumer that is temporarily offline during a release window can be covered by a **time-limited
exemption** instead of blocking the release. Exemptions are deliberately narrow:

- **Exact scope only** — an exemption is bound to one `candidateDigest`, one `consumerId`, one
  `environment` (e.g. `prod`) and one compatibility `direction` (`backward` | `forward` | `both`).
  It cannot match a different candidate, consumer or environment.
- **Two different reviewers must approve** (`REQUIRED_EXEMPTION_APPROVALS = 2`). The requester cannot
  review their own request, and the same reviewer cannot approve twice. A single rejection makes the
  exemption `rejected` and final.
- **Expires or is revoked** — an exemption has an `expiresAt`. Expiry is evaluated against the
  server clock; expired exemptions no longer contribute to _new_ decisions. An approved exemption can
  also be explicitly revoked. Expired/rejected/revoked exemptions remain in the audit log.
- **Never dilutes the candidate digest** — requesting or granting an exemption does not change the
  baseline/candidate digests or the compatibility report.
- **Frozen into the decision snapshot** — the set of exemptions _actually applied_ at decision time
  is stored inside the immutable `DecisionSnapshot.appliedExemptions` (plus an `exemptionsDigest`).
  An exemption that expires or is revoked **after** a decision cannot retroactively alter that
  historical snapshot. Revocation after a decision is rejected so the record stays stable.

The workbench shows pending/approved/rejected/revoked/expired exemptions, the two-review workflow, and
which exemptions were frozen into each decision.

### 10. Proposal lineage & successors

While a proposal waits for verification, upstream may revise the candidate. Instead of mutating the
open proposal (which would invalidate its evidence under a new digest), the operator creates a
**successor** from the current proposal:

`POST /api/proposals/:id/successor` with `{ candidate, author, ttlMs?, note? }`.

The operation runs in **one SQLite transaction** and produces a clear lineage:

- **New candidate digest** — the successor recomputes the digest from the revised schema, so it is a
  distinct candidate even if the topic and consumer names are identical.
- **No evidence or exemptions carry over** — evidence and exemptions are keyed by `proposal_id`; the
  successor gets a brand-new id, so its evidence and exemption sets start empty. A matching consumer
  **name** is never enough to inherit a prior result.
- **Predecessor is atomically superseded** — the old proposal becomes `superseded` (a compare-and-swap
  guards against a concurrent decision), linked to the successor via `successor_id` / `predecessor_id`,
  with `superseded_at`, `superseded_by` and a `note`.
- **Prior exemptions are revoked by their exact scope** — all `pending`/`approved` exemptions on the
  predecessor are revoked (`exemption-revoked`, reason `proposal-superseded`). They were bound to the
  old candidate digest, so they cannot apply to the successor; revoking them closes them on the old
  proposal and keeps the audit chain explicit.
- **Late/old results stay with the original** — a build result that arrives for the old proposal after
  supersession is rejected with `proposal-superseded` and recorded as an `evidence-rejected` event on
  that **predecessor** (the payload carries `successorId`). It is never written to, and can never
  release, the successor. The successor remains blocked until its **own** evidence arrives.
- A `proposal-superseded` event records the causal replacement on the predecessor's chain; the
  successor's chain opens with `proposal-created`. Both chains verify independently.

A `superseded` proposal is terminal: it cannot be decided or superseded again, and an
`approved`/`rejected` predecessor cannot be superseded (its immutable snapshot is preserved). The
workbench shows predecessor/successor navigation, a superseded banner explaining the isolation rules,
and a "create successor" form pre-filled with the current candidate.

---

## Failure & Recovery Boundaries

| Failure                                                  | Behavior                                                                                                                                                                                                    |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent retries a report (duplicate)                       | Idempotency key → original result, no duplicate row.                                                                                                                                                        |
| Server writes evidence, then crashes **before replying** | Write is committed in a SQLite transaction; on restart the evidence is present. Agent retry is deduped. The `crash-after-write` e2e scenario exercises this with a real hard-kill.                          |
| Response lost / out-of-order delivery                    | Idempotency keys + server-assigned `receivedAt` make ordering safe; only the latest evidence per consumer matters, and wrong digests are rejected.                                                          |
| Late report for an old candidate                         | `candidate-mismatch`, ignored.                                                                                                                                                                              |
| Unknown consumer reports                                 | `unknown-consumer`, ignored.                                                                                                                                                                                |
| Evidence arrives after a decision                        | `proposal-decided`, ignored; snapshot is untouched.                                                                                                                                                         |
| Candidate revised while waiting                          | Create a successor (`POST /api/proposals/:id/successor`); old proposal is atomically `superseded`, its exemptions revoked, and the successor starts with a new digest and no inherited evidence/exemptions. |
| Late/old build result arrives after supersession         | `proposal-superseded`, recorded on the **predecessor** (with `successorId`); it is never written to and cannot release the successor.                                                                       |
| Concurrently deciding and superseding a proposal         | Compare-and-swap: either the decision wins (then supersession is rejected as already-decided) or supersession wins (then deciding the old proposal is rejected as `superseded`) — never both.               |
| Two release managers approve concurrently                | Compare-and-swap in SQLite → exactly one wins, other gets 409.                                                                                                                                              |
| Exemption TTL passes                                     | It is reported as `expired` at read time; it stops gating new decisions but remains in the audit chain.                                                                                                     |
| Exemption revoked                                        | Status becomes `revoked`; it stops gating immediately. Revocation after a decision is rejected so the snapshot stays stable.                                                                                |
| Exemption requested for wrong scope/env/candidate        | It stays active in its own scope but never applies to another environment/consumer/candidate.                                                                                                               |
| Same reviewer reviews twice / requester self-reviews     | Rejected with 409; only two _distinct_ approvals count.                                                                                                                                                     |
| Process restart                                          | All proposals, evidence, decisions, exemptions and the event log are reloaded from SQLite (WAL mode, `synchronous=FULL`). SSE reconnects replay from `Last-Event-ID`/`?after=N`.                            |
| Clock skew / real-time waiting in tests                  | The clock is injectable. With `VIRTUAL_CLOCK=1` the server uses a manual clock advanced over `POST /api/debug/clock/advance`, so freshness scenarios run instantly.                                         |
| Tampering with the event log                             | Hash chain verification fails.                                                                                                                                                                              |

**Transaction boundary:** evidence insert + its event append happen in one SQLite transaction;
status transition + its event append happen in one transaction; decision row update + its event
append happen in one transaction. A crash cannot leave state without its causal record.

---

## Local Operation

### Install

```bash
npm install
```

### Test (unit + integration, in-memory and temp SQLite)

```bash
npm test
```

### Build (compiles server to `dist/`, builds React UI into `dist/public/`)

```bash
npm run build
```

### Start the real service

```bash
npm start
# open http://127.0.0.1:3000
```

Environment variables: `PORT` (default 3000), `HOST` (default 127.0.0.1), `DB_PATH`
(default `data/contract-gate.sqlite`).

### End-to-end (compiles, then boots compiled servers + agent simulator)

```bash
npm run e2e
```

This runs thirteen real-subprocess scenarios covering the happy path, duplicate/stale/wrong-digest/
unknown-consumer evidence, crash-after-write recovery, the two-reviewer exemption lifecycle (approval,
expiry, revocation, rejection, scope mismatch), and proposal lineage (`lineage-successor` proves
isolation and late-evidence attribution; `lineage-recovery` proves lineage survives a hard crash and
restart). Each boots the compiled `dist/server/main.js` with a virtual clock and drives it over real
HTTP.

### Run a single simulator scenario manually

```bash
npm run build
npm run simulate -- happy-path
```

### Dev mode (server hot reload; UI via Vite proxy)

```bash
npm run dev          # server on :3000
# another terminal:
npx vite             # UI on :5173, proxies /api and /events to :3000
```

---

## HTTP API

| Method | Path                                                | Purpose                                                                                                                                  |
| ------ | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/api/proposals`                                    | Submit baseline + candidate + consumers; returns digest + compatibility.                                                                 |
| `GET`  | `/api/proposals`                                    | List proposals.                                                                                                                          |
| `GET`  | `/api/proposals/:id?environment=prod`               | Full gate view: proposal, evidence, blockers, freshness, applied exemptions, event log.                                                  |
| `POST` | `/api/proposals/:id/successor`                      | Create a successor from a revised `{candidate, author, ttlMs?, note?}`; predecessor is atomically superseded and its exemptions revoked. |
| `POST` | `/api/proposals/:id/evidence`                       | Agent reports evidence (requires `Idempotency-Key`).                                                                                     |
| `POST` | `/api/proposals/:id/decision`                       | `{kind: approve\|reject, decider, rationale, environment?}`. Approve requires zero blockers (exemptions applied for that environment).   |
| `POST` | `/api/proposals/:id/exemptions`                     | Request a scoped, time-boxed exemption (`consumerId, environment, direction, reason, requestedBy, ttlMs`).                               |
| `GET`  | `/api/proposals/:id/exemptions`                     | List exemptions for a proposal.                                                                                                          |
| `POST` | `/api/proposals/:id/exemptions/:exemptionId/review` | `{reviewer, approved, comment}`; needs two distinct approvals; requester cannot review.                                                  |
| `POST` | `/api/proposals/:id/exemptions/:exemptionId/revoke` | `{revokedBy}`; revokes an active/pending exemption.                                                                                      |
| `GET`  | `/api/events?after=N`                               | Server-Sent Events; replays events after id `N`, then streams live.                                                                      |

The web workbench connects to `/api/events`, and on any (re)connect first fetches the authoritative
`GET /api/proposals/:id` snapshot, then resumes streaming from the last event id — so a reconnect
never relies on in-process-only state.

---

## Layout

```
src/core/        Pure domain: types, digest, compatibility (JSON Schema 2020-12), gate state machine, clock, errors
src/storage/     SQLite schema, hash-chained event log, repository (transactions, idempotency, CAS decisions)
src/service/     GateService orchestrating repository + injectable clock/faults
src/server/      Fastify app, routes, SSE, debug clock/fault control
src/web/         React workbench (Vite)
src/agent/       Build-agent simulator + scriptable scenarios
e2e/             Compiled end-to-end runner (boots real servers + simulator)
test/            Integration tests (repository concurrency/dedup/recovery, HTTP via inject)
```

The core modules have zero imports from `src/server`, `src/storage`, `src/web`, or `src/agent` —
this is what keeps contract compatibility and the gate state machine independent of adapters.
