import type { WritingPath } from "./writing-document.ts";

export type CadencePolicy = {
  scope: "all" | "paragraphs" | "headings" | "quotes" | "lists";
  quotes: "off" | "double" | "all";
  dot: boolean;
  short: number;
  long: number;
};
export const DEFAULT_CADENCE_POLICY: CadencePolicy = {
  scope: "all",
  quotes: "off",
  dot: false,
  short: 12,
  long: 120,
};
export const CADENCE_LIMITS = Object.freeze({
  units: 4096,
  characters: 2_000_000,
  steps: 8_000_000,
  findings: 5000,
  pairs: 50_000,
  fragments: 20_000,
  depth: 128,
});
export type CadenceBudgets = {
  -readonly [Key in keyof typeof CADENCE_LIMITS]: number;
};
export type CadenceLimit =
  "steps" | "findings" | "pairs" | "fragments" | "depth";
export type CadenceRange = {
  start: number;
  end: number;
  pointStart: number;
  pointEnd: number;
};
export type CadenceUnit = {
  id: string;
  document: string;
  path: WritingPath;
  kind: string;
  text: string;
  runs: CadenceRange[];
  barriers: (CadenceRange & { kind: "inline-code" | "break" })[];
};
export type CadenceFindingKind =
  | "unclosed-open"
  | "unexpected-close"
  | "blocked-close"
  | "invisible"
  | "whitespace-run"
  | "punctuation-run";
export type CadenceFinding = CadenceRange & {
  id: string;
  unit: string;
  kind: CadenceFindingKind;
  code: string;
  family: string | null;
  related: CadenceRange[];
};
export type CadencePair = {
  id: string;
  unit: string;
  family: string;
  open: CadenceRange;
  close: CadenceRange;
};
export type CadenceFragment = CadenceRange & {
  id: string;
  unit: string;
  run: number;
  points: number;
  nonspace: number;
  ending: "terminal" | "boundary";
};
export type CadenceCoverage = {
  documents: number;
  units: number;
  excludedUnits: number;
  eligibleUnits: number;
  characters: number;
  points: number;
  protectedCharacters: number;
  scannedUnits: number;
  scannedCharacters: number;
  scannedPoints: number;
  steps: number;
};
export type CadenceFrontier = {
  unit: number;
  document: string;
  path: WritingPath;
  start: 0;
  pointStart: 0;
};
export type CadenceAnalysis = {
  algorithm: "no-wave-writing-cadence-v1";
  sourceKey: string;
  source: "single" | "collection";
  policy: CadencePolicy;
  documents: string[];
  units: CadenceUnit[];
  findings: CadenceFinding[];
  pairs: CadencePair[];
  fragments: CadenceFragment[];
  coverage: CadenceCoverage;
  frontier: CadenceFrontier | null;
  limit: CadenceLimit | null;
};
export type CadenceProgress = {
  stage: "source" | "scan";
  done: number;
  total: number;
};
export type CadenceOptions = {
  budgets?: Partial<CadenceBudgets>;
  pause?: () => Promise<void>;
  progress?: (progress: CadenceProgress) => void;
};
export type CadenceUnitAudit = {
  findings: Omit<CadenceFinding, "id" | "unit">[];
  pairs: Omit<CadencePair, "id" | "unit">[];
  fragments: Omit<CadenceFragment, "id" | "unit">[];
};
export type CadenceTape = {
  chars: string[];
  offsets: number[];
  pointStart: number;
};
