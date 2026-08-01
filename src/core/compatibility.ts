import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type {
  CompatibilityReport,
  CompatibilityViolation,
  JsonSchema,
} from './types.js';
import { digest } from './digest.js';
import type { Clock } from './clock.js';
import { ValidationError } from './errors.js';

export function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv;
}

export function validateSchema(schema: JsonSchema): void {
  const ajv = createAjv();
  try {
    ajv.compile(schema);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ValidationError(`invalid JSON Schema: ${message}`);
  }
}

type TypeSet = Set<string>;

function extractTypes(schema: JsonSchema): TypeSet | null {
  const t = schema.type;
  if (typeof t === 'string') return new Set([t]);
  if (Array.isArray(t)) return new Set(t.filter((x): x is string => typeof x === 'string'));
  return null;
}

function pushIf(list: CompatibilityViolation[], v: CompatibilityViolation): void {
  list.push(v);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function asProps(schema: JsonSchema): Record<string, JsonSchema> {
  const p = schema.properties;
  return isObject(p) ? (p as Record<string, JsonSchema>) : {};
}

function asRequired(schema: JsonSchema): Set<string> {
  const r = schema.required;
  return new Set(Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string') : []);
}

function diffProperties(
  base: JsonSchema,
  cand: JsonSchema,
  path: string,
  out: CompatibilityViolation[],
): void {
  const baseProps = asProps(base);
  const candProps = asProps(cand);
  const baseReq = asRequired(base);
  const candReq = asRequired(cand);

  for (const name of Object.keys(baseProps)) {
    const childPath = `${path}/properties/${escapePointer(name)}`;
    if (!(name in candProps)) {
      if (baseReq.has(name)) {
        pushIf(out, {
          path: childPath,
          kind: 'required-property-removed',
          message: `required property '${name}' was removed`,
        });
      }
      continue;
    }
    diffNode(baseProps[name]!, candProps[name]!, childPath, out);
    if (!candReq.has(name) && baseReq.has(name)) {
      pushIf(out, {
        path: childPath,
        kind: 'required-property-removed',
        message: `property '${name}' is no longer required`,
      });
    }
  }

  for (const name of Object.keys(candProps)) {
    if (name in baseProps) continue;
    if (candReq.has(name)) {
      pushIf(out, {
        path: `${path}/properties/${escapePointer(name)}`,
        kind: 'property-added-required',
        message: `new required property '${name}' added; existing producers cannot provide it`,
      });
    }
  }

  if (base.additionalProperties === true && cand.additionalProperties === false) {
    pushIf(out, {
      path: `${path}/additionalProperties`,
      kind: 'additional-properties-restricted',
      message: 'additionalProperties changed from true to false',
    });
  } else if (isObject(base.additionalProperties) && cand.additionalProperties === false) {
    pushIf(out, {
      path: `${path}/additionalProperties`,
      kind: 'additional-properties-restricted',
      message: 'additionalProperties changed from a schema to false',
    });
  }
}

function diffNode(
  base: JsonSchema,
  cand: JsonSchema,
  path: string,
  out: CompatibilityViolation[],
): void {
  diffTypes(base, cand, path, out);
  diffEnums(base, cand, path, out);
  diffNumbers(base, cand, path, out);
  diffStrings(base, cand, path, out);
  diffFormat(base, cand, path, out);
  diffProperties(base, cand, path, out);
  diffCombinators(base, cand, path, out);
}

function diffTypes(
  base: JsonSchema,
  cand: JsonSchema,
  path: string,
  out: CompatibilityViolation[],
): void {
  const bt = extractTypes(base);
  const ct = extractTypes(cand);
  if (!bt || !ct) return;
  for (const t of bt) {
    if (!ct.has(t)) {
      pushIf(out, {
        path: `${path}/type`,
        kind: 'type-narrowed-incompatibly',
        message: `type removed: '${t}'`,
      });
    }
  }
}

function diffEnums(
  base: JsonSchema,
  cand: JsonSchema,
  path: string,
  out: CompatibilityViolation[],
): void {
  if (!Array.isArray(base.enum) || !Array.isArray(cand.enum)) return;
  const allowed = new Set(cand.enum.map((v) => JSON.stringify(v)));
  for (const v of base.enum) {
    if (!allowed.has(JSON.stringify(v))) {
      pushIf(out, {
        path: `${path}/enum`,
        kind: 'enum-narrowed',
        message: `enum value removed: ${JSON.stringify(v)}`,
      });
    }
  }
}

function diffNumbers(
  base: JsonSchema,
  cand: JsonSchema,
  path: string,
  out: CompatibilityViolation[],
): void {
  if (typeof base.minimum === 'number' && typeof cand.minimum === 'number' && cand.minimum > base.minimum) {
    pushIf(out, {
      path: `${path}/minimum`,
      kind: 'minimum-raised',
      message: `minimum raised from ${base.minimum} to ${cand.minimum}`,
    });
  }
  if (typeof base.exclusiveMinimum === 'number' && typeof cand.exclusiveMinimum === 'number' && cand.exclusiveMinimum > base.exclusiveMinimum) {
    pushIf(out, {
      path: `${path}/exclusiveMinimum`,
      kind: 'minimum-raised',
      message: `exclusiveMinimum raised from ${base.exclusiveMinimum} to ${cand.exclusiveMinimum}`,
    });
  }
  if (typeof base.maximum === 'number' && typeof cand.maximum === 'number' && cand.maximum < base.maximum) {
    pushIf(out, {
      path: `${path}/maximum`,
      kind: 'maximum-lowered',
      message: `maximum lowered from ${base.maximum} to ${cand.maximum}`,
    });
  }
  if (typeof base.exclusiveMaximum === 'number' && typeof cand.exclusiveMaximum === 'number' && cand.exclusiveMaximum < base.exclusiveMaximum) {
    pushIf(out, {
      path: `${path}/exclusiveMaximum`,
      kind: 'maximum-lowered',
      message: `exclusiveMaximum lowered from ${base.exclusiveMaximum} to ${cand.exclusiveMaximum}`,
    });
  }
}

function diffStrings(
  base: JsonSchema,
  cand: JsonSchema,
  path: string,
  out: CompatibilityViolation[],
): void {
  if (typeof base.minLength === 'number' && typeof cand.minLength === 'number' && cand.minLength > base.minLength) {
    pushIf(out, {
      path: `${path}/minLength`,
      kind: 'min-length-raised',
      message: `minLength raised from ${base.minLength} to ${cand.minLength}`,
    });
  }
  if (typeof base.maxLength === 'number' && typeof cand.maxLength === 'number' && cand.maxLength < base.maxLength) {
    pushIf(out, {
      path: `${path}/maxLength`,
      kind: 'max-length-lowered',
      message: `maxLength lowered from ${base.maxLength} to ${cand.maxLength}`,
    });
  }
}

function diffFormat(
  base: JsonSchema,
  cand: JsonSchema,
  path: string,
  out: CompatibilityViolation[],
): void {
  if (base.format && !cand.format) {
    pushIf(out, {
      path: `${path}/format`,
      kind: 'format-removed',
      message: `format '${String(base.format)}' removed`,
    });
  }
}

function diffCombinators(
  base: JsonSchema,
  cand: JsonSchema,
  path: string,
  out: CompatibilityViolation[],
): void {
  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    const b = base[key];
    const c = cand[key];
    if (Array.isArray(b) && Array.isArray(c)) {
      const limit = Math.min(b.length, c.length);
      for (let i = 0; i < limit; i++) {
        if (isObject(b[i]) && isObject(c[i])) {
          diffNode(b[i] as JsonSchema, c[i] as JsonSchema, `${path}/${key}/${i}`, out);
        }
      }
    }
  }
}

function escapePointer(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

export function checkCompatibility(
  baseline: JsonSchema,
  candidate: JsonSchema,
  clock: Clock,
): CompatibilityReport {
  validateSchema(baseline);
  validateSchema(candidate);
  const violations: CompatibilityViolation[] = [];
  diffNode(baseline, candidate, '', violations);
  const baselineDigest = digest(baseline);
  const candidateDigest = digest(candidate);
  return {
    compatible: violations.length === 0,
    violations,
    comparedAt: clock.now(),
    baselineDigest,
    candidateDigest,
  };
}
