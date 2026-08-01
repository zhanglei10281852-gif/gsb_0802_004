import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LogicalClock } from '../../src/domain/clock.ts';

test('logical clock returns same value until advanced', () => {
  const c = new LogicalClock(100);
  assert.equal(c.now(), 100);
  assert.equal(c.now(), 100);
  c.advance(50);
  assert.equal(c.now(), 150);
});

test('logical clock refuses to move backwards', () => {
  const c = new LogicalClock(100);
  assert.throws(() => c.set(50));
  assert.throws(() => c.advance(-1));
});
