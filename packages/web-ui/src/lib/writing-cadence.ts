import type { OpenedCollection } from "./writing-collection.ts";
import {
  DEFAULT_CADENCE_POLICY,
  type CadenceAnalysis,
  type CadenceOptions,
  type CadencePolicy,
} from "./writing-cadence-model.ts";
import {
  cadenceActive,
  cadenceBudgets,
  cadenceCheckpoint,
  CadenceBudgetStop,
  CadenceMeter,
  validateCadencePolicy,
} from "./writing-cadence-symbols.ts";
import { prepareCadenceSource } from "./writing-cadence-source.ts";
import { auditCadenceUnit } from "./writing-cadence-scan.ts";
import { sealCadenceAnalysis } from "./writing-cadence-index.ts";

/** Atomic unit commitment means budget exhaustion never invents an unmatched opener in an unfinished unit. */
export async function analyzeWritingCadence(
  opened: OpenedCollection,
  rawPolicy: CadencePolicy = DEFAULT_CADENCE_POLICY,
  signal = new AbortController().signal,
  options: CadenceOptions = {},
): Promise<CadenceAnalysis> {
  const policy = validateCadencePolicy(rawPolicy),
    budgets = cadenceBudgets(options.budgets);
  const pause =
      options.pause ?? (() => new Promise((resolve) => setTimeout(resolve, 0))),
    progress = options.progress ?? (() => {});
  const source = await prepareCadenceSource(
    opened,
    policy,
    budgets,
    signal,
    pause,
    progress,
  );
  const result: CadenceAnalysis = {
    algorithm: "no-wave-writing-cadence-v1",
    ...source,
    policy,
    findings: [],
    pairs: [],
    fragments: [],
    frontier: null,
    limit: null,
  };
  const meter = new CadenceMeter(budgets.steps);
  for (const [index, unit] of result.units.entries()) {
    await cadenceCheckpoint(signal, pause);
    try {
      const audit = await auditCadenceUnit(
        unit,
        policy,
        {
          findings: budgets.findings - result.findings.length,
          pairs: budgets.pairs - result.pairs.length,
          fragments: budgets.fragments - result.fragments.length,
          depth: budgets.depth,
        },
        meter,
        signal,
        pause,
      );
      cadenceActive(signal);
      for (const finding of audit.findings)
        result.findings.push({
          ...finding,
          id: `f${result.findings.length + 1}`,
          unit: unit.id,
        });
      for (const pair of audit.pairs)
        result.pairs.push({
          ...pair,
          id: `p${result.pairs.length + 1}`,
          unit: unit.id,
        });
      for (const fragment of audit.fragments)
        result.fragments.push({
          ...fragment,
          id: `s${result.fragments.length + 1}`,
          unit: unit.id,
        });
      result.coverage.scannedUnits++;
      result.coverage.scannedCharacters += unit.text.length;
      result.coverage.scannedPoints += [...unit.text].length;
    } catch (error) {
      if (!(error instanceof CadenceBudgetStop)) throw error;
      cadenceActive(signal);
      result.limit = error.limit;
      result.frontier = {
        unit: index,
        document: unit.document,
        path: [...unit.path],
        start: 0,
        pointStart: 0,
      };
      break;
    }
    progress({ stage: "scan", done: index + 1, total: result.units.length });
    cadenceActive(signal);
  }
  result.coverage.steps = meter.steps;
  cadenceActive(signal);
  const sealed = sealCadenceAnalysis(result);
  cadenceActive(signal);
  return sealed;
}
