import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, digest } from './digest.js';

test('canonicalize sorts object keys recursively', () => {
  const a = canonicalize({ b: 1, a: { z: 2, y: [3, 1] } });
  const b = canonicalize({ a: { y: [3, 1], z: 2 }, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":{"y":[3,1],"z":2},"b":1}');
});

test('digest is stable regardless of key order', () => {
  const d1 = digest({ a: 1, b: 2 });
  const d2 = digest({ b: 2, a: 1 });
  assert.equal(d1, d2);
  assert.match(d1, /^[0-9a-f]{64}$/);
});

test('digest differs for different content', () => {
  assert.notEqual(digest({ a: 1 }), digest({ a: 2 }));
});
