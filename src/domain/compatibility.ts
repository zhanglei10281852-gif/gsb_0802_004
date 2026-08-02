import type { CompatChange, CompatReport, CompatResult, JsonSchema } from './types.js';

/**
 * Structural JSON Schema 2020-12 compatibility analyzer.
 *
 * Direction of the question: "if I deploy the candidate schema, will data that
 * was valid under the baseline still be valid?" In event-driven systems a
 * producer change is safe when the candidate still accepts everything the
 * baseline accepted (the accepted-value set only grows). So:
 *
 *   COMPATIBLE  candidate accepts a superset of baseline-valid data
 *   BREAKING    candidate rejects some baseline-valid data
 *   UNKNOWN     the schema uses combinators/refs the analyzer will not
 *               guess about; compatibility must come from consumer evidence
 *
 * This engine is intentionally conservative: anything it cannot prove SAFE is
 * surfaced honestly as BREAKING or UNKNOWN rather than being waved through.
 * That is the whole point of the control center — static analysis narrows the
 * risk, consumer evidence closes it.
 *
 * The analyzer is pure and total: same inputs -> same report, no IO.
 */

// Keywords that combine subschemas or defer resolution. We do not attempt to
// reason across them structurally; their presence downgrades the local verdict
// to UNKNOWN so a human must lean on evidence.
const UNKNOWN_KEYWORDS = [
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
  '$ref',
  '$dynamicRef',
  'dependentSchemas',
  'patternProperties',
  'unevaluatedProperties',
  'unevaluatedItems'
];

const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null']);

export function analyzeCompatibility(baseline: JsonSchema, candidate: JsonSchema): CompatReport {
  const changes: CompatChange[] = [];
  compareNode(baseline, candidate, '#', changes);

  // Fold per-change verdicts into an overall result. BREAKING dominates
  // UNKNOWN, which dominates COMPATIBLE.
  let result: CompatResult = 'COMPATIBLE';
  for (const c of changes) {
    if (c.kind === 'BREAKING') {
      result = 'BREAKING';
      break;
    }
    if (c.kind === 'UNKNOWN') {
      result = 'UNKNOWN';
    }
  }
  return { result, changes };
}

function compareNode(base: unknown, cand: unknown, path: string, out: CompatChange[]): void {
  // Boolean schemas: `true` accepts everything, `false` accepts nothing.
  const baseBool = typeof base === 'boolean' ? base : undefined;
  const candBool = typeof cand === 'boolean' ? cand : undefined;
  if (baseBool !== undefined || candBool !== undefined) {
    compareBooleanSchema(baseBool, candBool, base, cand, path, out);
    return;
  }

  if (!isObject(base) || !isObject(cand)) {
    // One side is not a schema object we understand.
    out.push({ path, kind: 'UNKNOWN', detail: 'non-object schema node; cannot analyze structurally' });
    return;
  }

  // Any combinator/ref on either side makes local reasoning unsafe.
  for (const kw of UNKNOWN_KEYWORDS) {
    if (kw in base || kw in cand) {
      out.push({ path, kind: 'UNKNOWN', detail: `uses "${kw}"; compatibility must be confirmed by evidence` });
      return;
    }
  }

  compareType(base, cand, path, out);
  compareRequired(base, cand, path, out);
  compareProperties(base, cand, path, out);
  compareAdditionalProperties(base, cand, path, out);
  compareEnumConst(base, cand, path, out);
  compareNumericBounds(base, cand, path, out);
  compareStringBounds(base, cand, path, out);
  compareArrayBounds(base, cand, path, out);
  compareItems(base, cand, path, out);
}

