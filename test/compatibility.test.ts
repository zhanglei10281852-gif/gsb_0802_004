import { describe, it, expect } from 'vitest';
import { checkBackwardCompatibility, validateSchema } from '../src/domain/compatibility.js';

describe('JSON Schema 2020-12 compatibility', () => {
  it('accepts a valid 2020-12 schema', () => {
    const r = validateSchema({ type: 'object', properties: { a: { type: 'string' } } });
    expect(r.compatible).toBe(true);
  });

  it('rejects an invalid schema', () => {
    const r = validateSchema({ type: 'not-a-type' });
    expect(r.compatible).toBe(false);
    expect(r.issues.length).toBeGreaterThan(0);
  });

  it('treats adding an optional property as compatible', () => {
    const base = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
    const cand = {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a'],
    };
    const r = checkBackwardCompatibility(base, cand);
    expect(r.compatible).toBe(true);
  });

  it('flags adding a required property as breaking', () => {
    const base = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
    const cand = {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a', 'b'],
    };
    const r = checkBackwardCompatibility(base, cand);
    expect(r.compatible).toBe(false);
    expect(r.issues.some((i) => i.code === 'required-added')).toBe(true);
  });

  it('flags removing a property with additionalProperties false', () => {
    const base = {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      additionalProperties: false,
    };
    const cand = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false };
    const r = checkBackwardCompatibility(base, cand);
    expect(r.compatible).toBe(false);
    expect(r.issues.some((i) => i.code === 'property-removed')).toBe(true);
  });

  it('flags raising a minimum as breaking', () => {
    const base = { type: 'number', minimum: 0 };
    const cand = { type: 'number', minimum: 10 };
    const r = checkBackwardCompatibility(base, cand);
    expect(r.compatible).toBe(false);
    expect(r.issues.some((i) => i.code === 'minimum-raised')).toBe(true);
  });

  it('treats lowering a minimum as compatible', () => {
    const base = { type: 'number', minimum: 10 };
    const cand = { type: 'number', minimum: 0 };
    const r = checkBackwardCompatibility(base, cand);
    expect(r.compatible).toBe(true);
  });

  it('flags removing an enum value as breaking', () => {
    const base = { type: 'string', enum: ['a', 'b', 'c'] };
    const cand = { type: 'string', enum: ['a', 'b'] };
    const r = checkBackwardCompatibility(base, cand);
    expect(r.compatible).toBe(false);
    expect(r.issues.some((i) => i.code === 'enum-value-removed')).toBe(true);
  });

  it('treats adding an enum value as compatible', () => {
    const base = { type: 'string', enum: ['a'] };
    const cand = { type: 'string', enum: ['a', 'b'] };
    const r = checkBackwardCompatibility(base, cand);
    expect(r.compatible).toBe(true);
  });

  it('flags narrowing a type union as breaking', () => {
    const base = { type: ['string', 'number'] };
    const cand = { type: 'string' };
    const r = checkBackwardCompatibility(base, cand);
    expect(r.compatible).toBe(false);
    expect(r.issues.some((i) => i.code === 'type-narrowed')).toBe(true);
  });
});
