import { createRequire } from 'node:module';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { CompatibilityIssue, CompatibilityResult } from './types.js';

const require = createRequire(import.meta.url);
const addFormats = require('ajv-formats') as typeof import('ajv-formats').default;

const SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);

export function validateSchema(schema: unknown): CompatibilityResult {
  const issues: CompatibilityIssue[] = [];
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    issues.push({ code: 'schema-not-object', message: 'schema must be an object', path: '$' });
    return { compatible: false, issues };
  }
  const s = schema as Record<string, unknown>;
  if (s['$schema'] !== undefined && s['$schema'] !== SCHEMA_DIALECT) {
    issues.push({
      code: 'unsupported-dialect',
      message: `only ${SCHEMA_DIALECT} is supported`,
      path: '$.$schema',
    });
  }
  const valid = ajv.validateSchema(s);
  if (!valid && ajv.errors) {
    for (const err of ajv.errors) {
      issues.push({
        code: 'invalid-schema',
        message: `${err.keyword}: ${err.message ?? 'invalid'}`,
        path: err.instancePath || '$',
      });
    }
  }
  return { compatible: issues.length === 0, issues };
}

type JsonSchema = Record<string, unknown>;

interface RefResolver {
  resolve(ref: string): JsonSchema | undefined;
}

function buildResolver(root: JsonSchema): RefResolver {
  return {
    resolve(ref: string): JsonSchema | undefined {
      if (!ref.startsWith('#')) return undefined;
      const parts = ref.slice(1).split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
      let cur: unknown = root;
      for (const part of parts) {
        if (part === '') continue;
        if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
          cur = (cur as Record<string, unknown>)[part];
        } else {
          return undefined;
        }
      }
      return cur && typeof cur === 'object' && !Array.isArray(cur) ? (cur as JsonSchema) : undefined;
    },
  };
}

export function checkBackwardCompatibility(
  baselineIn: unknown,
  candidateIn: unknown,
): CompatibilityResult {
  const baselineValidation = validateSchema(baselineIn);
  const candidateValidation = validateSchema(candidateIn);
  const issues: CompatibilityIssue[] = [
    ...baselineValidation.issues.map((i) => ({ ...i, path: `$[baseline]${i.path}` })),
    ...candidateValidation.issues.map((i) => ({ ...i, path: `$[candidate]${i.path}` })),
  ];
  if (issues.length > 0) return { compatible: false, issues };

  const baseline = baselineIn as JsonSchema;
  const candidate = candidateIn as JsonSchema;
  const resolver = buildResolver(candidate);

  compareSchemas(baseline, candidate, resolver, '$', issues, new Set());
  return { compatible: issues.length === 0, issues };
}

function compareSchemas(
  baseline: JsonSchema,
  candidate: JsonSchema,
  resolver: RefResolver,
  path: string,
  issues: CompatibilityIssue[],
  stack: Set<string>,
): void {
  const b = resolveRef(baseline, resolver, stack);
  const c = resolveRef(candidate, resolver, stack);
  if (!b || !c) {
    issues.push({ code: 'unresolvable-ref', message: 'could not resolve $ref', path });
    return;
  }

  compareType(b, c, path, issues);
  compareEnum(b, c, path, issues);
  compareConst(b, c, path, issues);
  compareNumericBounds(b, c, path, issues);
  compareStringBounds(b, c, path, issues);
  compareArrayBounds(b, c, path, issues);
  compareObject(b, c, resolver, path, issues, new Set(stack));
  compareCombinators(b, c, resolver, path, issues, new Set(stack));
}

function resolveRef(schema: JsonSchema, resolver: RefResolver, stack: Set<string>): JsonSchema | undefined {
  let cur: JsonSchema | undefined = schema;
  const localStack = new Set(stack);
  while (cur && typeof cur['$ref'] === 'string') {
    const ref = cur['$ref'] as string;
    if (localStack.has(ref)) return undefined;
    localStack.add(ref);
    cur = resolver.resolve(ref);
  }
  return cur;
}