function compareBooleanSchema(
  baseBool: boolean | undefined,
  candBool: boolean | undefined,
  base: unknown,
  cand: unknown,
  path: string,
  out: CompatChange[]
): void {
  // Normalize: a `true` schema accepts all; `false` accepts none; an object
  // schema is treated as "accepts a constrained subset" (not all).
  const baseAcceptsAll = baseBool === true;
  const candAcceptsAll = candBool === true;
  const baseAcceptsNone = baseBool === false;
  const candAcceptsNone = candBool === false;

  if (baseAcceptsNone) {
    // Baseline accepted nothing, so any candidate accepts a superset.
    return;
  }
  if (candAcceptsAll) {
    // Candidate accepts everything -> superset of whatever baseline allowed.
    return;
  }
  if (candAcceptsNone && !baseAcceptsNone) {
    out.push({ path, kind: 'BREAKING', detail: 'candidate rejects all values (false schema) but baseline did not' });
    return;
  }
  if (baseAcceptsAll && candBool === undefined) {
    // Baseline accepted everything; candidate is a constrained object schema.
    out.push({ path, kind: 'BREAKING', detail: 'baseline accepted any value; candidate adds constraints' });
    return;
  }
  // Mixed boolean/object combinations we do not fully model.
  out.push({ path, kind: 'UNKNOWN', detail: 'mixed boolean/object schema; cannot analyze structurally' });
}

function compareType(base: Record<string, unknown>, cand: Record<string, unknown>, path: string, out: CompatChange[]): void {
  const baseTypes = normalizeTypes(base.type);
  const candTypes = normalizeTypes(cand.type);

  if (baseTypes === undefined && candTypes === undefined) return;

  // Baseline had no type restriction but candidate does -> narrowing.
  if (baseTypes === undefined && candTypes !== undefined) {
    out.push({ path: `${path}/type`, kind: 'BREAKING', detail: 'candidate constrains type where baseline allowed any type' });
    return;
  }
  // Baseline restricted, candidate does not -> widening (safe).
  if (baseTypes !== undefined && candTypes === undefined) {
    out.push({ path: `${path}/type`, kind: 'COMPATIBLE', detail: 'candidate relaxes type restriction' });
    return;
  }

  // Both restricted: candidate must allow at least every baseline type.
  // Treat "integer" as a subset of "number".
  const missing = [...baseTypes!].filter((t) => !typeAllowed(t, candTypes!));
  if (missing.length > 0) {
    out.push({
      path: `${path}/type`,
      kind: 'BREAKING',
      detail: `candidate no longer accepts type(s): ${missing.join(', ')}`
    });
  } else if (candTypes!.size > baseTypes!.size) {
    out.push({ path: `${path}/type`, kind: 'COMPATIBLE', detail: 'candidate accepts additional types' });
  }
}

function typeAllowed(baseType: string, candTypes: Set<string>): boolean {
  if (candTypes.has(baseType)) return true;
  // number is a superset of integer.
  if (baseType === 'integer' && candTypes.has('number')) return true;
  return false;
}

function compareRequired(base: Record<string, unknown>, cand: Record<string, unknown>, path: string, out: CompatChange[]): void {
  const baseReq = new Set(asStringArray(base.required));
  const candReq = new Set(asStringArray(cand.required));

  // Adding a required property rejects baseline-valid data lacking it.
  for (const r of candReq) {
    if (!baseReq.has(r)) {
      out.push({ path: `${path}/required/${r}`, kind: 'BREAKING', detail: `candidate newly requires property "${r}"` });
    }
  }
  // Removing a required property only widens acceptance.
  for (const r of baseReq) {
    if (!candReq.has(r)) {
      out.push({ path: `${path}/required/${r}`, kind: 'COMPATIBLE', detail: `candidate no longer requires "${r}"` });
    }
  }
}

function compareProperties(base: Record<string, unknown>, cand: Record<string, unknown>, path: string, out: CompatChange[]): void {
  const baseProps = isObject(base.properties) ? (base.properties as Record<string, unknown>) : {};
  const candProps = isObject(cand.properties) ? (cand.properties as Record<string, unknown>) : {};

  for (const key of Object.keys(baseProps)) {
    if (key in candProps) {
      // Recurse: a property schema that got stricter is breaking there.
      compareNode(baseProps[key], candProps[key], `${path}/properties/${key}`, out);
    } else {
      // Property dropped from `properties`. Whether this rejects data depends
      // on additionalProperties on the candidate side.
      const candAP = cand.additionalProperties;
      if (candAP === false) {
        out.push({
          path: `${path}/properties/${key}`,
          kind: 'BREAKING',
          detail: `property "${key}" removed while candidate forbids additional properties`
        });
      } else if (isObject(candAP)) {
        out.push({
          path: `${path}/properties/${key}`,
          kind: 'UNKNOWN',
          detail: `property "${key}" removed; now governed by additionalProperties schema`
        });
      }
      // else additionalProperties is true/absent -> value still accepted.
    }
  }
  // New properties on the candidate side never reject old data by themselves.
}

