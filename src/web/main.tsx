import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
} from "react";
import { createRoot } from "react-dom/client";
import { api, connectEvents, type EventSourceState } from "./api";
import type {
  CausalEvent,
  ExemptionRecord,
  GateView,
  StoredProposal,
} from "./types";
import "./styles.css";

const SAMPLE_BASELINE = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    orderId: { type: "string" },
    amount: { type: "number", minimum: 0 },
    currency: { type: "string", enum: ["USD", "EUR", "GBP"] },
  },
  required: ["orderId", "amount", "currency"],
  additionalProperties: false,
};

const SAMPLE_CANDIDATE = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    orderId: { type: "string" },
    amount: { type: "number", minimum: 1 },
    currency: { type: "string", enum: ["USD", "EUR"] },
    region: { type: "string" },
  },
  required: ["orderId", "amount", "currency", "region"],
  additionalProperties: false,
};

const CONSUMER_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
};

function App(): React.ReactElement {
  const [proposals, setProposals] = useState<StoredProposal[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [gate, setGate] = useState<GateView | null>(null);
  const [conn, setConn] = useState<EventSourceState>("connecting");
  const [showCreate, setShowCreate] = useState(false);
  const lastEventId = useRef(0);

  const refreshList = useCallback(async () => {
    const { proposals } = await api.listProposals();
    setProposals(proposals);
  }, []);

  const refreshGate = useCallback(async (id: string) => {
    const view = await api.getGateView(id);
    setGate(view);
    const lastEv = view.eventLog[view.eventLog.length - 1];
    if (lastEv)
      lastEventId.current = Math.max(lastEventId.current, lastEv.eventId);
  }, []);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  useEffect(() => {
    if (!selectedId) {
      setGate(null);
      return;
    }
    void refreshGate(selectedId);
  }, [selectedId, refreshGate]);

  useEffect(() => {
    const stop = connectEvents(
      (ev) => {
        const data = ev.data as { proposalId?: string } | null;
        const pid = data?.proposalId;
        lastEventId.current = ev.id;
        void refreshList();
        if (selectedId && pid === selectedId) {
          void refreshGate(selectedId);
        }
      },
      setConn,
      lastEventId.current,
    );
    return stop;
  }, [refreshList, refreshGate, selectedId]);

  return (
    <div className="app">
      <div className="header">
        <div>
          <h1>Contract Gate</h1>
          <div className="subtitle">
            Data contract change control center · evidence-based release gating
          </div>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <span className={`connection ${conn}`}>SSE: {conn}</span>
          <button
            className="secondary"
            onClick={() => setShowCreate((v) => !v)}
          >
            {showCreate ? "Close" : "New Proposal"}
          </button>
        </div>
      </div>

      {showCreate && (
        <CreateForm
          onCreated={(p) => {
            setShowCreate(false);
            setSelectedId(p.proposalId);
            void refreshList();
          }}
        />
      )}

      <div className="layout">
        <div className="panel">
          <h2>Proposals ({proposals.length})</h2>
          {proposals.length === 0 && (
            <div className="empty">No proposals yet</div>
          )}
          {proposals.map((p) => (
            <div
              key={p.proposalId}
              className={`proposal-item ${selectedId === p.proposalId ? "active" : ""}`}
              onClick={() => setSelectedId(p.proposalId)}
            >
              <div className="topic">{p.topic}</div>
              <div className="meta">
                <span className={`badge ${p.status}`}>{p.status}</span>
                <span>{p.consumers.length} consumers</span>
                <span>by {p.author}</span>
              </div>
            </div>
          ))}
        </div>

        <div>
          {gate ? (
            <GateDetail
              gate={gate}
              onDecision={() => selectedId && refreshGate(selectedId)}
              onNavigate={(id) => setSelectedId(id)}
              onCreated={() => refreshList()}
            />
          ) : (
            <div className="panel empty">
              Select a proposal to inspect its gate
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CreateForm({
  onCreated,
}: {
  onCreated: (p: StoredProposal) => void;
}): React.ReactElement {
  const [topic, setTopic] = useState("order.events");
  const [author, setAuthor] = useState("alice");
  const [ttlMs, setTtlMs] = useState(60000);
  const [baseline, setBaseline] = useState(
    JSON.stringify(SAMPLE_BASELINE, null, 2),
  );
  const [candidate, setCandidate] = useState(
    JSON.stringify(SAMPLE_CANDIDATE, null, 2),
  );
  const [consumers, setConsumers] = useState("billing,payments,shipping");
  const [error, setError] = useState("");

  async function submit(): Promise<void> {
    setError("");
    try {
      const p = await api.createProposal({
        topic,
        author,
        ttlMs: Number(ttlMs),
        baseline: JSON.parse(baseline),
        candidate: JSON.parse(candidate),
        consumers: consumers
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((consumerId) => ({ consumerId, schema: CONSUMER_SCHEMA })),
      });
      onCreated(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="panel" style={{ marginBottom: 20 }}>
      <h2>Submit Baseline &amp; Candidate Contract</h2>
      <div className="form-row">
        <div className="field">
          <label>Topic</label>
          <input value={topic} onChange={(e) => setTopic(e.target.value)} />
        </div>
        <div className="field">
          <label>Author</label>
          <input value={author} onChange={(e) => setAuthor(e.target.value)} />
        </div>
      </div>
      <div className="form-row">
        <div className="field">
          <label>Evidence TTL (ms)</label>
          <input
            type="number"
            value={ttlMs}
            onChange={(e) => setTtlMs(Number(e.target.value))}
          />
        </div>
        <div className="field">
          <label>Consumers (comma-separated)</label>
          <input
            value={consumers}
            onChange={(e) => setConsumers(e.target.value)}
          />
        </div>
      </div>
      <div className="form-row">
        <div className="field">
          <label>Baseline JSON Schema (2020-12)</label>
          <textarea
            rows={10}
            value={baseline}
            onChange={(e) => setBaseline(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Candidate JSON Schema (2020-12)</label>
          <textarea
            rows={10}
            value={candidate}
            onChange={(e) => setCandidate(e.target.value)}
          />
        </div>
      </div>
      {error && (
        <div className="blocker">
          <span className="code">ERROR</span>
          {error}
        </div>
      )}
      <button onClick={() => void submit()}>
        Calculate Digest &amp; Create Proposal
      </button>
    </div>
  );
}

function GateDetail({
  gate,
  onDecision,
  onNavigate,
  onCreated,
}: {
  gate: GateView;
  onDecision: () => void;
  onNavigate: (id: string) => void;
  onCreated: () => void;
}): React.ReactElement {
  const {
    proposal,
    evidence,
    blockers,
    evidenceFreshness,
    exemptions,
    appliedExemptions,
    environment,
    eventLog,
  } = gate;
  const [tab, setTab] = useState<
    "overview" | "exemptions" | "schemas" | "events" | "decision"
  >("overview");
  const [decider, setDecider] = useState("release-manager");
  const [rationale, setRationale] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function decide(kind: "approve" | "reject"): Promise<void> {
    setBusy(true);
    setError("");
    try {
      await api.decide(
        proposal.proposalId,
        kind,
        decider,
        rationale,
        environment,
      );
      onDecision();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const latestByConsumer = useMemo(() => {
    const m = new Map<string, (typeof evidence)[number]>();
    for (const e of evidence) {
      const ex = m.get(e.consumerId);
      if (!ex || e.receivedAt > ex.receivedAt) m.set(e.consumerId, e);
    }
    return m;
  }, [evidence]);

  return (
    <div className="panel">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
        }}
      >
        <div>
          <h2 style={{ marginBottom: 4 }}>{proposal.topic}</h2>
          <div style={{ fontSize: 12, color: "var(--muted)" }}>
            {proposal.proposalId}
          </div>
        </div>
        <span className={`badge ${proposal.status}`}>{proposal.status}</span>
      </div>

      <LineageBanner
        proposal={proposal}
        onNavigate={onNavigate}
        onCreated={onCreated}
        onChange={onDecision}
      />

      {proposal.decision && (
        <div className={`decision-banner ${proposal.decision.kind}`}>
          <strong>{proposal.decision.kind.toUpperCase()}</strong> by{" "}
          {proposal.decision.decider} at{" "}
          {new Date(proposal.decision.decidedAt).toISOString()}
          <div style={{ marginTop: 6, fontSize: 12, color: "var(--muted)" }}>
            {proposal.decision.rationale}
          </div>
          <div style={{ marginTop: 6, fontSize: 11, color: "var(--muted)" }}>
            evidenceDigest {proposal.decision.evidenceDigest.slice(0, 16)}… ·
            evidence {proposal.decision.passCount}✓/
            {proposal.decision.failCount}✗ · lastEventId{" "}
            {proposal.decision.lastEventId}
          </div>
          {(proposal.decision.appliedExemptions?.length ?? 0) > 0 && (
            <div style={{ marginTop: 6, fontSize: 11, color: "var(--amber)" }}>
              frozen with {proposal.decision.appliedExemptions.length}{" "}
              exemption(s):{" "}
              {proposal.decision.appliedExemptions
                .map((a) => `${a.consumerId}@${a.environment}[${a.direction}]`)
                .join(", ")}
            </div>
          )}
        </div>
      )}

      <div className="tabs">
        <div
          className={`tab ${tab === "overview" ? "active" : ""}`}
          onClick={() => setTab("overview")}
        >
          Overview &amp; Blockers
        </div>
        <div
          className={`tab ${tab === "exemptions" ? "active" : ""}`}
          onClick={() => setTab("exemptions")}
        >
          Exemptions ({exemptions.length})
        </div>
        <div
          className={`tab ${tab === "schemas" ? "active" : ""}`}
          onClick={() => setTab("schemas")}
        >
          Schemas &amp; Compatibility
        </div>
        <div
          className={`tab ${tab === "events" ? "active" : ""}`}
          onClick={() => setTab("events")}
        >
          Causal Log ({eventLog.length})
        </div>
        {!proposal.decision && (
          <div
            className={`tab ${tab === "decision" ? "active" : ""}`}
            onClick={() => setTab("decision")}
          >
            Decision
          </div>
        )}
      </div>

      {tab === "overview" && (
        <>
          <h3>Blockers</h3>
          {blockers.length === 0 ? (
            <div
              style={{
                padding: 12,
                color: "var(--green)",
                background: "#0f2a18",
                borderRadius: 6,
                marginBottom: 16,
              }}
            >
              All evidence complete and fresh — gate is ready for a decision.
            </div>
          ) : (
            blockers.map((b, i) => (
              <div className="blocker" key={i}>
                <span className="code">{b.code}</span>
                {b.message}
              </div>
            ))
          )}

          <h3>Consumer Verification Evidence</h3>
          {proposal.consumers.map((c) => {
            const e = latestByConsumer.get(c.consumerId);
            const fresh = evidenceFreshness[c.consumerId];
            return (
              <div className="consumer-row" key={c.consumerId}>
                <div>
                  <div className="consumer-id">{c.consumerId}</div>
                  <div className="consumer-detail">
                    {e
                      ? `${e.status.toUpperCase()} — ${e.detail}`
                      : "no evidence received"}
                    {e && (
                      <span>
                        {" "}
                        · run {e.agentRunId} · key{" "}
                        {e.idempotencyKey.slice(0, 12)}…
                      </span>
                    )}
                  </div>
                </div>
                <span className={`badge ${e?.status ?? "missing"}`}>
                  {e?.status ?? "missing"}
                </span>
                <span className={`badge ${fresh?.status ?? "missing"}`}>
                  {fresh?.status ?? "missing"}
                </span>
              </div>
            );
          })}

          {appliedExemptions.length > 0 && (
            <div
              style={{
                marginTop: 12,
                padding: 10,
                background: "#2a2410",
                border: "1px solid var(--amber)",
                borderRadius: 6,
                fontSize: 12,
              }}
            >
              <strong>
                {appliedExemptions.length} active exemption(s) applied for
                environment "{environment}":
              </strong>
              <ul style={{ margin: "6px 0 0 18px" }}>
                {appliedExemptions.map((a) => (
                  <li key={a.exemptionId}>
                    {a.consumerId} · {a.direction} · reviewers{" "}
                    {a.reviewers.join(", ")} · expires{" "}
                    {new Date(a.expiresAt).toISOString()}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {tab === "exemptions" && (
        <ExemptionsPanel
          proposalId={proposal.proposalId}
          consumers={proposal.consumers.map((c) => c.consumerId)}
          exemptions={exemptions}
          decided={Boolean(proposal.decision)}
          onChange={onDecision}
        />
      )}

      {tab === "schemas" && (
        <div>
          <div className="detail-grid">
            <div>
              <h3>Compatibility Report</h3>
              <div style={{ marginBottom: 8 }}>
                <span
                  className={`badge ${proposal.compatibility.compatible ? "pass" : "fail"}`}
                >
                  {proposal.compatibility.compatible
                    ? "COMPATIBLE"
                    : "INCOMPATIBLE"}
                </span>
                <span
                  style={{ marginLeft: 8, fontSize: 12, color: "var(--muted)" }}
                >
                  {proposal.compatibility.violations.length} violation(s)
                </span>
              </div>
              {proposal.compatibility.violations.map((v, i) => (
                <div className="blocker" key={i}>
                  <span className="code">{v.kind}</span>
                  {v.message} <code>{v.path}</code>
                </div>
              ))}
            </div>
            <div>
              <h3>Stable Digests (SHA-256)</h3>
              <div className="digests">
                <div>baseline: {proposal.baselineDigest}</div>
                <div>candidate: {proposal.candidateDigest}</div>
              </div>
            </div>
          </div>
          <div className="detail-grid">
            <div>
              <h3>Baseline</h3>
              <pre>{JSON.stringify(proposal.baseline, null, 2)}</pre>
            </div>
            <div>
              <h3>Candidate</h3>
              <pre>{JSON.stringify(proposal.candidate, null, 2)}</pre>
            </div>
          </div>
        </div>
      )}

      {tab === "events" && (
        <div className="scroll">
          {eventLog.map((ev: CausalEvent) => (
            <div className="event-row" key={ev.eventId}>
              <span className="ev-id">#{ev.eventId}</span>
              <span className="ev-type">{ev.eventType}</span>
              <span className="ev-time">
                {new Date(ev.occurredAt).toISOString()}
              </span>
              <div
                style={{
                  color: "var(--muted)",
                  marginTop: 4,
                  wordBreak: "break-all",
                }}
              >
                hash {ev.hash.slice(0, 16)}… · prev {ev.prevHash.slice(0, 12)}…
              </div>
              <pre style={{ maxHeight: 120, marginTop: 6 }}>
                {JSON.stringify(ev.payload, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      )}

      {tab === "decision" && !proposal.decision && (
        <div>
          <p style={{ color: "var(--muted)", fontSize: 13 }}>
            A decision can only target this{" "}
            <strong>exact candidate digest</strong>. The immutable snapshot
            captures the evidence set, compatibility report and last event id at
            the moment of decision. Late evidence arriving afterward cannot
            alter this conclusion.
          </p>
          <div className="form-row">
            <div className="field">
              <label>Decider</label>
              <input
                value={decider}
                onChange={(e) => setDecider(e.target.value)}
              />
            </div>
            <div className="field">
              <label>Rationale</label>
              <input
                value={rationale}
                onChange={(e) => setRationale(e.target.value)}
                placeholder="why this decision?"
              />
            </div>
          </div>
          {error && (
            <div className="blocker">
              <span className="code">ERROR</span>
              {error}
            </div>
          )}
          <div className="actions">
            <button
              disabled={busy || blockers.length > 0}
              onClick={() => void decide("approve")}
            >
              Approve Exact Candidate
            </button>
            <button
              className="reject"
              disabled={busy}
              onClick={() => void decide("reject")}
            >
              Reject
            </button>
          </div>
          {blockers.length > 0 && (
            <div style={{ marginTop: 12, fontSize: 12, color: "var(--amber)" }}>
              Approve is disabled until all blockers clear. Reject is always
              available.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LineageBanner({
  proposal,
  onNavigate,
  onCreated,
  onChange,
}: {
  proposal: StoredProposal;
  onNavigate: (id: string) => void;
  onCreated: () => void;
  onChange: () => void;
}): React.ReactElement {
  const { lineage } = proposal;
  const [showForm, setShowForm] = useState(false);
  const [author, setAuthor] = useState(proposal.author);
  const [note, setNote] = useState("");
  const [candidate, setCandidate] = useState(
    JSON.stringify(proposal.candidate, null, 2),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const isSuperseded = proposal.status === "superseded";
  const isClosed =
    proposal.status === "approved" ||
    proposal.status === "rejected" ||
    isSuperseded;

  async function createSuccessor(): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const { successor } = await api.createSuccessor(proposal.proposalId, {
        candidate: parsed,
        author,
        note: note || undefined,
      });
      setShowForm(false);
      onCreated();
      onChange();
      onNavigate(successor.proposalId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="panel"
      style={{
        background: isSuperseded ? "#2a1a10" : "var(--panel-2)",
        border: `1px solid ${isSuperseded ? "var(--amber)" : "var(--border)"}`,
        margin: "12px 0",
        padding: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        {lineage.predecessorId && (
          <button
            className="secondary"
            onClick={() => onNavigate(lineage.predecessorId!)}
          >
            ← predecessor {lineage.predecessorId.slice(0, 18)}…
          </button>
        )}
        <strong>Lineage</strong>
        {lineage.successorId ? (
          <button
            className="secondary"
            onClick={() => onNavigate(lineage.successorId!)}
          >
            successor {lineage.successorId.slice(0, 18)}… →
          </button>
        ) : isClosed ? (
          <span style={{ color: "var(--muted)", fontSize: 12 }}>
            {isSuperseded
              ? `superseded${lineage.supersededBy ? ` by ${lineage.supersededBy}` : ""} — closed, no further successor can be created`
              : "closed proposal"}
          </span>
        ) : (
          <button className="secondary" onClick={() => setShowForm((v) => !v)}>
            {showForm ? "Cancel" : "Create successor from revised candidate"}
          </button>
        )}
      </div>

      {isSuperseded && (
        <div style={{ marginTop: 8, fontSize: 12, color: "var(--amber)" }}>
          This proposal is superseded and closed. Late verification results
          that arrive here are recorded as <code>proposal-superseded</code> on
          this proposal and cannot release the successor. The successor starts
          with a fresh candidate digest and carries over no evidence or
          exemptions.
          {lineage.note && (
            <div style={{ marginTop: 4, color: "var(--muted)" }}>
              note: {lineage.note}
            </div>
          )}
        </div>
      )}

      {showForm && !isClosed && (
        <div style={{ marginTop: 12 }}>
          <p style={{ color: "var(--muted)", fontSize: 12, marginTop: 0 }}>
            A successor recomputes the candidate digest from the revised schema.
            Existing evidence and exemptions stay with this proposal (their
            exact scope) and are <strong>not</strong> inherited — even if the
            consumer names match.
          </p>
          <div className="form-row">
            <div className="field">
              <label>Author</label>
              <input
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
              />
            </div>
            <div className="field">
              <label>Note (optional)</label>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="why a revised candidate?"
              />
            </div>
          </div>
          <div className="field">
            <label>Revised candidate JSON Schema (2020-12)</label>
            <textarea
              rows={10}
              value={candidate}
              onChange={(e) => setCandidate(e.target.value)}
            />
          </div>
          {error && (
            <div className="blocker">
              <span className="code">ERROR</span>
              {error}
            </div>
          )}
          <div className="actions">
            <button disabled={busy} onClick={() => void createSuccessor()}>
              {busy ? "Creating…" : "Create successor & supersede this proposal"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ExemptionsPanel({
  proposalId,
  consumers,
  exemptions,
  decided,
  onChange,
}: {
  proposalId: string;
  consumers: string[];
  exemptions: ExemptionRecord[];
  decided: boolean;
  onChange: () => void;
}): React.ReactElement {
  const [consumerId, setConsumerId] = useState(consumers[0] ?? "");
  const [environment, setEnvironment] = useState("prod");
  const [direction, setDirection] = useState<"backward" | "forward" | "both">(
    "backward",
  );
  const [reason, setReason] = useState(
    "consumer temporarily offline during release window",
  );
  const [requestedBy, setRequestedBy] = useState("alice");
  const [ttlMs, setTtlMs] = useState(3600000);
  const [reviewer, setReviewer] = useState("bob");
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function guard(fn: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError("");
    try {
      await fn();
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p style={{ color: "var(--muted)", fontSize: 13 }}>
        A time-boxed exemption covers one <strong>exact candidate</strong>, one
        consumer, one environment and one compatibility direction. It becomes
        active only after <strong>two different reviewers</strong> (neither
        being the requester) approve it. It stops counting once expired or
        revoked. It never alters the candidate digest, and previously recorded
        decision snapshots remain unchanged.
      </p>

      {!decided && (
        <div
          className="panel"
          style={{ background: "var(--panel-2)", marginBottom: 16 }}
        >
          <h3 style={{ marginTop: 0 }}>Request exemption</h3>
          <div className="form-row">
            <div className="field">
              <label>Consumer</label>
              <select
                value={consumerId}
                onChange={(e) => setConsumerId(e.target.value)}
              >
                {consumers.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Environment</label>
              <input
                value={environment}
                onChange={(e) => setEnvironment(e.target.value)}
              />
            </div>
          </div>
          <div className="form-row">
            <div className="field">
              <label>Compatibility direction</label>
              <select
                value={direction}
                onChange={(e) =>
                  setDirection(
                    e.target.value as "backward" | "forward" | "both",
                  )
                }
              >
                <option value="backward">backward</option>
                <option value="forward">forward</option>
                <option value="both">both</option>
              </select>
            </div>
            <div className="field">
              <label>Requested by</label>
              <input
                value={requestedBy}
                onChange={(e) => setRequestedBy(e.target.value)}
              />
            </div>
          </div>
          <div className="form-row">
            <div className="field">
              <label>Reason</label>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            <div className="field">
              <label>TTL (ms)</label>
              <input
                type="number"
                value={ttlMs}
                onChange={(e) => setTtlMs(Number(e.target.value))}
              />
            </div>
          </div>
          <button
            disabled={busy}
            onClick={() =>
              void guard(async () => {
                await api.requestExemption(proposalId, {
                  consumerId,
                  environment,
                  direction,
                  reason,
                  requestedBy,
                  ttlMs,
                });
              })
            }
          >
            Submit request
          </button>
        </div>
      )}

      <h3>Exemptions ({exemptions.length})</h3>
      {exemptions.length === 0 && (
        <div className="empty">No exemptions requested.</div>
      )}
      {exemptions.map((x) => {
        const approvals = x.reviews.filter((r) => r.approved);
        const isActive = x.status === "approved";
        return (
          <div
            key={x.exemptionId}
            className="panel"
            style={{ background: "var(--panel-2)", marginBottom: 10 }}
          >
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <div>
                <strong>{x.consumerId}</strong> · {x.environment} ·{" "}
                <span className="badge">{x.direction}</span>{" "}
                <span
                  className={`badge ${isActive ? "pass" : x.status === "rejected" ? "fail" : x.status === "pending" ? "stale" : "missing"}`}
                >
                  {x.status}
                </span>
              </div>
              <div className="consumer-detail">
                expires {new Date(x.expiresAt).toISOString()}
              </div>
            </div>
            <div className="consumer-detail" style={{ marginTop: 6 }}>
              candidate {x.candidateDigest.slice(0, 16)}… · requested by{" "}
              {x.requestedBy} · {x.reason}
            </div>
            <div className="consumer-detail" style={{ marginTop: 4 }}>
              approvals {approvals.length}/2:{" "}
              {approvals.map((r) => r.reviewer).join(", ") || "none"}
              {x.reviews
                .filter((r) => !r.approved)
                .map((r) => ` · rejected by ${r.reviewer}: ${r.comment}`)
                .join("")}
            </div>
            {!decided && x.status === "pending" && (
              <div style={{ marginTop: 10 }}>
                <div className="form-row">
                  <div className="field">
                    <label>Reviewer</label>
                    <input
                      value={reviewer}
                      onChange={(e) => setReviewer(e.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label>Comment</label>
                    <input
                      value={comment}
                      onChange={(e) => setComment(e.target.value)}
                    />
                  </div>
                </div>
                <div className="actions">
                  <button
                    disabled={busy}
                    onClick={() =>
                      void guard(async () => {
                        await api.reviewExemption(proposalId, x.exemptionId, {
                          reviewer,
                          approved: true,
                          comment,
                        });
                      })
                    }
                  >
                    Approve
                  </button>
                  <button
                    className="reject"
                    disabled={busy}
                    onClick={() =>
                      void guard(async () => {
                        await api.reviewExemption(proposalId, x.exemptionId, {
                          reviewer,
                          approved: false,
                          comment,
                        });
                      })
                    }
                  >
                    Reject
                  </button>
                </div>
              </div>
            )}
            {!decided &&
              (x.status === "approved" || x.status === "pending") && (
                <div className="actions">
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void guard(async () => {
                        await api.revokeExemption(
                          proposalId,
                          x.exemptionId,
                          reviewer,
                        );
                      })
                    }
                  >
                    Revoke
                  </button>
                </div>
              )}
          </div>
        );
      })}

      {error && (
        <div className="blocker" style={{ marginTop: 12 }}>
          <span className="code">ERROR</span>
          {error}
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
