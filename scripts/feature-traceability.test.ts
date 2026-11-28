import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * The capability map is only useful if it is true. This test keeps
 * `docs/audit/feature-traceability.md` and its companion register honest:
 *
 * - every implementation and verification path a row cites exists;
 * - a cited test file really contains a test case;
 * - a row that is not complete says which unresolved behaviour it is waiting on,
 *   and that behaviour really is recorded;
 * - a recorded behaviour is waited on by at least one row, so a decision cannot
 *   be written down and then quietly forgotten.
 *
 * It is the same shape as `scripts/phase-gate-disposition.test.ts`: the
 * documents are the source of truth, and this file is what stops them drifting
 * away from the repository they describe.
 */

const root = join(import.meta.dirname, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

export const MAP = "docs/audit/feature-traceability.md";
export const REGISTER = "docs/audit/unresolved-product-behavior.md";
export const INDEX = "docs/README.md";

export type CapabilityRow = {
  line: number;
  capability: string;
  requirement: string;
  implementation: string;
  verification: string;
  state: "verified" | "partial" | "open";
  unresolved: string | null;
};

export type UnresolvedEntry = {
  id: string;
  title: string;
  class: "A" | "B" | "C";
  body: string;
};

/** Inline code spans: the convention this document uses for a file path. */
export function codePaths(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
}

const STATE = /^(verified|partial|open)(?:\s*[—–-]\s*(U-\d{2}))?$/;

function isSeparator(cells: readonly string[]): boolean {
  return cells.every((cell) => /^-+$/.test(cell));
}

/**
 * The capability rows of the map. A row that does not have the five documented
 * columns is reported rather than skipped: a malformed row is a row whose
 * evidence nobody is reading.
 */
export function capabilityRows(markdown: string): {
  rows: CapabilityRow[];
  malformed: { line: number; cells: number }[];
} {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === "## Capability map");
  if (start < 0) return { rows: [], malformed: [] };
  const rows: CapabilityRow[] = [];
  const malformed: { line: number; cells: number }[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith("## ")) break;
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length === 5 && cells[0] === "Capability") continue;
    if (cells.length > 0 && isSeparator(cells)) continue;
    if (cells.length !== 5) {
      malformed.push({ line: index + 1, cells: cells.length });
      continue;
    }
    const state = STATE.exec(cells[4]!);
    if (!state) {
      malformed.push({ line: index + 1, cells: cells.length });
      continue;
    }
    rows.push({
      line: index + 1,
      capability: cells[0]!,
      requirement: cells[1]!,
      implementation: cells[2]!,
      verification: cells[3]!,
      state: state[1] as CapabilityRow["state"],
      unresolved: state[2] ?? null,
    });
  }
  return { rows, malformed };
}

/** The numbered entries of the unresolved-behaviour register. */
export function unresolvedEntries(markdown: string): UnresolvedEntry[] {
  const entries: UnresolvedEntry[] = [];
  const lines = markdown.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^## (U-\d{2}) — (.+)$/.exec(lines[index]!);
    if (!heading) continue;
    const body: string[] = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      if (lines[next]!.startsWith("## ")) break;
      body.push(lines[next]!);
    }
    const classMatch = /\*\*Class: ([ABC])\b/.exec(body.join("\n"));
    entries.push({
      id: heading[1]!,
      title: heading[2]!,
      class: (classMatch?.[1] ?? "A") as UnresolvedEntry["class"],
      body: body.join("\n").trim(),
    });
  }
  return entries;
}

