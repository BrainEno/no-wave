import type { WritingSearchScope } from "./writing-replace.ts";

export type TermsPolicy = {
  mode: "literal" | "ascii-fold";
  scope: WritingSearchScope;
};
export type TermsRule = {
  preferred: string;
  alternatives: string[];
  boundary: "substring" | "word";
};
export type TermsRecipe = {
  format: "no-wave-writing-terms";
  version: 1;
  rules: TermsRule[];
};
export type TermsPattern = {
  id: string;
  rule: string;
  index: number;
  text: string;
  needle: string;
  length: number;
  boundary: TermsRule["boundary"];
};
export type TermsUnit = {
  id: string;
  document: string;
  path: number[];
  kind: string;
  text: string;
  blocked: { start: number; end: number }[];
};
export type TermsMatch = {
  id: string;
  unit: string;
  pattern: string;
  start: number;
  end: number;
  pointStart: number;
  pointEnd: number;
};
export type TermsRelation = {
  left: string;
  right: string;
  kind: "equal" | "contains";
  offsets: number[];
};
export type TermsCatalog = {
  relations: TermsRelation[];
  complete: boolean;
  components: string[][];
};
export type TermsCoverage = {
  documents: number;
  units: number;
  eligibleUnits: number;
  excludedUnits: number;
  points: number;
  characters: number;
  scannedUnits: number;
  scannedPoints: number;
  scannedCharacters: number;
  steps: number;
  outputs: number;
  wordRejected: number;
  boundaryRejected: number;
};
export const TERMS_LIMITS = {
  units: 4096,
  characters: 2_000_000,
  patterns: 512,
  patternPoints: 16384,
  states: 16385,
  steps: 4_000_000,
  outputs: 100_000,
  matches: 5000,
  relations: 4096,
} as const;
export type TermsBudgets = {
  -readonly [K in keyof typeof TERMS_LIMITS]: number;
};
export type TermsOptions = {
  pause?: () => Promise<void>;
  budgets?: Partial<TermsBudgets>;
  progress?: (
    stage: "source" | "catalog" | "scan",
    done: number,
    total: number,
  ) => void;
};
export type TermsAnalysis = {
  algorithm: "no-wave-writing-terms-v1";
  sourceKey: string;
  recipeKey: string;
  policy: TermsPolicy;
  recipe: TermsRecipe;
  patterns: TermsPattern[];
  documents: string[];
  units: TermsUnit[];
  matches: TermsMatch[];
  catalog: TermsCatalog;
  coverage: TermsCoverage;
  limit: "matches" | "outputs" | "steps" | null;
  frontier: { unit: string; point: number; utf16: number } | null;
};
export const DEFAULT_TERMS_POLICY: TermsPolicy = {
  mode: "literal",
  scope: "all",
};
