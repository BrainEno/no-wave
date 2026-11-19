import assert from "node:assert/strict";
import { test } from "node:test";
import { createWritingBackup, parseWritingBackup } from "./writing-backup.ts";
import { collectionChecksum } from "./writing-collection.ts";
import { analyzeWritingMerge } from "./writing-merge.ts";
import {
  createWritingMergePlan,
  MERGE_PLAN_BYTE_LIMIT,
  previewWritingMergePlan,
} from "./writing-merge-plan.ts";

const now = new Date("2026-11-12T00:00:00.000Z");
const backup = (body: string) =>
  parseWritingBackup(
    createWritingBackup(
      {
        title: "PRIVATE_TITLE",
        summary: "PRIVATE_SUMMARY",
        locale: "zh-CN",
        workType: "essay",
        editorState: {
          root: {
            type: "root",
            version: 1,
            children: [
              {
                type: "paragraph",
                version: 1,
                children: [{ type: "text", version: 1, text: body }],
              },
            ],
          },
        },
      },
      now,
    ),
  );
async function analysis() {
  return analyzeWritingMerge({
    base: backup("PRIVATE_BASE"),
    current: backup("PRIVATE_CURRENT"),
    incoming: backup("PRIVATE_INCOMING"),
  });
}

async function resign(raw: Record<string, unknown>): Promise<string> {
  const { digest: _digest, ...payload } = raw;
  return JSON.stringify({
    ...payload,
    digest: await collectionChecksum(payload),
  });
}

test("decision plans roundtrip closed-set references but omit titles, body, filenames and identities", async () => {
  const source = await analysis();
  const unit = source.units.find((item) => item.status === "conflict")!;
  const decisions = [{ unit: unit.id, choice: "current" as const }];
  const created = await createWritingMergePlan(source, decisions, now);
  for (const forbidden of [
    "PRIVATE_",
    "filename",
    "actor",
    "revision",
    "token",
    "editorState",
  ])
    assert.ok(!created.text.includes(forbidden));
  const preview = await previewWritingMergePlan(created.text, source);
  assert.deepEqual(preview.decisions, decisions);
  assert.equal(preview.analysisKey, source.key);
  assert.ok(
    new TextEncoder().encode(created.text).byteLength < MERGE_PLAN_BYTE_LIMIT,
  );
});

test("digest damage, extra identity, unknown choices and duplicate references fail without partial admission", async () => {
  const source = await analysis();
  const decision = { unit: source.units[0]!.id, choice: "base" as const };
  const created = await createWritingMergePlan(source, [decision], now);
  await assert.rejects(
    previewWritingMergePlan(
      created.text.replace('"base"', '"current"'),
      source,
    ),
    /摘要|校验|来源/,
  );
  const raw = JSON.parse(created.text) as Record<string, unknown>;
  await assert.rejects(
    previewWritingMergePlan(await resign({ ...raw, actor: "forged" }), source),
    /字段|结构/,
  );
  await assert.rejects(
    previewWritingMergePlan(
      await resign({ ...raw, decisions: [decision, decision] }),
      source,
    ),
    /重复/,
  );
  await assert.rejects(
    previewWritingMergePlan(
      await resign({
        ...raw,
        decisions: [{ unit: "body:999:999", choice: "current" }],
      }),
      source,
    ),
    /取舍|条目/,
  );
  await assert.rejects(
    previewWritingMergePlan(
      await resign({ ...raw, decisions: [{ ...decision, choice: "both" }] }),
      source,
    ),
    /取舍|选项/,
  );
});

test("a plan binds every source role, exact timestamp and algorithm, not just matching filenames or prose", async () => {
  const source = await analysis(),
    created = await createWritingMergePlan(source, [], now);
  const changed = await analyzeWritingMerge({
    base: backup("PRIVATE_BASE"),
    current: backup("PRIVATE_INCOMING"),
    incoming: backup("PRIVATE_CURRENT"),
  });
  await assert.rejects(
    previewWritingMergePlan(created.text, changed),
    /来源|过期/,
  );
  const raw = JSON.parse(created.text) as Record<string, unknown>;
  await assert.rejects(
    previewWritingMergePlan(
      await resign({ ...raw, algorithm: "fuzzy-v99" }),
      source,
    ),
    /版本|算法/,
  );
  await assert.rejects(
    previewWritingMergePlan(
      await resign({ ...raw, createdAt: "2026-02-30T00:00:00.000Z" }),
      source,
    ),
    /时间/,
  );
});

test("duplicate escaped JSON names, excessive bytes and invalid prototypes are rejected before preview", async () => {
  const source = await analysis(),
    created = await createWritingMergePlan(source, [], now);
  await assert.rejects(
    previewWritingMergePlan(
      created.text.replace('"version": 1', '"version": 2, "ver\\u0073ion": 1'),
      source,
    ),
    /重复|歧义/,
  );
  await assert.rejects(
    previewWritingMergePlan(" ".repeat(MERGE_PLAN_BYTE_LIMIT + 1), source),
    /64 KiB/,
  );
  await assert.rejects(
    previewWritingMergePlan(
      created.text.replace(
        '"decisions": []',
        '"decisions": [], "__proto__": {}',
      ),
      source,
    ),
    /危险|JSON|字段/,
  );
});

test("plan import is only a preview, and cancellation never returns a usable decision set", async () => {
  const source = await analysis(),
    before = structuredClone(source);
  const created = await createWritingMergePlan(source, [], now);
  await previewWritingMergePlan(created.text, source);
  assert.deepEqual(source, before);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(createWritingMergePlan(source, [], now, abort.signal), {
    name: "AbortError",
  });
  await assert.rejects(
    previewWritingMergePlan(created.text, source, abort.signal),
    { name: "AbortError" },
  );
});