function asTypes(schema: JsonSchema): Set<string> {
  const t = schema['type'];
  if (typeof t === 'string') return new Set([t]);
  if (Array.isArray(t)) return new Set(t.filter((x): x is string => typeof x === 'string'));
  return new Set();
}

function compareType(b: JsonSchema, c: JsonSchema, path: string, issues: CompatibilityIssue[]): void {
  const bt = asTypes(b);
  const ct = asTypes(c);
  if (bt.size === 0 || ct.size === 0) return;
  for (const t of bt) {
    if (!ct.has(t)) {
      issues.push({
        code: 'type-narrowed',
        message: `candidate no longer accepts type "${t}" that baseline accepts`,
        path: `${path}.type`,
      });
    }
  }
}

function compareEnum(b: JsonSchema, c: JsonSchema, path: string, issues: CompatibilityIssue[]): void {
  const be = b['enum'];
  const ce = c['enum'];
  if (Array.isArray(be) && Array.isArray(ce)) {
    const cset = new Set(ce.map((v) => JSON.stringify(v)));
    for (const v of be) {
      if (!cset.has(JSON.stringify(v))) {
        issues.push({
          code: 'enum-value-removed',
          message: `candidate removes enum value ${JSON.stringify(v)}`,
          path: `${path}.enum`,
        });
      }
    }
  } else if (Array.isArray(be) && !Array.isArray(ce)) {
    issues.push({ code: 'enum-removed', message: 'candidate removes enum restriction (relaxation is acceptable but structure changed)', path: `${path}.enum` });
  }
}

function compareConst(b: JsonSchema, c: JsonSchema, path: string, issues: CompatibilityIssue[]): void {
  if (b['const'] !== undefined && JSON.stringify(b['const']) !== JSON.stringify(c['const'])) {
    issues.push({
      code: 'const-changed',
      message: 'candidate changes const value',
      path: `${path}.const`,
    });
  }
}

function compareNumericBounds(b: JsonSchema, c: JsonSchema, path: string, issues: CompatibilityIssue[]): void {
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  const bMin = num(b['minimum']) ?? num(b['exclusiveMinimum']);
  const cMin = num(c['minimum']) ?? num(c['exclusiveMinimum']);
  if (bMin !== undefined && cMin !== undefined && cMin > bMin) {
    issues.push({ code: 'minimum-raised', message: `minimum raised from ${bMin} to ${cMin}`, path: `${path}.minimum` });
  }
  const bMax = num(b['maximum']) ?? num(b['exclusiveMaximum']);
  const cMax = num(c['maximum']) ?? num(c['exclusiveMaximum']);
  if (bMax !== undefined && cMax !== undefined && cMax < bMax) {
    issues.push({ code: 'maximum-lowered', message: `maximum lowered from ${bMax} to ${cMax}`, path: `${path}.maximum` });
  }
}

function compareStringBounds(b: JsonSchema, c: JsonSchema, path: string, issues: CompatibilityIssue[]): void {
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  const bMin = num(b['minLength']);
  const cMin = num(c['minLength']);
  if (bMin !== undefined && cMin !== undefined && cMin > bMin) {
    issues.push({ code: 'minlength-raised', message: `minLength raised from ${bMin} to ${cMin}`, path: `${path}.minLength` });
  }
  const bMax = num(b['maxLength']);
  const cMax = num(c['maxLength']);
  if (bMax !== undefined && cMax !== undefined && cMax < bMax) {
    issues.push({ code: 'maxlength-lowered', message: `maxLength lowered from ${bMax} to ${cMax}`, path: `${path}.maxLength` });
  }
}

function compareArrayBounds(b: JsonSchema, c: JsonSchema, path: string, issues: CompatibilityIssue[]): void {
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  const bMin = num(b['minItems']);
  const cMin = num(c['minItems']);
  if (bMin !== undefined && cMin !== undefined && cMin > bMin) {
    issues.push({ code: 'minitems-raised', message: `minItems raised from ${bMin} to ${cMin}`, path: `${path}.minItems` });
  }
  const bMax = num(b['maxItems']);
  const cMax = num(c['maxItems']);
  if (bMax !== undefined && cMax !== undefined && cMax < bMax) {
    issues.push({ code: 'maxitems-lowered', message: `maxItems lowered from ${bMax} to ${cMax}`, path: `${path}.maxItems` });
  }
}