function compareAdditionalProperties(base: Record<string, unknown>, cand: Record<string, unknown>, path: string, out: CompatChange[]): void {
  const baseAP = base.additionalProperties;
  const candAP = cand.additionalProperties;
  const baseOpen = baseAP === undefined || baseAP === true;
  const candClosed = candAP === false;

  if (baseOpen && candClosed) {
    out.push({
      path: `${path}/additionalProperties`,
      kind: 'BREAKING',
      detail: 'candidate forbids additional properties that baseline allowed'
    });
  } else if (baseAP === false && (candAP === undefined || candAP === true)) {
    out.push({ path: `${path}/additionalProperties`, kind: 'COMPATIBLE', detail: 'candidate now allows additional properties' });
  } else if (isObject(candAP) && (baseAP === undefined || baseAP === true)) {
    out.push({
      path: `${path}/additionalProperties`,
      kind: 'BREAKING',
      detail: 'candidate constrains additional properties baseline accepted freely'
    });
  }
}

function compareEnumConst(base: Record<string, unknown>, cand: Record<string, unknown>, path: string, out: CompatChange[]): void {
  const baseEnum = enumValues(base);
  const candEnum = enumValues(cand);

  if (baseEnum === undefined && candEnum === undefined) return;

  // Candidate restricts to an enum where baseline did not -> narrowing.
  if (baseEnum === undefined && candEnum !== undefined) {
    out.push({ path: `${path}/enum`, kind: 'BREAKING', detail: 'candidate restricts values to an enum/const where baseline was unconstrained' });
    return;
  }
  if (baseEnum !== undefined && candEnum === undefined) {
    out.push({ path: `${path}/enum`, kind: 'COMPATIBLE', detail: 'candidate removes enum/const restriction' });
    return;
  }
  // Both enums: every baseline-allowed value must remain allowed.
  const candSet = new Set(candEnum!.map((v) => JSON.stringify(v)));
  const removed = baseEnum!.filter((v) => !candSet.has(JSON.stringify(v)));
  if (removed.length > 0) {
    out.push({
      path: `${path}/enum`,
      kind: 'BREAKING',
      detail: `candidate removes allowed value(s): ${removed.map((v) => JSON.stringify(v)).join(', ')}`
    });
  } else if (candEnum!.length > baseEnum!.length) {
    out.push({ path: `${path}/enum`, kind: 'COMPATIBLE', detail: 'candidate adds allowed enum value(s)' });
  }
}

function compareNumericBounds(base: Record<string, unknown>, cand: Record<string, unknown>, path: string, out: CompatChange[]): void {
  // Tightening a bound rejects previously-valid numbers.
  boundChange(base, cand, 'minimum', 'raises', 'lowers', path, out, (b, c) => c > b);
  boundChange(base, cand, 'exclusiveMinimum', 'raises', 'lowers', path, out, (b, c) => c > b);
  boundChange(base, cand, 'maximum', 'lowers', 'raises', path, out, (b, c) => c < b);
  boundChange(base, cand, 'exclusiveMaximum', 'lowers', 'raises', path, out, (b, c) => c < b);
  // multipleOf: introducing or increasing it rejects values.
  const baseMul = numberOrUndef(base.multipleOf);
  const candMul = numberOrUndef(cand.multipleOf);
  if (candMul !== undefined && baseMul === undefined) {
    out.push({ path: `${path}/multipleOf`, kind: 'BREAKING', detail: 'candidate adds multipleOf constraint' });
  } else if (candMul !== undefined && baseMul !== undefined && candMul !== baseMul) {
    out.push({ path: `${path}/multipleOf`, kind: 'UNKNOWN', detail: `multipleOf changed ${baseMul} -> ${candMul}` });
  }
}

