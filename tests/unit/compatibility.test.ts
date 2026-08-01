import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCompatibility } from '../../src/domain/compatibility.ts';

const base = {
  type: 'object',
  properties: { id: { type: 'string' }, amount: { type: 'number' } },
  required: ['id']
};

test('adding an optional property is COMPATIBLE', () => {
  const cand = {
    type: 'object',
    properties: { id: { type: 'string' }, amount: { type: 'number' }, currency: { type: 'string' } },
    required: ['id']
  };
  assert.equal(analyzeCompatibility(base, cand).result, 'COMPATIBLE');
});

test('newly requiring a property is BREAKING', () => {
  const cand = { ...base, required: ['id', 'amount'] };
  const r = analyzeCompatibility(base, cand);
  assert.equal(r.result, 'BREAKING');
  assert.ok(r.changes.some((c) => c.kind === 'BREAKING' && c.path.includes('amount')));
});

test('narrowing type is BREAKING', () => {
  const b = { properties: { x: { type: ['string', 'number'] } } };
  const c = { properties: { x: { type: 'string' } } };
  assert.equal(analyzeCompatibility(b, c).result, 'BREAKING');
});

test('integer accepted where number required is compatible (widening)', () => {
  const b = { properties: { x: { type: 'integer' } } };
  const c = { properties: { x: { type: 'number' } } };
  assert.equal(analyzeCompatibility(b, c).result, 'COMPATIBLE');
});

test('closing additionalProperties is BREAKING', () => {
  const b = { type: 'object', properties: { id: { type: 'string' } } };
  const c = { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false };
  assert.equal(analyzeCompatibility(b, c).result, 'BREAKING');
});

test('tightening a numeric bound is BREAKING', () => {
  const b = { properties: { n: { type: 'number', minimum: 0 } } };
  const c = { properties: { n: { type: 'number', minimum: 5 } } };
  assert.equal(analyzeCompatibility(b, c).result, 'BREAKING');
});

test('relaxing a numeric bound is COMPATIBLE', () => {
  const b = { properties: { n: { type: 'number', minimum: 5 } } };
  const c = { properties: { n: { type: 'number', minimum: 0 } } };
  assert.equal(analyzeCompatibility(b, c).result, 'COMPATIBLE');
});

test('removing an enum value is BREAKING', () => {
  const b = { properties: { s: { enum: ['a', 'b', 'c'] } } };
  const c = { properties: { s: { enum: ['a', 'b'] } } };
  assert.equal(analyzeCompatibility(b, c).result, 'BREAKING');
});

test('adding an enum value is COMPATIBLE', () => {
  const b = { properties: { s: { enum: ['a', 'b'] } } };
  const c = { properties: { s: { enum: ['a', 'b', 'c'] } } };
  assert.equal(analyzeCompatibility(b, c).result, 'COMPATIBLE');
});

test('combinators downgrade to UNKNOWN', () => {
  const b = { type: 'object', properties: { id: { type: 'string' } } };
  const c = { allOf: [{ type: 'object' }], properties: { id: { type: 'string' } } };
  assert.equal(analyzeCompatibility(b, c).result, 'UNKNOWN');
});

test('adding a required field on a nested property is BREAKING', () => {
  const b = { properties: { addr: { type: 'object', properties: { city: { type: 'string' } } } } };
  const c = { properties: { addr: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } };
  assert.equal(analyzeCompatibility(b, c).result, 'BREAKING');
});

test('identical schema is COMPATIBLE with no changes', () => {
  const r = analyzeCompatibility(base, structuredClone(base));
  assert.equal(r.result, 'COMPATIBLE');
});
