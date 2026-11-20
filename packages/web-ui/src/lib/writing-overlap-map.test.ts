import test from "node:test";
import assert from "node:assert/strict";
import {
  overlapFixture,
  overlapPolicy,
} from "../test-support/writing-overlap.ts";
import { analyzeWritingOverlap } from "./writing-overlap.ts";
import {
  DEFAULT_OVERLAP_FILTER,
  overlapReviewRows,
  overlapOccurrences,
} from "./writing-overlap-review.ts";
import {
  mapWritingOverlap,
  overlapMapCells,
  overlapMapOccurrences,
  overlapMapRows,
} from "./writing-overlap-map.ts";
import type { OverlapAnalysis } from "./writing-overlap-model.ts";
const text =
  "Private river passages remember quiet mornings in the willow valley.";
const other = text.replace("quiet", "amber");
const documents = ["d1", "d2", "d3", "d4"];
const source = () =>
  overlapFixture([
    [text, text, other],
    [text, other, other],
    [text],
    [
      "not eligible",
      {
        type: "code",
        version: 1,
        children: [{ type: "text", version: 1, text: text }],
      },
    ],
  ]);
const pause = async () => {};
async function analyze(
  scope: "all" | "cross-document" | "within-document" = "all",
) {
  return analyzeWritingOverlap(
    await source(),
    overlapPolicy({ scope, minimum: 24 }),
    new AbortController().signal,
    { pause },
  );
}
function enumerate(analysis: OverlapAnalysis) {
  const cells = new Map<
      string,
      { exactPairs: number; nearPairs: number; findings: Set<string> }
    >(),
    listed = new Map(documents.map((id) => [id, new Set<string>()]));
  for (const finding of [...analysis.exact, ...analysis.near]) {
    const seen = new Set<string>();
    for (const left of overlapOccurrences(analysis, finding.id, "left"))
      for (const right of overlapOccurrences(
        analysis,
        finding.id,
        "right",
        left.id,
      )) {
        const occurrence = [left.id, right.id].sort().join("/");
        if (seen.has(occurrence)) continue;
        seen.add(occurrence);
        const [a, b] = [left.document, right.document].sort(),
          id = `p:${a}:${b}`;
        const cell = cells.get(id) ?? {
          exactPairs: 0,
          nearPairs: 0,
          findings: new Set<string>(),
        };
        if (finding.kind === "exact") cell.exactPairs++;
        else cell.nearPairs++;
        cell.findings.add(finding.id);
        cells.set(id, cell);
        listed.get(left.document)!.add(left.id);
        listed.get(right.document)!.add(right.id);
      }
  }
  return { cells, listed };
}

test("document-pair overview agrees with an independent full occurrence oracle for all three scopes, including opposite near-family orientations and same-document combinations", async () => {
  for (const scope of ["all", "cross-document", "within-document"] as const) {
    const analysis = await analyze(scope),
      before = JSON.stringify(analysis),
      expected = enumerate(analysis);
    const map = mapWritingOverlap(analysis, [], documents);
    assert.equal(map.cells.length, expected.cells.size);
    assert.equal(
      map.pairs,
      [...analysis.exact, ...analysis.near].reduce(
        (n, finding) => n + finding.pairs,
        0,
      ),
    );
    for (const cell of map.cells) {
      const oracle = expected.cells.get(cell.id)!;
      assert.ok(oracle);
      assert.equal(cell.exactPairs, oracle.exactPairs);
      assert.equal(cell.nearPairs, oracle.nearPairs);
      assert.deepEqual(new Set(cell.findings), oracle.findings);
      assert.equal(cell.unreviewed, cell.findings.length);
    }
    for (const document of map.documents)
      assert.equal(document.listed, expected.listed.get(document.id)!.size);
    assert.deepEqual(
      map.documents.find((document) => document.id === "d4"),
      {
        id: "d4",
        eligible: 0,
        listed: 0,
        findings: 0,
        unreviewed: 0,
        peers: [],
      },
    );
    assert.equal(JSON.stringify(analysis), before);
    assert.throws(() => map.cells[0]!.findings.push("forged"), TypeError);
  }
});

