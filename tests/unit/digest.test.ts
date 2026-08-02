import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, candidateDigest } from '../../src/domain/digest.ts';

test('canonicalize is independent of key order', () => {
  const a = { b: 1, a: 2, nested: { y: 1, x: 2 } };
  const b = { a: 2, nested: { x: 2, y: 1 }, b: 1 };
  assert.equal(canonicalize(a), canonicalize(b));
});

test('canonicalize is independent of whitespace/formatting', () => {
  const parsed = JSON.parse('{ "a" :\n 1,  "b":[1,2,3] }');
  assert.equal(canonicalize(parsed), '{"a":1,"b":[1,2,3]}');
});

test('candidateDigest is stable and prefixed', () => {
  const d1 = candidateDigest({ type: 'object', required: ['a', 'b'] });
  const d2 = candidateDigest({ required: ['a', 'b'], type: 'object' });
  assert.equal(d1, d2);
  assert.match(d1, /^sha256:[0-9a-f]{64}$/);
});

test('array order is significant', () => {
  assert.notEqual(canonicalize([1, 2, 3]), canonicalize([3, 2, 1]));
});

test('different content yields different digest', () => {
  assert.notEqual(candidateDigest({ a: 1 }), candidateDigest({ a: 2 }));
});

test('non-finite numbers are rejected', () => {
  assert.throws(() => canonicalize({ x: Infinity }));
});