/** A test file must actually contain a test case, not only a name. */
export function hasTestCase(source: string): boolean {
  return /\b(?:test|it)\s*(?:\.\s*(?:skip|only|todo|describe)\s*)?\(/.test(
    source,
  );
}

const map = read(MAP);
const register = read(REGISTER);
const { rows, malformed } = capabilityRows(map);
const entries = unresolvedEntries(register);

test("the capability map has rows and no malformed row", () => {
  assert.deepEqual(malformed, []);
  assert.ok(
    rows.length >= 30,
    `the capability map has only ${rows.length} rows; a capability was probably dropped`,
  );
});

test("every capability row states a requirement", () => {
  for (const row of rows) {
    assert.ok(
      row.requirement.length > 10,
      `${MAP}:${row.line} "${row.capability}" has no acceptance requirement`,
    );
  }
});

test("every implementation path a row cites exists in the repository", () => {
  const missing: string[] = [];
  for (const row of rows) {
    for (const path of codePaths(row.implementation)) {
      if (!existsSync(join(root, path)))
        missing.push(`${MAP}:${row.line} ${path}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("every verification path a row cites exists and is a real test file", () => {
  const problems: string[] = [];
  for (const row of rows) {
    const paths = codePaths(row.verification);
    if (paths.length === 0) {
      // A row may only have no evidence when it is openly not built.
      assert.equal(
        row.state,
        "open",
        `${MAP}:${row.line} "${row.capability}" has no verification evidence`,
      );
      continue;
    }
    for (const path of paths) {
      if (!existsSync(join(root, path))) {
        problems.push(`${MAP}:${row.line} ${path} does not exist`);
        continue;
      }
      if (!/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)) {
        problems.push(
          `${MAP}:${row.line} ${path} is not a test file, so it cannot be verification evidence`,
        );
        continue;
      }
      if (!hasTestCase(read(path))) {
        problems.push(`${MAP}:${row.line} ${path} contains no test case`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("a row that is not complete points at a recorded unresolved behaviour", () => {
  const known = new Set(entries.map((entry) => entry.id));
  for (const row of rows) {
    if (row.state === "verified") {
      assert.equal(
        row.unresolved,
        null,
        `${MAP}:${row.line} "${row.capability}" is verified but still cites ${row.unresolved}`,
      );
      continue;
    }
    assert.ok(
      row.unresolved,
      `${MAP}:${row.line} "${row.capability}" is ${row.state} but names no unresolved behaviour`,
    );
    assert.ok(
      known.has(row.unresolved!),
      `${MAP}:${row.line} cites ${row.unresolved}, which ${REGISTER} does not define`,
    );
  }
});

test("a recorded unresolved behaviour is waited on by at least one row", () => {
  const cited = new Set(rows.map((row) => row.unresolved).filter(Boolean));
  const forgotten = entries
    .map((entry) => entry.id)
    .filter((id) => !cited.has(id));
  assert.deepEqual(
    forgotten,
    [],
    `${REGISTER} records a behaviour no capability row refers to; either close it or point a row at it`,
  );
});

test("every recorded behaviour states its class, question, tracking and blocker", () => {
  for (const entry of entries) {
    assert.match(
      entry.body,
      /\*\*Class: [ABC]\b/,
      `${REGISTER} ${entry.id} has no class`,
    );
    assert.match(
      entry.body,
      /\*\*The question\.\*\*/,
      `${REGISTER} ${entry.id} does not state the question`,
    );
    assert.match(
      entry.body,
      /\bTracked as\b/,
      `${REGISTER} ${entry.id} does not say where it is tracked`,
    );
    assert.match(
      entry.body,
      /\*\*Blocked until answered\.\*\*/,
      `${REGISTER} ${entry.id} does not say what it blocks`,
    );
    if (entry.class === "B") {
      assert.match(
        entry.body,
        /\*\*Recommended\.\*\*/,
        `${REGISTER} ${entry.id} needs a product decision but offers no recommendation`,
      );
    }
  }
});

test("the register and the map are indexed and reachable", () => {
  assert.match(map, /^Status: active$/m);
  assert.match(register, /^Status: active$/m);
  const index = read(INDEX);
  assert.ok(
    index.includes("audit/feature-traceability.md"),
    `${INDEX} does not index the capability map`,
  );
  assert.ok(
    index.includes("audit/unresolved-product-behavior.md"),
    `${INDEX} does not index the unresolved-behaviour register`,
  );
  assert.ok(
    map.includes("unresolved-product-behavior.md"),
    "the capability map does not link the register",
  );
});

test("the parsers reject a broken document instead of accepting it", () => {
  const broken = [
    "## Capability map",
    "",
    "| Capability | Requirement | Implementation | Verification | State |",
    "| --- | --- | --- | --- | --- |",
    "| One | Requirement | `a.ts` | `b.test.ts` | verified |",
    "| Two | Requirement | `a.ts` | `b.test.ts` | maybe |",
  ].join("\n");
  const parsed = capabilityRows(broken);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.malformed.length, 1);
  assert.equal(parsed.malformed[0]!.line, 6);

  assert.deepEqual(unresolvedEntries("## U-01 — Title\nbody\n"), [
    { id: "U-01", title: "Title", class: "A", body: "body" },
  ]);
  assert.equal(
    hasTestCase("import test from 'node:test';\n"),
    false,
    "an import alone is not a test case",
  );
  assert.equal(hasTestCase('test("does a thing", () => {});'), true);
  assert.equal(hasTestCase('test.skip("does a thing", () => {});'), true);
});