test("summary counts keep one finding per document/cell while all supported location-pair multiplicities remain visible; filters and sort cannot alter the global map", async () => {
  const analysis = await analyze(),
    id = analysis.exact[0]!.id;
  const map = mapWritingOverlap(
      analysis,
      [{ finding: id, verdict: "intentional" }],
      documents,
    ),
    before = JSON.stringify(map);
  for (const cell of map.cells) {
    assert.equal(cell.intentional, cell.findings.includes(id) ? 1 : 0);
    assert.equal(cell.unreviewed, cell.findings.length - cell.intentional);
    assert.equal(new Set(cell.findings).size, cell.findings.length);
  }
  const sorted = overlapMapCells(map, { document: "all", order: "pairs" });
  const counts = sorted.map((cell) => cell.exactPairs + cell.nearPairs);
  assert.deepEqual(
    counts,
    [...counts].sort((a, b) => b - a),
  );
  const filtered = overlapMapCells(map, {
    document: "d3",
    order: "unreviewed",
  });
  assert.ok(filtered.length);
  assert.ok(
    filtered.every((cell) => cell.left === "d3" || cell.right === "d3"),
  );
  assert.equal(JSON.stringify(map), before);
  assert.throws(() =>
    overlapMapCells(map, { document: "missing", order: "pairs" }),
  );
});

test("a selected document pair limits both the finding list and every location selector without guessing another document or silently excluding a near-family orientation", async () => {
  const analysis = await analyze(),
    map = mapWritingOverlap(analysis, [], documents),
    rows = overlapReviewRows(analysis, [], DEFAULT_OVERLAP_FILTER);
  for (const cell of map.cells) {
    const selected = overlapMapRows(analysis, map, cell.id, rows);
    assert.deepEqual(
      selected.map((row) => row.finding.id),
      cell.findings,
    );
    for (const row of selected) {
      const lefts = overlapMapOccurrences(
        analysis,
        map,
        cell.id,
        row.finding.id,
        "left",
      );
      assert.ok(lefts.length);
      for (const left of lefts) {
        const rights = overlapMapOccurrences(
          analysis,
          map,
          cell.id,
          row.finding.id,
          "right",
          left.id,
        );
        assert.ok(rights.length);
        for (const right of rights) {
          assert.notEqual(left.id, right.id);
          assert.deepEqual(
            [left.document, right.document].sort(),
            [cell.left, cell.right].sort(),
          );
        }
      }
    }
  }
  const unrelated = map.cells.find(
    (cell) => cell.left === "d2" && cell.right === "d3",
  )!;
  assert.throws(() =>
    overlapMapOccurrences(
      analysis,
      map,
      unrelated.id,
      unrelated.findings[0]!,
      "right",
      "d1:0",
    ),
  );
  const newAnalysis = await analyze();
  assert.throws(
    () => overlapMapRows(newAnalysis, map, map.cells[0]!.id, rows),
    /变化|失效/,
  );
  assert.throws(() => overlapMapRows(analysis, map, "p:d1:d4", rows), /文稿对/);
});

test("unknown/duplicated document IDs, invalid marks and inconsistent pair inventories fail atomically; high multiplicity never materializes occurrence pairs", async () => {
  const analysis = await analyze();
  for (const ids of [
    ["d1"],
    ["d1", "d1", "d3", "d4"],
    ["d1", "d2", "d3", "PRIVATE"],
  ])
    assert.throws(() => mapWritingOverlap(analysis, [], ids));
  assert.throws(() =>
    mapWritingOverlap(
      analysis,
      [{ finding: "missing", verdict: "intentional" }],
      documents,
    ),
  );
  const broken = structuredClone(analysis);
  broken.exact[0]!.pairs++;
  assert.throws(() => mapWritingOverlap(broken, [], documents), /配对|一致/);
  const items = Array<string>(200).fill(text),
    large = await analyzeWritingOverlap(
      await overlapFixture([items, items]),
      overlapPolicy({ scope: "all" }),
      new AbortController().signal,
      { pause },
    );
  const map = mapWritingOverlap(large, [], ["d1", "d2"]);
  assert.equal(map.cells.length, 3);
  assert.equal(map.pairs, (400 * 399) / 2);
  assert.equal(
    map.cells.find((cell) => cell.left !== cell.right)!.exactPairs,
    40000,
  );
  assert.deepEqual(
    map.documents.map((document) => document.listed),
    [200, 200],
  );
});