function compareStringBounds(base: Record<string, unknown>, cand: Record<string, unknown>, path: string, out: CompatChange[]): void {
  boundChange(base, cand, 'minLength', 'raises', 'lowers', path, out, (b, c) => c > b);
  boundChange(base, cand, 'maxLength', 'lowers', 'raises', path, out, (b, c) => c < b);
  const basePat = typeof base.pattern === 'string' ? base.pattern : undefined;
  const candPat = typeof cand.pattern === 'string' ? cand.pattern : undefined;
  if (candPat !== undefined && basePat === undefined) {
    out.push({ path: `${path}/pattern`, kind: 'BREAKING', detail: 'candidate adds a pattern constraint' });
  } else if (candPat !== undefined && basePat !== undefined && candPat !== basePat) {
    out.push({ path: `${path}/pattern`, kind: 'UNKNOWN', detail: 'pattern changed; cannot compare regex languages structurally' });
  } else if (candPat === undefined && basePat !== undefined) {
    out.push({ path: `${path}/pattern`, kind: 'COMPATIBLE', detail: 'candidate removes pattern constraint' });
  }
}

function compareArrayBounds(base: Record<string, unknown>, cand: Record<string, unknown>, path: string, out: CompatChange[]): void {
  boundChange(base, cand, 'minItems', 'raises', 'lowers', path, out, (b, c) => c > b);
  boundChange(base, cand, 'maxItems', 'lowers', 'raises', path, out, (b, c) => c < b);
  if (cand.uniqueItems === true && base.uniqueItems !== true) {
    out.push({ path: `${path}/uniqueItems`, kind: 'BREAKING', detail: 'candidate adds uniqueItems constraint' });
  }
}

function compareItems(base: Record<string, unknown>, cand: Record<string, unknown>, path: string, out: CompatChange[]): void {
  if ('items' in base || 'items' in cand) {
    const b = 'items' in base ? base.items : true;
    const c = 'items' in cand ? cand.items : true;
    // Only recurse when both sides are single-schema `items` (2020-12 style).
    if ((isObject(b) || typeof b === 'boolean') && (isObject(c) || typeof c === 'boolean')) {
      compareNode(b, c, `${path}/items`, out);
    } else {
      out.push({ path: `${path}/items`, kind: 'UNKNOWN', detail: 'tuple/array items form not analyzed structurally' });
    }
  }
}

// --- helpers ---------------------------------------------------------------

function boundChange(
  base: Record<string, unknown>,
  cand: Record<string, unknown>,
  key: string,
  tightenWord: string,
  loosenWord: string,
  path: string,
  out: CompatChange[],
  isTighter: (baseVal: number, candVal: number) => boolean
): void {
  const b = numberOrUndef(base[key]);
  const c = numberOrUndef(cand[key]);
  if (c === undefined) {
    if (b !== undefined) {
      out.push({ path: `${path}/${key}`, kind: 'COMPATIBLE', detail: `candidate removes ${key}` });
    }
    return;
  }
  if (b === undefined) {
    // Introducing a bound tightens acceptance.
    out.push({ path: `${path}/${key}`, kind: 'BREAKING', detail: `candidate adds ${key} (${tightenWord} the accepted range)` });
    return;
  }
  if (isTighter(b, c)) {
    out.push({ path: `${path}/${key}`, kind: 'BREAKING', detail: `candidate ${tightenWord} ${key} ${b} -> ${c}` });
  } else if (b !== c) {
    out.push({ path: `${path}/${key}`, kind: 'COMPATIBLE', detail: `candidate ${loosenWord} ${key} ${b} -> ${c}` });
  }
}

function normalizeTypes(t: unknown): Set<string> | undefined {
  if (t === undefined) return undefined;
  if (typeof t === 'string') return new Set([t]);
  if (Array.isArray(t)) return new Set(t.filter((x): x is string => typeof x === 'string'));
  return undefined;
}

function enumValues(schema: Record<string, unknown>): unknown[] | undefined {
  if (Array.isArray(schema.enum)) return schema.enum as unknown[];
  if ('const' in schema) return [schema.const];
  return undefined;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function numberOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Re-exported so callers can validate scalar type names if needed.
export { SCALAR_TYPES };
