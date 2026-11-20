export type ParallelScope = "all" | "paragraphs" | "headings" | "structural";

export type ParallelPolicy = {
  scope: ParallelScope;
  linkParity: boolean;
  ratioThreshold: number;
  minBlockLength: number;
};

export const DEFAULT_PARALLEL_POLICY: ParallelPolicy = Object.freeze({
  scope: "all",
  linkParity: true,
  ratioThreshold: 3.5,
  minBlockLength: 2,
});

export const PARALLEL_LIMITS = Object.freeze({
  units: 4096,
  characters: 2_000_000,
  steps: 8_000_000,
  findings: 5000,
  pairs: 32,
  matrixCells: 4_000_000,
});

export type ParallelBudgets = {
  -readonly [Key in keyof typeof PARALLEL_LIMITS]: number;
};

export type ParallelBlockKind =
  | "paragraph"
  | "heading"
  | "quote"
  | "listitem"
  | "image"
  | "other";

export type ParallelUnit = {
  id: string;
  document: string;
  ordinal: number;
  kind: ParallelBlockKind;
  headingLevel: number | null;
  text: string;
  snippet: string;
  characterCount: number;
  wordCount: number;
  links: string[];
  images: string[];
  imageCount: number;
  anchors: string[];
  start: number;
  end: number;
  pointStart: number;
  pointEnd: number;
};

export type ParallelAlignmentType =
  | "exact-match"
  | "strong-align"
  | "partial-align"
  | "left-gap"
  | "right-gap"
  | "mismatch";

export type ParallelAlignment = {
  id: string;
  pairId: string;
  leftId: string | null;
  rightId: string | null;
  type: ParallelAlignmentType;
  score: number;
  confidence: number;
  ratio: number | null;
};

export type ParallelAsymmetryKind =
  | "missing-block"
  | "heading-level-drift"
  | "link-mismatch"
  | "link-parity-mismatch"
  | "image-mismatch"
  | "image-parity-mismatch"
  | "extreme-ratio";

export type ParallelFindingKind = ParallelAsymmetryKind;

export type ParallelAsymmetry = {
  id: string;
  pairId: string;
  kind: ParallelAsymmetryKind;
  severity: "error" | "warning" | "notice";
  leftId?: string;
  rightId?: string;
  message: string;
};

export type ParallelPairMetrics = {
  leftBlockCount: number;
  rightBlockCount: number;
  alignedBlockCount: number;
  leftGapCount: number;
  rightGapCount: number;
  structuralSimilarityIndex: number;
  medianRatio: number;
  linkCountLeft: number;
  linkCountRight: number;
  imageCountLeft: number;
  imageCountRight: number;
};

export type ParallelDocumentPair = {
  id: string;
  leftDocument: string;
  rightDocument: string;
  leftLocale: string;
  rightLocale: string;
  leftUnits: ParallelUnit[];
  rightUnits: ParallelUnit[];
  alignments: ParallelAlignment[];
  asymmetries: ParallelAsymmetry[];
  metrics: ParallelPairMetrics;
};

export type ParallelPairProfile = {
  pairId: string;
  leftDocument: string;
  rightDocument: string;
  leftLocale: string;
  rightLocale: string;
  leftBlocks: number;
  rightBlocks: number;
  alignedBlocks: number;
  leftGaps: number;
  rightGaps: number;
  similarityIndex: number;
  medianRatio: number;
  asymmetriesCount: number;
  asymmetryCounts: Record<ParallelFindingKind, number>;
  errorCount: number;
  warningCount: number;
};

export type ParallelAnalysis = {
  pairs: ParallelDocumentPair[];
  summaries: ParallelPairProfile[];
  findings: ParallelAsymmetry[];
  units: ParallelUnit[];
  witness: string;
  timestamp: string;
};

export type ParallelOptions = {
  budgets?: Partial<ParallelBudgets>;
  pause?: () => Promise<void>;
  progress?: (completed: number, total: number) => void;
};

/**
 * Deterministic 32-hex character digest without node:crypto dependency.
 * Runs identically in Node test runner and browser environment.
 */
export function computeFastHash(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x27d4eb2f;
  let h3 = 0x41c64e6d;
  let h4 = 0x6a09e667;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ((c * 31) >>> 0), 0x5bd1e995) >>> 0;
    h3 = Math.imul(h3 ^ ((c * 17) >>> 0), 0x1b873593) >>> 0;
    h4 = Math.imul(h4 ^ ((c * 7) >>> 0), 0x2c641215) >>> 0;
  }
  return [h1, h2, h3, h4].map((v) => (v >>> 0).toString(16).padStart(8, "0")).join("");
}
