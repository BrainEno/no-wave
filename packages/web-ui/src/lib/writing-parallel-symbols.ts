import {
  DEFAULT_PARALLEL_POLICY,
  PARALLEL_LIMITS,
  type ParallelBudgets,
  type ParallelPolicy,
} from "./writing-parallel-model.ts";

export class ParallelBudgetStop extends Error {
  public readonly limit: keyof ParallelBudgets;
  constructor(limit: keyof ParallelBudgets) {
    super(`Parallel analysis reached budget limit: ${limit}`);
    this.name = "ParallelBudgetStop";
    this.limit = limit;
  }
}

export class ParallelMeter {
  public readonly budgets: ParallelBudgets;
  public readonly pause: () => Promise<void>;
  public readonly progress: (completed: number, total: number) => void;
  public steps = 0;
  public findings = 0;

  constructor(
    budgets: ParallelBudgets,
    pause: () => Promise<void>,
    progress: (completed: number, total: number) => void,
  ) {
    this.budgets = budgets;
    this.pause = pause;
    this.progress = progress;
  }

  public async step(amount = 1): Promise<void> {
    this.steps += amount;
    if (this.steps > this.budgets.steps) {
      throw new ParallelBudgetStop("steps");
    }
    if ((this.steps & 0x1fff) === 0) {
      await this.pause();
    }
  }

  public recordFinding(): void {
    this.findings++;
    if (this.findings > this.budgets.findings) {
      throw new ParallelBudgetStop("findings");
    }
  }
}

export function validateParallelPolicy(policy: ParallelPolicy): ParallelPolicy {
  const scope = policy.scope;
  if (!["all", "paragraphs", "headings", "structural"].includes(scope)) {
    throw new Error("Invalid parallel policy scope.");
  }
  const ratio = Number(policy.ratioThreshold);
  if (!Number.isFinite(ratio) || ratio < 1.0 || ratio > 20.0) {
    throw new Error("Invalid ratioThreshold: must be between 1.0 and 20.0.");
  }
  const minLength = Number(policy.minBlockLength);
  if (!Number.isSafeInteger(minLength) || minLength < 1 || minLength > 100) {
    throw new Error("Invalid minBlockLength: must be integer between 1 and 100.");
  }
  return Object.freeze({
    scope,
    linkParity: Boolean(policy.linkParity),
    ratioThreshold: ratio,
    minBlockLength: minLength,
  });
}

export function parallelBudgets(
  overrides?: Partial<ParallelBudgets>,
): ParallelBudgets {
  return {
    units: Math.min(
      PARALLEL_LIMITS.units,
      Math.max(1, overrides?.units ?? PARALLEL_LIMITS.units),
    ),
    characters: Math.min(
      PARALLEL_LIMITS.characters,
      Math.max(1, overrides?.characters ?? PARALLEL_LIMITS.characters),
    ),
    steps: Math.min(
      PARALLEL_LIMITS.steps,
      Math.max(1, overrides?.steps ?? PARALLEL_LIMITS.steps),
    ),
    findings: Math.min(
      PARALLEL_LIMITS.findings,
      Math.max(1, overrides?.findings ?? PARALLEL_LIMITS.findings),
    ),
    pairs: Math.min(
      PARALLEL_LIMITS.pairs,
      Math.max(1, overrides?.pairs ?? PARALLEL_LIMITS.pairs),
    ),
    matrixCells: Math.min(
      PARALLEL_LIMITS.matrixCells,
      Math.max(100, overrides?.matrixCells ?? PARALLEL_LIMITS.matrixCells),
    ),
  };
}

export function extractAnchorTokens(text: string): string[] {
  const anchors: string[] = [];
  const numbers = text.match(/\b\d+(?:\.\d+)?%?\b/gu) ?? [];
  for (const num of numbers) {
    anchors.push(num);
  }
  const urls = text.match(/https?:\/\/[^\s"'<>]+/gu) ?? [];
  for (const url of urls) {
    anchors.push(url);
  }
  const properNouns = text.match(/\b[A-Z][a-zA-Z0-9_-]{2,}\b/gu) ?? [];
  for (const noun of properNouns) {
    anchors.push(noun);
  }
  return [...new Set(anchors)];
}

export const ALIGNMENT_WEIGHTS = Object.freeze({
  matchSameKind: 25,
  mismatchKind: -35,
  headingLevelMatch: 20,
  headingLevelDrift: -15,
  matchingAnchor: 15,
  gapPenalty: -18,
  lengthRatioGood: 12,
  lengthRatioExtreme: -20,
});
