import { useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, createProposal } from '../api';
import type { ProposalDetail } from '../api';

interface CreateProposalFormProps {
  onCreated: (created: ProposalDetail) => void;
}

export function CreateProposalForm({ onCreated }: CreateProposalFormProps) {
  const [title, setTitle] = useState('');
  const [consumersText, setConsumersText] = useState('');
  const [ttlText, setTtlText] = useState('');
  const [baselineText, setBaselineText] = useState('');
  const [candidateText, setCandidateText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (title.trim() === '') {
      setError('请填写提案标题。');
      return;
    }
    let baseline: unknown;
    try {
      baseline = JSON.parse(baselineText);
    } catch {
      setError('基线 JSON 非法，请检查后再提交。');
      return;
    }
    let candidate: unknown;
    try {
      candidate = JSON.parse(candidateText);
    } catch {
      setError('候选 JSON 非法，请检查后再提交。');
      return;
    }
    const consumers = consumersText
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    let evidenceTtlMs: number | undefined;
    if (ttlText.trim() !== '') {
      const parsed = Number(ttlText.trim());
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setError('证据 TTL 需为正数毫秒，或留空使用默认值。');
        return;
      }
      evidenceTtlMs = parsed;
    }

    setBusy(true);
    try {
      const created = await createProposal({
        title: title.trim(),
        baseline,
        candidate,
        consumers,
        evidenceTtlMs,
      });
      setTitle('');
      setConsumersText('');
      setTtlText('');
      setBaselineText('');
      setCandidateText('');
      onCreated(created);
    } catch (err) {
      setError(err instanceof ApiError && err.errorMessage ? err.errorMessage : '创建提案失败，请稍后重试。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        void handleSubmit(e);
      }}
    >
      <label className="field">
        <span className="field-label">标题</span>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="例如：订单契约增加 discount 字段"
        />
      </label>
      <label className="field">
        <span className="field-label">消费方（逗号分隔）</span>
        <input
          type="text"
          value={consumersText}
          onChange={(e) => setConsumersText(e.target.value)}
          placeholder="例如：order-service, billing-service"
        />
      </label>
      <label className="field">
        <span className="field-label">证据 TTL（毫秒，可空）</span>
        <input
          type="number"
          min="1"
          value={ttlText}
          onChange={(e) => setTtlText(e.target.value)}
          placeholder="留空使用服务器默认值"
        />
      </label>
      <label className="field">
        <span className="field-label">基线 JSON</span>
        <textarea
          rows={6}
          value={baselineText}
          onChange={(e) => setBaselineText(e.target.value)}
          placeholder='{"type":"object","properties":{}}'
        />
      </label>
      <label className="field">
        <span className="field-label">候选 JSON</span>
        <textarea
          rows={6}
          value={candidateText}
          onChange={(e) => setCandidateText(e.target.value)}
          placeholder='{"type":"object","properties":{}}'
        />
      </label>
      {error && <div className="alert alert-error">{error}</div>}
      <div className="button-row">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? '提交中…' : '创建提案'}
        </button>
      </div>
    </form>
  );
}
