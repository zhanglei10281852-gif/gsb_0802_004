import { createHash } from 'node:crypto';

/**
 * 规范化序列化：对象键递归排序，数组保持顺序。
 * 同一份 JSON Schema 无论键顺序如何都会得到相同的规范化文本。
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      out[key] = sortValue(src[key]);
    }
    return out;
  }
  return value;
}

/** 稳定的候选摘要：对规范化文本取 SHA-256。 */
export function stableDigest(value: unknown): string {
  return 'sha256:' + createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}

/** 深度相等（基于规范化文本）。 */
export function deepEqual(a: unknown, b: unknown): boolean {
  return canonicalize(a) === canonicalize(b);
}
