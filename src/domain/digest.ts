import { createHash } from 'node:crypto';

/**
 * Canonical JSON serialization + stable candidate digest.
 *
 * A candidate's identity must be a function of its *meaning*, not its byte
 * layout. Two submissions of the same schema with reordered keys or different
 * whitespace must yield the same digest, otherwise decision makers could be
 * asked to re-approve something they already approved, and evidence keyed by
 * digest would fail to match. We therefore canonicalize before hashing:
 *
 *  - object keys are sorted lexicographically (by UTF-16 code unit, the JS
 *    default) at every level;
 *  - arrays keep their order (order is semantically significant in JSON);
 *  - no insignificant whitespace is emitted;
 *  - numbers are serialized via JSON's own rules (so 1 and 1.0 both become
 *    "1"), and non-finite numbers are rejected as they are not valid JSON.
 *
 * The digest is a SHA-256 over the canonical form, prefixed with the algorithm
 * so the format can evolve later without ambiguity.
 */
export function canonicalize(value: unknown): string {
  return encode(value);
}

function encode(value: unknown): string {
  if (value === null) return 'null';

  const t = typeof value;
  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new Error(`non-finite numbers are not valid JSON: ${String(value)}`);
    }
    return JSON.stringify(value);
  }
  if (t === 'boolean' || t === 'string') {
    return JSON.stringify(value);
  }
  if (t === 'undefined' || t === 'function') {
    throw new Error(`value of type ${t} cannot be canonicalized`);
  }

  if (Array.isArray(value)) {
    return `[${value.map((v) => encode(v)).join(',')}]`;
  }

  // Plain object: sort keys, skip explicit `undefined` members (mirrors JSON).
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const members = keys.map((k) => `${JSON.stringify(k)}:${encode(obj[k])}`);
  return `{${members.join(',')}}`;
}

/**
 * Compute the stable digest for a candidate schema.
 * Returns a value like "sha256:ab12...".
 */
export function candidateDigest(schema: unknown): string {
  const canonical = canonicalize(schema);
  const hash = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return `sha256:${hash}`;
}
