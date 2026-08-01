import { canonicalize, deepEqual } from './canonical.js';
import type { CompatFinding, CompatResult } from './types.js';

/**
 * 契约兼容性判定（JSON Schema 2020-12 的务实子集）。
 *
 * 语义方向：契约描述“生产方会发出什么样的数据”，消费方按契约校验收到的数据。
 * 因此候选契约兼容基线，当且仅当候选所接受的数据集合是基线的子集（候选 ⊆ 基线），
 * 即生产方只可能收窄其输出，绝不发出旧消费方无法接受的数据。
 *
 * 覆盖的构造：type / enum / const / minimum / maximum / exclusiveMinimum /
 * exclusiveMaximum / minLength / maxLength / pattern / minItems / maxItems /
 * items / prefixItems / properties / required / additionalProperties。
 * 无法静态判定的构造（$ref、oneOf/anyOf/allOf/not、if/then/else、pattern 变更等）
 * 会产生 breaking=false 的“需人工复核”发现，而不是静默通过。
 */
export function checkCompatibility(baseline: unknown, candidate: unknown): CompatResult {
  if (deepEqual(baseline, candidate)) return { status: 'compatible', findings: [] };
  const findings: CompatFinding[] = [];
  checkSubset(candidate, baseline, '#', findings);
  return { status: findings.some((f) => f.breaking) ? 'breaking' : 'compatible', findings };
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

function toArr(v: unknown): unknown[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

function ptr(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function add(
  out: CompatFinding[],
  path: string,
  rule: string,
  message: string,
  breaking = true,
): void {
  out.push({ path, rule, message, breaking });
}

/** 检查 cand ⊆ base（cand 接受的数据集合必须是 base 的子集）。 */
function checkSubset(cand: unknown, base: unknown, path: string, out: CompatFinding[]): void {
  if (base === true || base === undefined) return; // 基线接受一切
  if (base === false) {
    if (cand !== false) add(out, path, 'schema.widened', '基线在该位置禁止任何数据，候选放开了约束');
    return;
  }
  if (cand === true || cand === undefined) {
    add(out, path, 'schema.widened', '候选在该位置移除了全部约束，可能发出基线不允许的数据');
    return;
  }
  if (cand === false) return; // 候选接受空集，必为子集
  if (deepEqual(cand, base)) return;

  const b = base as Obj;
  const c = cand as Obj;

  // 无法静态判定的组合关键字：内容一致则安全，否则提示人工复核。
  for (const kw of ['$ref', '$defs', 'oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else', 'dependentSchemas']) {
    if (kw in b || kw in c) {
      if (!deepEqual(b[kw], c[kw])) {
        add(out, path, `unsupported.${kw}`, `关键字 ${kw} 发生变化，无法静态判定包含关系，需人工复核`, false);
      }
    }
  }

  // type
  const bt = toArr(b.type);
  const ct = toArr(c.type);
  if (bt) {
    if (!ct) {
      add(out, path, 'type.removed', `基线限定类型 ${bt.join('|')}，候选移除了类型约束`);
    } else {
      for (const t of ct) {
        if (!bt.includes(t)) add(out, path, 'type.widened', `候选新增类型 ${String(t)}，基线仅允许 ${bt.join('|')}`);
      }
    }
  }

  // enum / const
  if (Array.isArray(b.enum)) {
    const allowed = (v: unknown) => (b.enum as unknown[]).some((e) => deepEqual(e, v));
    if (Array.isArray(c.enum)) {
      for (const v of c.enum) {
        if (!allowed(v)) add(out, path, 'enum.widened', `候选枚举值 ${JSON.stringify(v)} 不在基线枚举集合内`);
      }
    } else if ('const' in c) {
      if (!allowed(c.const)) add(out, path, 'const.widened', '候选 const 不在基线枚举集合内');
    } else {
      add(out, path, 'enum.removed', '基线限定了枚举集合，候选移除了枚举约束');
    }
  }
  if ('const' in b) {
    if (!('const' in c) || !deepEqual(b.const, c.const)) {
      add(out, path, 'const.changed', '候选改变了基线的 const 约束');
    }
  }

  // 数值边界
  checkNumericBound(b, c, 'minimum', 'exclusiveMinimum', 'lower', path, out);
  checkNumericBound(b, c, 'maximum', 'exclusiveMaximum', 'upper', path, out);

  // 字符串 / 数组长度边界
  checkLenBound(b, c, 'minLength', 'min', path, out);
  checkLenBound(b, c, 'maxLength', 'max', path, out);
  checkLenBound(b, c, 'minItems', 'min', path, out);
  checkLenBound(b, c, 'maxItems', 'max', path, out);

  if (typeof b.pattern === 'string' && c.pattern !== b.pattern) {
    if (c.pattern === undefined) {
      add(out, path, 'pattern.removed', '候选移除了基线的 pattern 约束');
    } else {
      add(out, path, 'pattern.unknown', '候选修改了 pattern，无法静态判定包含关系，需人工复核', false);
    }
  }

  // 数组 items / prefixItems
  if (isObj(b.items) || b.items === false) {
    checkSubset(c.items, b.items, `${path}/items`, out);
  }
  if (Array.isArray(b.prefixItems)) {
    const cp = Array.isArray(c.prefixItems) ? c.prefixItems : [];
    b.prefixItems.forEach((sub, i) => {
      checkSubset(cp[i], sub, `${path}/prefixItems/${i}`, out);
    });
    if (cp.length > b.prefixItems.length) {
      for (let i = b.prefixItems.length; i < cp.length; i++) {
        checkSubset(cp[i], b.items === undefined ? true : b.items, `${path}/prefixItems/${i}`, out);
      }
    }
  }

  // 对象 required / properties / additionalProperties
  const bReq = (toArr(b.required) ?? []) as string[];
  const cReq = (toArr(c.required) ?? []) as string[];
  for (const r of bReq) {
    if (!cReq.includes(r)) add(out, path, 'required.dropped', `候选不再保证必填字段 ${r}，消费方可能依赖该字段`);
  }

  const bProps = isObj(b.properties) ? b.properties : {};
  const cProps = isObj(c.properties) ? c.properties : {};
  const bAP = 'additionalProperties' in b ? b.additionalProperties : true;
  const cAP = 'additionalProperties' in c ? c.additionalProperties : true;

  for (const [key, bSub] of Object.entries(bProps)) {
    const cSub = key in cProps ? cProps[key] : cAP;
    checkSubset(cSub, bSub, `${path}/properties/${ptr(key)}`, out);
  }

  const newKeys = Object.keys(cProps).filter((k) => !(k in bProps));
  if (newKeys.length > 0) {
    if (bAP === false) {
      add(out, path, 'additionalProperties.widened', `候选新增字段 ${newKeys.join(', ')}，而基线禁止额外字段`);
    } else {
      for (const k of newKeys) checkSubset(cProps[k], bAP, `${path}/properties/${ptr(k)}`, out);
    }
  }
  if (bAP === false) {
    if (cAP !== false && newKeys.length === 0) {
      add(out, path, 'additionalProperties.widened', '基线禁止额外字段，候选允许额外字段');
    }
  } else if (isObj(bAP)) {
    if (cAP === true || cAP === undefined) {
      add(out, path, 'additionalProperties.widened', '候选放宽了对额外字段的约束');
    } else if (isObj(cAP)) {
      checkSubset(cAP, bAP, `${path}/additionalProperties`, out);
    }
  }
}

interface Bound {
  value: number;
  exclusive: boolean;
}

function effectiveBound(schema: Obj, inclusive: string, exclusive: string): Bound | undefined {
  if (typeof schema[exclusive] === 'number') return { value: schema[exclusive] as number, exclusive: true };
  if (typeof schema[inclusive] === 'number') return { value: schema[inclusive] as number, exclusive: false };
  return undefined;
}

function checkNumericBound(
  b: Obj,
  c: Obj,
  inclusive: string,
  exclusive: string,
  side: 'lower' | 'upper',
  path: string,
  out: CompatFinding[],
): void {
  const bb = effectiveBound(b, inclusive, exclusive);
  if (!bb) return;
  const cb = effectiveBound(c, inclusive, exclusive);
  const label = side === 'lower' ? '下界' : '上界';
  if (!cb) {
    add(out, path, `${inclusive}.removed`, `候选移除了基线的${label}约束 ${inclusive}=${bb.value}`);
    return;
  }
  // 候选下界必须 >= 基线下界；候选上界必须 <= 基线上界（含开闭区间语义）。
  const widened =
    side === 'lower'
      ? cb.value < bb.value || (cb.value === bb.value && bb.exclusive && !cb.exclusive)
      : cb.value > bb.value || (cb.value === bb.value && bb.exclusive && !cb.exclusive);
  if (widened) {
    add(out, path, `${inclusive}.widened`, `候选放宽了${label}约束：基线 ${bb.value}${bb.exclusive ? '(排他)' : ''}，候选 ${cb.value}${cb.exclusive ? '(排他)' : ''}`);
  }
}

function checkLenBound(
  b: Obj,
  c: Obj,
  keyword: string,
  dir: 'min' | 'max',
  path: string,
  out: CompatFinding[],
): void {
  if (typeof b[keyword] !== 'number') return;
  const bv = b[keyword] as number;
  if (typeof c[keyword] !== 'number') {
    add(out, path, `${keyword}.removed`, `候选移除了基线的 ${keyword}=${bv} 约束`);
    return;
  }
  const cv = c[keyword] as number;
  if ((dir === 'min' && cv < bv) || (dir === 'max' && cv > bv)) {
    add(out, path, `${keyword}.widened`, `候选放宽了 ${keyword}：基线 ${bv}，候选 ${cv}`);
  }
}

/** 供日志/调试使用：摘要化兼容结果。 */
export function summarizeCompat(result: CompatResult): string {
  const breaking = result.findings.filter((f) => f.breaking).length;
  const review = result.findings.length - breaking;
  return `${result.status}（破坏性 ${breaking} 项，待复核 ${review} 项）`;
}

export { canonicalize };
