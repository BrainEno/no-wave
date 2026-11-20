import type { ParallelUnit } from "./writing-parallel-model.ts";

export type SkeletonSection = {
  headingUnit: ParallelUnit | null;
  level: number;
  units: ParallelUnit[];
  subsections: SkeletonSection[];
};

export type DocumentSkeleton = {
  documentId: string;
  totalBlocks: number;
  sections: SkeletonSection[];
  headingCounts: Record<number, number>;
};

export function buildDocumentSkeleton(
  documentId: string,
  units: ParallelUnit[],
): DocumentSkeleton {
  const headingCounts: Record<number, number> = {
    1: 0,
    2: 0,
    3: 0,
    4: 0,
    5: 0,
    6: 0,
  };
  const sections: SkeletonSection[] = [];
  let currentSection: SkeletonSection = {
    headingUnit: null,
    level: 0,
    units: [],
    subsections: [],
  };
  sections.push(currentSection);

  for (const unit of units) {
    if (unit.kind === "heading" && unit.headingLevel !== null) {
      headingCounts[unit.headingLevel] =
        (headingCounts[unit.headingLevel] ?? 0) + 1;
      currentSection = {
        headingUnit: unit,
        level: unit.headingLevel,
        units: [unit],
        subsections: [],
      };
      sections.push(currentSection);
    } else {
      currentSection.units.push(unit);
    }
  }

  return {
    documentId,
    totalBlocks: units.length,
    sections,
    headingCounts,
  };
}

export function compareSkeletons(
  left: DocumentSkeleton,
  right: DocumentSkeleton,
): {
  headingCountDiff: number;
  totalBlocksDiff: number;
  levelDiscrepancies: { level: number; leftCount: number; rightCount: number }[];
} {
  const levelDiscrepancies: {
    level: number;
    leftCount: number;
    rightCount: number;
  }[] = [];

  for (let level = 1; level <= 6; level++) {
    const leftCount = left.headingCounts[level] ?? 0;
    const rightCount = right.headingCounts[level] ?? 0;
    if (leftCount !== rightCount) {
      levelDiscrepancies.push({ level, leftCount, rightCount });
    }
  }

  const leftHeadingTotal = Object.values(left.headingCounts).reduce(
    (a, b) => a + b,
    0,
  );
  const rightHeadingTotal = Object.values(right.headingCounts).reduce(
    (a, b) => a + b,
    0,
  );

  return {
    headingCountDiff: Math.abs(leftHeadingTotal - rightHeadingTotal),
    totalBlocksDiff: Math.abs(left.totalBlocks - right.totalBlocks),
    levelDiscrepancies,
  };
}
