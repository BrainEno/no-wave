import type {
  ParallelAlignment,
  ParallelAnalysis,
  ParallelAsymmetry,
  ParallelDocumentPair,
  ParallelUnit,
} from "./writing-parallel-model.ts";

export type ParallelInventory = {
  units: Map<string, ParallelUnit>;
  alignments: Map<string, ParallelAlignment>;
  asymmetries: Map<string, ParallelAsymmetry>;
  pairs: Map<string, ParallelDocumentPair>;
};

const inventoryCache = new WeakMap<ParallelAnalysis, ParallelInventory>();

export function parallelInventory(
  analysis: ParallelAnalysis,
): ParallelInventory {
  const cached = inventoryCache.get(analysis);
  if (cached) return cached;

  const units = new Map<string, ParallelUnit>();
  for (const unit of analysis.units) {
    units.set(unit.id, unit);
  }

  const alignments = new Map<string, ParallelAlignment>();
  const asymmetries = new Map<string, ParallelAsymmetry>();
  const pairs = new Map<string, ParallelDocumentPair>();

  for (const pair of analysis.pairs) {
    pairs.set(pair.id, pair);
    for (const align of pair.alignments) {
      alignments.set(align.id, align);
    }
    for (const asym of pair.asymmetries) {
      asymmetries.set(asym.id, asym);
    }
  }

  const inventory: ParallelInventory = {
    units,
    alignments,
    asymmetries,
    pairs,
  };

  inventoryCache.set(analysis, inventory);
  return inventory;
}

export function freezeTree<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    freezeTree(child);
  }
  return value;
}

export function sealParallelAnalysis(
  analysis: ParallelAnalysis,
): ParallelAnalysis {
  return freezeTree(analysis);
}
