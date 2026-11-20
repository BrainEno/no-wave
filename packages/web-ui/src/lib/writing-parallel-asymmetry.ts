import type {
  ParallelAlignment,
  ParallelAsymmetry,
  ParallelPolicy,
  ParallelUnit,
} from "./writing-parallel-model.ts";
import type { ParallelMeter } from "./writing-parallel-symbols.ts";

export function detectStructuralOrderInversions(
  pairId: string,
  alignments: ParallelAlignment[],
  unitsById: Map<string, ParallelUnit>,
  meter: ParallelMeter,
): ParallelAsymmetry[] {
  const inversions: ParallelAsymmetry[] = [];
  let currentLeftHeading: string | null = null;
  let currentRightHeading: string | null = null;

  for (const align of alignments) {
    const left = align.leftId ? unitsById.get(align.leftId) : null;
    const right = align.rightId ? unitsById.get(align.rightId) : null;

    if (left?.kind === "heading") {
      currentLeftHeading = left.id;
    }
    if (right?.kind === "heading") {
      currentRightHeading = right.id;
    }

    // Check if an aligned content block belongs to mismatched heading scopes
    if (left && right && left.kind !== "heading" && right.kind !== "heading") {
      if (currentLeftHeading && currentRightHeading) {
        const leftH = unitsById.get(currentLeftHeading);
        const rightH = unitsById.get(currentRightHeading);
        if (
          leftH &&
          rightH &&
          leftH.headingLevel !== null &&
          rightH.headingLevel !== null &&
          leftH.headingLevel !== rightH.headingLevel &&
          Math.abs(leftH.headingLevel - rightH.headingLevel) >= 2
        ) {
          meter.recordFinding();
          inversions.push({
            id: `${pairId}:asym:${inversions.length}`,
            pairId,
            kind: "heading-level-drift",
            severity: "warning",
            leftId: left.id,
            rightId: right.id,
            message: `跨章节层级偏离：所属章节左侧为 H${leftH.headingLevel}，右侧为 H${rightH.headingLevel}。`,
          });
        }
      }
    }
  }

  return inversions;
}

export function detectAsymmetries(
  pairId: string,
  alignments: ParallelAlignment[],
  unitsById: Map<string, ParallelUnit>,
  policy: ParallelPolicy,
  medianRatio: number,
  meter: ParallelMeter,
): ParallelAsymmetry[] {
  const asymmetries: ParallelAsymmetry[] = [];

  for (const align of alignments) {
    const left = align.leftId ? unitsById.get(align.leftId) : null;
    const right = align.rightId ? unitsById.get(align.rightId) : null;

    if (left && !right) {
      meter.recordFinding();
      asymmetries.push({
        id: `${pairId}:asym:${asymmetries.length}`,
        pairId,
        kind: "missing-block",
        severity: "warning",
        leftId: left.id,
        message: `左侧存在 ${left.kind} 单元，右侧对应位置缺失。`,
      });
      continue;
    }

    if (!left && right) {
      meter.recordFinding();
      asymmetries.push({
        id: `${pairId}:asym:${asymmetries.length}`,
        pairId,
        kind: "missing-block",
        severity: "warning",
        rightId: right.id,
        message: `右侧存在 ${right.kind} 单元，左侧对应位置缺失。`,
      });
      continue;
    }

    if (!left || !right) continue;

    // Heading level drift
    if (left.kind === "heading" && right.kind === "heading") {
      if (left.headingLevel !== right.headingLevel) {
        meter.recordFinding();
        asymmetries.push({
          id: `${pairId}:asym:${asymmetries.length}`,
          pairId,
          kind: "heading-level-drift",
          severity: "error",
          leftId: left.id,
          rightId: right.id,
          message: `标题层级漂移：左侧为 h${left.headingLevel}，右侧为 h${right.headingLevel}。`,
        });
      }
    }

    // Link parity
    if (policy.linkParity) {
      const leftUrls = [...left.links].sort();
      const rightUrls = [...right.links].sort();
      const sameUrls =
        leftUrls.length === rightUrls.length &&
        leftUrls.every((url, i) => url === rightUrls[i]);
      if (!sameUrls && (leftUrls.length > 0 || rightUrls.length > 0)) {
        meter.recordFinding();
        asymmetries.push({
          id: `${pairId}:asym:${asymmetries.length}`,
          pairId,
          kind: "link-mismatch",
          severity: "warning",
          leftId: left.id,
          rightId: right.id,
          message: `外链不对称：左侧含 ${leftUrls.length} 个链接，右侧含 ${rightUrls.length} 个链接。`,
        });
      }
    }

    // Image parity
    if (left.kind === "image" || right.kind === "image") {
      const leftSrc = left.images[0] ?? "";
      const rightSrc = right.images[0] ?? "";
      if (leftSrc !== rightSrc) {
        meter.recordFinding();
        asymmetries.push({
          id: `${pairId}:asym:${asymmetries.length}`,
          pairId,
          kind: "image-mismatch",
          severity: "warning",
          leftId: left.id,
          rightId: right.id,
          message: `插图不对称：左侧地址「${leftSrc}」，右侧地址「${rightSrc}」。`,
        });
      }
    }

    // Extreme ratio
    if (align.ratio !== null && medianRatio > 0) {
      const relativeDisparity = Math.max(
        align.ratio / medianRatio,
        medianRatio / align.ratio,
      );
      if (relativeDisparity >= policy.ratioThreshold) {
        meter.recordFinding();
        asymmetries.push({
          id: `${pairId}:asym:${asymmetries.length}`,
          pairId,
          kind: "extreme-ratio",
          severity: "notice",
          leftId: left.id,
          rightId: right.id,
          message: `长度比例显著偏离（比例为 ${align.ratio}，中位数为 ${medianRatio}）。`,
        });
      }
    }
  }

  return asymmetries;
}
