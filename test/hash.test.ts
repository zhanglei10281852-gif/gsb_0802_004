import { describe, it, expect } from 'vitest';
import { canonicalize, stableHash } from '../src/domain/hash.js';

describe('canonical hashing', () => {
  it('produces identical hashes regardless of key order', () => {
    const a = { b: 1, a: 2, c: { z: 9, y: 8 } };
    const b = { a: 2, b: 1, c: { y: 8, z: 9 } };
    expect(stableHash(a)).toBe(stableHash(b));
  });

  it('produces different hashes for different values', () => {
    expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }));
  });

  it('canonicalizes nested arrays', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('is deterministic across calls', () => {
    const v = { x: [1, 2, { y: 'z' }] };
    expect(stableHash(v)).toBe(stableHash(v));
  });
});
