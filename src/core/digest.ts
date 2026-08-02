import { createHash } from 'node:crypto';

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortDeep);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

export function digest(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

export function digestString(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export function shortDigest(value: unknown): string {
  return digest(value).slice(0, 12);
}
