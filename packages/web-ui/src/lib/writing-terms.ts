import {
  collectionChecksum,
  type OpenedCollection,
} from "./writing-collection.ts";
import {
  DEFAULT_TERMS_POLICY,
  type TermsAnalysis,
  type TermsOptions,
  type TermsPolicy,
  type TermsRecipe,
} from "./writing-terms-model.ts";
import { compileTermsMachine } from "./writing-terms-machine.ts";
import { inspectTermsCatalog } from "./writing-terms-catalog.ts";
import { prepareTermsSource } from "./writing-terms-source.ts";
import {
  termsActive,
  termsBudgets,
  termsCheckpoint,
  termsPatterns,
  validateTermsPolicy,
  validateTermsRecipe,
} from "./writing-terms-recipe.ts";

/** One complete validated source; a compute stop exposes a complete prefix, never a partial set of claims at an end position. */
export async function analyzeWritingTerms(
  opened: OpenedCollection,
  raw: TermsRecipe,
  rawPolicy: TermsPolicy = DEFAULT_TERMS_POLICY,
  signal: AbortSignal = new AbortController().signal,
  options: TermsOptions = {},
): Promise<TermsAnalysis> {
  const recipe = validateTermsRecipe(raw),
    policy = validateTermsPolicy(rawPolicy),
    budgets = termsBudgets(options.budgets);
  const pause =
    options.pause ??
    (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const progress = options.progress ?? (() => {});
  const patterns = termsPatterns(recipe, policy),
    recipeKey = await collectionChecksum(recipe, signal);
  const machine = await compileTermsMachine(
    patterns,
    policy,
    budgets,
    signal,
    pause,
  );
  const source = await prepareTermsSource(
    opened,
    policy,
    budgets,
    signal,
    pause,
    progress,
  );
  const catalog = await inspectTermsCatalog(
    machine,
    budgets,
    signal,
    pause,
    progress,
  );
  const analysis: TermsAnalysis = {
    algorithm: "no-wave-writing-terms-v1",
    ...source,
    recipeKey,
    policy,
    recipe,
    patterns,
    matches: [],
    catalog,
    limit: null,
    frontier: null,
  };
  for (const [ordinal, unit] of source.units.entries()) {
    await termsCheckpoint(signal, pause);
    const scan = await machine.scan(unit.text, unit.blocked, source.coverage, {
      ...budgets,
      matches: budgets.matches - analysis.matches.length,
    });
    for (const match of scan.matches)
      analysis.matches.push(
        Object.freeze({
          ...match,
          unit: unit.id,
          id: `m${analysis.matches.length + 1}`,
        }),
      );
    source.coverage.scannedPoints += scan.points;
    source.coverage.scannedCharacters += scan.utf16;
    if (scan.limit) {
      analysis.limit = scan.limit;
      analysis.frontier = Object.freeze({
        unit: unit.id,
        point: scan.points,
        utf16: scan.utf16,
      });
      break;
    }
    source.coverage.scannedUnits++;
    progress("scan", ordinal + 1, source.units.length);
    termsActive(signal);
  }
  termsActive(signal);
  Object.freeze(analysis.documents);
  Object.freeze(analysis.units);
  Object.freeze(analysis.matches);
  Object.freeze(analysis.coverage);
  return Object.freeze(analysis);
}
