import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * Issue #331: every unchecked phase-gate item has a recorded attribution, and
 * the attribution cannot drift from the roadmap. The roadmap is the source of
 * truth; the disposition document must quote each open item verbatim, exactly
 * once, at the line where the roadmap currently has it. The operational-monitor
 * runbook must name every alert rule the monitor implements.
 */

const root = join(import.meta.dirname, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

const ROADMAP = "docs/roadmap/phase-gates.md";
const DISPOSITION = "docs/roadmap/phase-gate-disposition.md";
const MONITOR_RUNBOOK = "docs/operations/operational-monitor.md";
const MONITOR_RULES_SOURCE = "apps/api/src/application/operational-monitor.ts";

function openItems(): { line: number; text: string }[] {
  return read(ROADMAP)
    .split("\n")
    .flatMap((text, index) =>
      text.startsWith("- [ ] ")
        ? [{ line: index + 1, text: text.slice(6) }]
        : [],
    );
}

test("every open roadmap item is attributed verbatim, once, at its current line", () => {
  const items = openItems();
  assert.equal(
    items.length,
    25,
    "the roadmap's open-item count changed; re-attribute the new set",
  );
  const doc = read(DISPOSITION);
  const entries = [
    ...doc.matchAll(/^- 第 (\d+) 项（phase-gates 第 (\d+) 行）：(.*)$/gm),
  ];
  assert.equal(
    entries.length,
    items.length,
    "disposition entries do not match the open items",
  );
  const seen = new Set<number>();
  for (const [, ordinal, line, quoted] of entries) {
    const index = Number(ordinal) - 1;
    assert.ok(
      index >= 0 && index < items.length,
      `entry ${ordinal} is out of range`,
    );
    assert.ok(!seen.has(index), `entry ${ordinal} is listed twice`);
    seen.add(index);
    const item = items[index]!;
    assert.equal(
      quoted,
      item.text,
      `entry ${ordinal} does not quote the open item verbatim`,
    );
    assert.equal(
      Number(line),
      item.line,
      `entry ${ordinal} points at line ${line}, roadmap has ${item.line}`,
    );
  }
  for (const item of items) {
    const occurrences = doc.split(item.text).length - 1;
    assert.equal(
      occurrences,
      1,
      `open item at line ${item.line} appears ${occurrences} times`,
    );
  }
});

test("the disposition document is active and reachable from the roadmap", () => {
  assert.match(read(DISPOSITION), /^Status: active$/m);
  assert.ok(
    read(ROADMAP).includes("(phase-gate-disposition.md)"),
    "roadmap does not link the disposition",
  );
  assert.ok(
    existsSync(join(root, "docs/operations/operational-monitor.md")),
    "runbook link target is missing",
  );
});

test("the monitor runbook names every alert rule the monitor implements", () => {
  const source = read(MONITOR_RULES_SOURCE);
  const match = source.match(
    /export const MONITOR_RULES = \[([\s\S]*?)\] as const;/,
  );
  assert.ok(match, "MONITOR_RULES declaration not found");
  const rules = [...match[1]!.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]!);
  assert.equal(
    rules.length,
    8,
    "the monitor rule set changed; update the runbook table",
  );
  const runbook = read(MONITOR_RUNBOOK);
  for (const rule of rules) {
    assert.ok(
      runbook.includes(rule),
      `${MONITOR_RUNBOOK} does not document rule ${rule}`,
    );
  }
});
