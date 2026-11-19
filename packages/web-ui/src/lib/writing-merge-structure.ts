import { writingTextDifference } from "./writing-compare.ts";
import { writingRecord } from "./writing-document.ts";
import type { WritingMergeRole, WritingMergeUnit } from "./writing-merge.ts";

type Path = (string | number)[];
type Change = {
  path: string;
  kind: "added" | "removed" | "value" | "type" | "array-length";
  before: string;
  after: string;
  beforeMissing: boolean;
  afterMissing: boolean;
  truncated: boolean;
};
type Pending = {
  path: Path;
  before: unknown;
  after: unknown;
  beforePresent: boolean;
  afterPresent: boolean;
};
export type WritingMergeStructure = {
  changes: Change[];
  visited: number;
  limited: boolean;
  ambiguous: boolean;
};
const MAX_VISITS = 4096;
const MAX_CHANGES = 40;

function pathLabel(path: Path): string {
  return (
    "$" +
    path
      .map(
        (part) => `/${String(part).replace(/~/g, "~0").replace(/\//g, "~1")}`,
      )
      .join("")
  );
}
function valueType(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}
function snippet(
  value: unknown,
  present: boolean,
): { text: string; truncated: boolean } {
  if (!present) return { text: "", truncated: false };
  const text = JSON.stringify(value);
  const preview = writingTextDifference("", text ?? "（不能序列化的值）");
  return { text: preview.inserted, truncated: preview.truncated };
}

/** Read-only positional diagnostics, never edits or evidence that two paragraphs have the same identity. */
export function inspectWritingMergeStructure(
  unit: WritingMergeUnit,
  role: WritingMergeRole,
): WritingMergeStructure {
  const result: WritingMergeStructure = {
    changes: [],
    visited: 0,
    limited: false,
    ambiguous: unit.reason === "ambiguous-order",
  };
  // Do not turn a deliberately opaque whole-body conflict into guessed per-position correspondences.
  if (result.ambiguous || role === "base") return result;
  const queue: Pending[] = [
    {
      path: [],
      before: unit.values.base,
      after: unit.values[role],
      beforePresent: true,
      afterPresent: true,
    },
  ];
  let scheduled = 1;
  const enqueue = (pending: Pending) => {
    if (scheduled >= MAX_VISITS) {
      result.limited = true;
      return;
    }
    scheduled++;
    queue.push(pending);
  };
  const append = (
    item: Pending,
    kind: Change["kind"],
    before = item.before,
    after = item.after,
  ) => {
    const a = snippet(before, item.beforePresent),
      b = snippet(after, item.afterPresent);
    result.changes.push({
      path: pathLabel(item.path),
      kind,
      before: a.text,
      after: b.text,
      beforeMissing: !item.beforePresent,
      afterMissing: !item.afterPresent,
      truncated: a.truncated || b.truncated,
    });
  };
  while (queue.length) {
    const item = queue.pop()!;
    result.visited++;
    if (item.path.length > 12) {
      result.limited = true;
      continue;
    }
    if (!item.beforePresent || !item.afterPresent) {
      append(item, item.beforePresent ? "removed" : "added");
    } else if (item.before === item.after) {
      continue;
    } else if (valueType(item.before) !== valueType(item.after)) {
      append(item, "type");
    } else if (Array.isArray(item.before) && Array.isArray(item.after)) {
      if (item.before.length !== item.after.length) {
        // A shift could change every following index. Report size, not invented additions/removals.
        append(item, "array-length", item.before.length, item.after.length);
      } else {
        const count = Math.min(item.before.length, MAX_VISITS - scheduled);
        if (count < item.before.length) result.limited = true;
        for (let index = count - 1; index >= 0; index--)
          enqueue({
            path: [...item.path, index],
            before: item.before[index],
            after: item.after[index],
            beforePresent: true,
            afterPresent: true,
          });
      }
    } else {
      const before = writingRecord(item.before),
        after = writingRecord(item.after);
      if (!before || !after) append(item, "value");
      else {
        const keys = [
          ...new Set([...Object.keys(before), ...Object.keys(after)]),
        ].sort();
        for (let index = keys.length - 1; index >= 0; index--) {
          const key = keys[index]!;
          enqueue({
            path: [...item.path, key],
            before: before[key],
            after: after[key],
            beforePresent: Object.hasOwn(before, key),
            afterPresent: Object.hasOwn(after, key),
          });
        }
      }
    }
    if (result.changes.length >= MAX_CHANGES && queue.length) {
      result.limited = true;
      break;
    }
  }
  return result;
}
