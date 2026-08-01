import { useState } from 'react';
import { api, type Consumer } from '../api';

const SAMPLE_BASELINE = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    orderId: { type: 'string' },
    amount: { type: 'number', minimum: 0 },
  },
  required: ['orderId'],
};

const SAMPLE_CANDIDATE = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    orderId: { type: 'string' },
    amount: { type: 'number', minimum: 0 },
    note: { type: 'string' },
  },
  required: ['orderId'],
};

export function Composer({ consumers, onCreated }: { consumers: Consumer[]; onCreated: () => void }) {
  const [consumerId, setConsumerId] = useState('');
  const [consumerName, setConsumerName] = useState('');
  const [baseline, setBaseline] = useState(JSON.stringify(SAMPLE_BASELINE, null, 2));
  const [candidate, setCandidate] = useState(JSON.stringify(SAMPLE_CANDIDATE, null, 2));
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const registerConsumer = async () => {
    if (!consumerId || !consumerName) return;
    setBusy(true);
    try {
      await api.registerConsumer(consumerId, consumerName);
      setMsg(`registered ${consumerId}`);
      setConsumerId('');
      setConsumerName('');
      onCreated();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submitProposal = async () => {
    setBusy(true);
    try {
      const baselineSchema = JSON.parse(baseline);
      const candidateSchema = JSON.parse(candidate);
      const res = await api.createProposal(candidateSchema, baselineSchema);
      setMsg(res.duplicate ? 'proposal already exists (duplicate hash)' : 'proposal created');
      onCreated();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ padding: 12 }}>
      <p className="section-title">Register Consumer</p>
      <label>
        <span>Consumer ID</span>
        <input value={consumerId} onChange={(e) => setConsumerId(e.target.value)} placeholder="billing-service" />
      </label>
      <label>
        <span>Name</span>
        <input value={consumerName} onChange={(e) => setConsumerName(e.target.value)} placeholder="Billing Service" />
      </label>
      <button onClick={registerConsumer} disabled={busy}>
        Register
      </button>

      <p className="section-title mt16">Submit Proposal</p>
      <label>
        <span>Baseline Schema</span>
        <textarea rows={6} value={baseline} onChange={(e) => setBaseline(e.target.value)} />
      </label>
      <label>
        <span>Candidate Schema</span>
        <textarea rows={6} value={candidate} onChange={(e) => setCandidate(e.target.value)} />
      </label>
      <button onClick={submitProposal} disabled={busy || consumers.length === 0}>
        Submit Proposal
      </button>
      {consumers.length === 0 && (
        <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
          Register at least one consumer first.
        </div>
      )}
      {msg && <div className="mt8 muted" style={{ fontSize: 12 }}>{msg}</div>}
    </div>
  );
}
