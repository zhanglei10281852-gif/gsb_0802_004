import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCompatibility, validateSchema } from './compatibility.js';
import { ManualClock } from './clock.js';
import { ValidationError } from './errors.js';

const clock = new ManualClock(1000);

function schema(props: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: props,
    required,
    additionalProperties: true,
  };
}

test('identical schemas are compatible', () => {
  const s = schema({ id: { type: 'string' } }, ['id']);
  const r = checkCompatibility(s, s, clock);
  assert.equal(r.compatible, true);
  assert.deepEqual(r.violations, []);
});

test('adding an optional property is compatible', () => {
  const base = schema({ id: { type: 'string' } }, ['id']);
  const cand = schema({ id: { type: 'string' }, note: { type: 'string' } }, ['id']);
  const r = checkCompatibility(base, cand, clock);
  assert.equal(r.compatible, true);
});

test('removing a required property is incompatible', () => {
  const base = schema({ id: { type: 'string' } }, ['id']);
  const cand = schema({}, []);
  const r = checkCompatibility(base, cand, clock);
  assert.equal(r.compatible, false);
  assert.ok(r.violations.some((v) => v.kind === 'required-property-removed'));
});

test('adding a required property is incompatible', () => {
  const base = schema({ id: { type: 'string' } }, ['id']);
  const cand = schema({ id: { type: 'string' }, newReq: { type: 'string' } }, ['id', 'newReq']);
  const r = checkCompatibility(base, cand, clock);
  assert.equal(r.compatible, false);
  assert.ok(r.violations.some((v) => v.kind === 'property-added-required'));
});

test('narrowing an enum is incompatible', () => {
  const base = schema({ c: { type: 'string', enum: ['USD', 'EUR', 'GBP'] } });
  const cand = schema({ c: { type: 'string', enum: ['USD', 'EUR'] } });
  const r = checkCompatibility(base, cand, clock);
  assert.ok(r.violations.some((v) => v.kind === 'enum-narrowed'));
});

test('raising minimum is incompatible', () => {
  const base = schema({ amt: { type: 'number', minimum: 0 } });
  const cand = schema({ amt: { type: 'number', minimum: 10 } });
  const r = checkCompatibility(base, cand, clock);
  assert.ok(r.violations.some((v) => v.kind === 'minimum-raised'));
});

test('rejecting additional properties is incompatible', () => {
  const base = schema({ id: { type: 'string' } });
  base.additionalProperties = true;
  const cand = schema({ id: { type: 'string' } });
  cand.additionalProperties = false;
  const r = checkCompatibility(base, cand, clock);
  assert.ok(r.violations.some((v) => v.kind === 'additional-properties-restricted'));
});

test('validateSchema throws on invalid schema', () => {
  assert.throws(() => validateSchema({ type: 'not-a-real-type' } as never), ValidationError);
});

test('report carries stable digests', () => {
  const base = schema({ id: { type: 'string' } });
  const cand = schema({ id: { type: 'string' } });
  const r = checkCompatibility(base, cand, clock);
  assert.equal(r.baselineDigest.length, 64);
  assert.equal(r.candidateDigest.length, 64);
});
