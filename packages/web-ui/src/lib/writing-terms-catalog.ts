import {
  TERMS_LIMITS,
  type TermsBudgets,
  type TermsCatalog,
  type TermsOptions,
  type TermsRelation,
} from "./writing-terms-model.ts";
import type { TermsMachine } from "./writing-terms-machine.ts";
import { termsActive, termsCheckpoint } from "./writing-terms-recipe.ts";

/** Catalog relations are spelling diagnostics, not proof that contexts mean the same thing. */
export async function inspectTermsCatalog(
  machine: TermsMachine,
  budgets: TermsBudgets,
  signal: AbortSignal,
  pause: () => Promise<void>,
  progress: NonNullable<TermsOptions["progress"]>,
): Promise<TermsCatalog> {
  const relations: TermsRelation[] = [],
    order = new Map(
      machine.patterns.map((pattern, index) => [pattern.id, index]),
    );
  const counters = {
    steps: 0,
    outputs: 0,
    wordRejected: 0,
    boundaryRejected: 0,
  };
  // Independent finite catalog work budget; source scanning counters start fresh.
  const limits: TermsBudgets = {
    ...TERMS_LIMITS,
    matches: TERMS_LIMITS.outputs,
  };
  let complete = true;
  outer: for (const [ordinal, pattern] of machine.patterns.entries()) {
    await termsCheckpoint(signal, pause);
    const scanned = await machine.scan(
      pattern.text,
      [],
      counters,
      limits,
      true,
    );
    if (scanned.limit) {
      complete = false;
      break;
    }
    const byOther = new Map<string, TermsRelation>();
    for (const hit of scanned.matches) {
      if (hit.pattern === pattern.id) continue;
      const otherIndex = order.get(hit.pattern)!,
        other = machine.patterns[otherIndex]!;
      const equal = other.needle === pattern.needle;
      if (equal && ordinal > otherIndex) continue;
      let relation = byOther.get(other.id);
      if (!relation) {
        relation = {
          left: pattern.id,
          right: other.id,
          kind: equal ? "equal" : "contains",
          offsets: [],
        };
        byOther.set(other.id, relation);
      }
      relation.offsets.push(hit.pointStart);
    }
    for (const relation of byOther.values()) {
      if (relations.length === budgets.relations) {
        complete = false;
        break outer;
      }
      Object.freeze(relation.offsets);
      relations.push(Object.freeze(relation));
    }
    progress("catalog", ordinal + 1, machine.patterns.length);
    termsActive(signal);
  }
  // Connected components expose shared/contained spellings without producing all relation paths.
  const parents = machine.patterns.map((_, index) => index),
    used = new Set<number>();
  function root(value: number): number {
    let cursor = value;
    while (parents[cursor] !== cursor) cursor = parents[cursor]!;
    while (value !== cursor) {
      const next = parents[value]!;
      parents[value] = cursor;
      value = next;
    }
    return cursor;
  }
  for (const relation of relations) {
    const a = order.get(relation.left)!,
      b = order.get(relation.right)!;
    used.add(a);
    used.add(b);
    const from = root(a),
      to = root(b);
    if (from !== to) parents[Math.max(from, to)] = Math.min(from, to);
  }
  const groups = new Map<number, string[]>();
  for (const ordinal of [...used].sort((a, b) => a - b)) {
    const component = root(ordinal),
      ids = groups.get(component) ?? [];
    ids.push(machine.patterns[ordinal]!.id);
    groups.set(component, ids);
  }
  const components = [...groups.values()];
  for (const component of components) Object.freeze(component);
  Object.freeze(components);
  Object.freeze(relations);
  return Object.freeze({ relations, complete, components });
}
