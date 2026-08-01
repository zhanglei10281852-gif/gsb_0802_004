import { createHash } from 'node:crypto';

export function canonicalize(value: unknown): string {
  return JSON.stringify(cloneAndSort(value));
}

function cloneAndSort(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(cloneAndSort);
  }
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = cloneAndSort(obj[key]);
  }
  return sorted;
}

export function stableHash(value: unknown): string {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}