function isObjectSchema(s: JsonSchema): boolean {
  const t = s['type'];
  if (t === 'object') return true;
  if (Array.isArray(t) && t.includes('object')) return true;
  return s['properties'] !== undefined || s['required'] !== undefined;
}

function compareObject(
  b: JsonSchema,
  c: JsonSchema,
  resolver: RefResolver,
  path: string,
  issues: CompatibilityIssue[],
  stack: Set<string>,
): void {
  if (!isObjectSchema(b) && !isObjectSchema(c)) return;

  const bProps = (b['properties'] as JsonSchema | undefined) ?? {};
  const cProps = (c['properties'] as JsonSchema | undefined) ?? {};
  const bRequired = new Set(Array.isArray(b['required']) ? (b['required'] as string[]) : []);
  const cRequired = new Set(Array.isArray(c['required']) ? (c['required'] as string[]) : []);

  for (const key of bRequired) {
    if (!cRequired.has(key) && cProps[key] !== undefined) {
      issues.push({
        code: 'required-relaxed',
        message: `property "${key}" no longer required (backward compatible, noted)`,
        path: `${path}.required`,
      });
    }
  }
  for (const key of cRequired) {
    if (!bRequired.has(key)) {
      issues.push({
        code: 'required-added',
        message: `property "${key}" is newly required; old instances may lack it`,
        path: `${path}.required`,
      });
    }
  }

  for (const key of Object.keys(bProps)) {
    const bp = bProps[key];
    const cp = cProps[key];
    if (cp === undefined) {
      const cAdd = c['additionalProperties'];
      if (cAdd === false) {
        issues.push({
          code: 'property-removed',
          message: `property "${key}" removed and additionalProperties is false`,
          path: `${path}.properties.${key}`,
        });
      }
    } else if (bp && typeof bp === 'object' && cp && typeof cp === 'object') {
      compareSchemas(bp as JsonSchema, cp as JsonSchema, resolver, `${path}.properties.${key}`, issues, new Set(stack));
    }
  }

  const bAdd = b['additionalProperties'];
  const cAdd = c['additionalProperties'];
  if (bAdd === true && cAdd === false) {
    issues.push({
      code: 'additionalproperties-tightened',
      message: 'additionalProperties changed from true to false',
      path: `${path}.additionalProperties`,
    });
  }
  if (bAdd && typeof bAdd === 'object' && cAdd === false) {
    issues.push({
      code: 'additionalproperties-tightened',
      message: 'additionalProperties schema replaced with false',
      path: `${path}.additionalProperties`,
    });
  }
}

function compareCombinators(
  b: JsonSchema,
  c: JsonSchema,
  resolver: RefResolver,
  path: string,
  issues: CompatibilityIssue[],
  stack: Set<string>,
): void {
  for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
    const bArr = b[keyword];
    const cArr = c[keyword];
    if (Array.isArray(bArr) && Array.isArray(cArr)) {
      if (keyword === 'allOf') {
        for (let i = 0; i < Math.max(bArr.length, cArr.length); i++) {
          const bs = bArr[i];
          const cs = cArr[i];
          if (bs && cs && typeof bs === 'object' && typeof cs === 'object') {
            compareSchemas(bs as JsonSchema, cs as JsonSchema, resolver, `${path}.${keyword}[${i}]`, issues, new Set(stack));
          } else if (bs && !cs) {
            issues.push({ code: 'allof-branch-removed', message: 'allOf branch removed', path: `${path}.${keyword}[${i}]` });
          }
        }
      } else {
        if (bArr.length !== cArr.length) {
          issues.push({
            code: 'combinator-arity-changed',
            message: `${keyword} branch count changed from ${bArr.length} to ${cArr.length}; manual review required`,
            path: `${path}.${keyword}`,
          });
        }
      }
    } else if (Array.isArray(bArr) && !Array.isArray(cArr)) {
      issues.push({
        code: 'combinator-removed',
        message: `${keyword} removed; manual review required`,
        path: `${path}.${keyword}`,
      });
    }
  }
}
