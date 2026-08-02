import { describe, expect, it } from 'vitest';
import { stableDigest } from '../src/core/canonical.js';
import { checkCompatibility } from '../src/core/compat.js';

const baseline = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['orderId', 'amount'],
  properties: {
    orderId: { type: 'string', minLength: 1 },
    amount: { type: 'number', minimum: 0 },
    channel: { type: 'string', enum: ['a', 'b', 'c'] },
  },
  additionalProperties: false,
};

describe('stableDigest', () => {
  it('键顺序不影响摘要', () => {
    const a = { type: 'object', required: ['x'], properties: { x: { type: 'string' } } };
    const b = { properties: { x: { type: 'string' } }, required: ['x'], type: 'object' };
    expect(stableDigest(a)).toBe(stableDigest(b));
    expect(stableDigest(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('checkCompatibility', () => {
  it('完全相同的契约兼容且无发现', () => {
    const r = checkCompatibility(baseline, structuredClone(baseline));
    expect(r.status).toBe('compatible');
    expect(r.findings).toHaveLength(0);
  });

  it('收窄是兼容的：枚举子集、提高 minLength、新增必填字段、收紧数值上界', () => {
    const candidate = {
      type: 'object',
      required: ['orderId', 'amount', 'channel'],
      properties: {
        orderId: { type: 'string', minLength: 5 },
        amount: { type: 'number', minimum: 1, maximum: 100 },
        channel: { type: 'string', enum: ['a', 'b'] },
      },
      additionalProperties: false,
    };
    const r = checkCompatibility(baseline, candidate);
    expect(r.status).toBe('compatible');
  });

  it('删除必填字段是破坏性的', () => {
    const candidate = {
      type: 'object',
      required: ['orderId'],
      properties: baseline.properties,
      additionalProperties: false,
    };
    const r = checkCompatibility(baseline, candidate);
    expect(r.status).toBe('breaking');
    expect(r.findings.some((f) => f.rule === 'required.dropped')).toBe(true);
  });

  it('类型扩宽是破坏性的', () => {
    const candidate = structuredClone(baseline) as Record<string, any>;
    candidate.properties.amount = { type: ['number', 'string'] };
    const r = checkCompatibility(baseline, candidate);
    expect(r.status).toBe('breaking');
    expect(r.findings.some((f) => f.rule === 'type.widened')).toBe(true);
  });

  it('基线禁止额外字段时新增字段是破坏性的', () => {
    const candidate = structuredClone(baseline) as Record<string, any>;
    candidate.properties.extra = { type: 'string' };
    const r = checkCompatibility(baseline, candidate);
    expect(r.status).toBe('breaking');
    expect(r.findings.some((f) => f.rule === 'additionalProperties.widened')).toBe(true);
  });

  it('移除枚举约束是破坏性的', () => {
    const candidate = structuredClone(baseline) as Record<string, any>;
    candidate.properties.channel = { type: 'string' };
    const r = checkCompatibility(baseline, candidate);
    expect(r.findings.some((f) => f.rule === 'enum.removed')).toBe(true);
  });

  it('嵌套属性递归检查', () => {
    const b = { type: 'object', properties: { nested: { type: 'object', properties: { v: { type: 'integer', maximum: 10 } } } } };
    const c = { type: 'object', properties: { nested: { type: 'object', properties: { v: { type: 'integer' } } } } };
    const r = checkCompatibility(b, c);
    expect(r.status).toBe('breaking');
    expect(r.findings.some((f) => f.path.includes('nested'))).toBe(true);
  });

  it('无法判定的构造产生非破坏性复核发现而不是静默通过', () => {
    const b = { oneOf: [{ type: 'string' }, { type: 'number' }] };
    const c = { oneOf: [{ type: 'string' }] };
    const r = checkCompatibility(b, c);
    expect(r.status).toBe('compatible');
    expect(r.findings.some((f) => f.rule.startsWith('unsupported.') && !f.breaking)).toBe(true);
  });

  it('pattern 移除是破坏性的，pattern 变更需人工复核', () => {
    const b = { type: 'string', pattern: '^a+$' };
    expect(checkCompatibility(b, { type: 'string' }).findings.some((f) => f.rule === 'pattern.removed')).toBe(true);
    const r = checkCompatibility(b, { type: 'string', pattern: '^a{2,}$' });
    expect(r.status).toBe('compatible');
    expect(r.findings.some((f) => f.rule === 'pattern.unknown' && !f.breaking)).toBe(true);
  });
});
