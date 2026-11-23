import assert from "node:assert/strict";
import { test } from "node:test";
import { createWritingBackup } from "./writing-backup.ts";
import {
  applyRecoveryPreview,
  parseRecoveryBase,
  parseRecoveryControl,
  parseRecoveryEntry,
  recoveryPreview,
  WritingRecoveryFault,
  type RecoveryEntry,
} from "./writing-recovery-model.ts";
import type { WritingDraft } from "./writing-session.ts";

const id = "00000000-0000-4000-8000-000000000001",
  epoch = "00000000-0000-4000-8000-000000000002";
const now = 1_800_000_000_000;
const draft = (): WritingDraft => ({
  title: "没有上传的海风",
  summary: "",
  locale: "zh-CN",
  workType: "other",
  editorState: {
    root: {
      type: "root",
      version: 1,
      children: [
        {
          type: "paragraph",
          version: 1,
          children: [{ type: "text", version: 1, text: "尚未保存", format: 0 }],
        },
      ],
    },
  },
});
function entry(): RecoveryEntry {
  return {
    version: 1,
    id,
    actor: "author-a",
    epoch,
    writer: id,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    base: { articleId: null, locale: "zh-CN", revision: null },
    backup: createWritingBackup(draft(), new Date(now)),
    outcomeUnknown: false,
  };
}
const fault = (code: string) => (error: unknown) =>
  error instanceof WritingRecoveryFault && error.code === code;

test("recovery envelopes reject credentials, unknown fields, corrupt snapshots and forged metadata instead of hydrating partial text", () => {
  const good = entry();
  assert.deepEqual(parseRecoveryEntry(good), good);
  for (const patch of [
    { token: "synthetic-only" },
    { revision: 0 },
    { outcomeUnknown: "false" },
    { actor: " author-a" },
    { epoch: "../a" },
    { updatedAt: now - 1 },
    { backup: "{}" },
    { base: { ...good.base, signingKey: "not-accepted" } },
  ]) {
    assert.throws(
      () => parseRecoveryEntry({ ...good, ...patch }),
      fault("invalid"),
    );
  }
  const detached = parseRecoveryEntry(good);
  detached.base.locale = "en";
  assert.equal(good.base.locale, "zh-CN");
});

test("control and source coordinates are strict local fences, never an inferred login identity", () => {
  const control = {
    version: 1,
    epoch,
    actor: "author-a",
    enabled: true,
    serial: 0,
  };
  assert.deepEqual(parseRecoveryControl(control), control);
  for (const patch of [
    { enabled: true, actor: null },
    { serial: -1 },
    { serial: Number.MAX_SAFE_INTEGER + 1 },
    { extra: true },
  ])
    assert.throws(
      () => parseRecoveryControl({ ...control, ...patch }),
      fault("invalid"),
    );
  for (const base of [
    { articleId: null, locale: "zh-CN", revision: "1" },
    { articleId: id, locale: "bad", revision: null },
    { articleId: id, locale: "en", revision: "01" },
    { articleId: id, locale: "en", revision: "9223372036854775808" },
  ])
    assert.throws(() => parseRecoveryBase(base), fault("invalid"));
});

test("manual restore binds exact current content and target, preserves server identity outside the draft and needs explicit cross-base consent", () => {
  const old = entry(),
    current = draft();
  current.title = "当前编辑";
  const base = { articleId: epoch, locale: "zh-CN", revision: "9" };
  const plan = recoveryPreview(old, current, base);
  assert.equal(plan.differentBase, true);
  assert.throws(
    () =>
      applyRecoveryPreview(plan, current, base, ["title"], {
        differentBase: false,
        remoteImages: false,
      }),
    fault("stale"),
  );
  const recovered = applyRecoveryPreview(plan, current, base, ["title"], {
    differentBase: true,
    remoteImages: false,
  });
  assert.equal(recovered.title, old && draft().title);
  assert.equal("articleId" in recovered, false);
  assert.equal(base.revision, "9");
  assert.throws(
    () =>
      applyRecoveryPreview(
        plan,
        { ...current, summary: "输入途中改变" },
        base,
        ["title"],
        { differentBase: true, remoteImages: false },
      ),
    fault("stale"),
  );
  assert.throws(
    () =>
      applyRecoveryPreview(
        plan,
        current,
        { ...base, revision: "10" },
        ["title"],
        { differentBase: true, remoteImages: false },
      ),
    fault("stale"),
  );
});

test("recovery previews never load remote images until consent and never clear an ambiguous server outcome", () => {
  const old = entry(),
    incoming = draft();
  incoming.editorState!.root.children.push({
    type: "image",
    version: 1,
    src: "https://example.test/private-image",
    alt: "海风",
    caption: "",
  });
  old.backup = createWritingBackup(incoming, new Date(now));
  old.outcomeUnknown = true;
  const current = draft(),
    plan = recoveryPreview(old, current, old.base);
  assert.equal(plan.outcomeUnknown, true);
  assert.throws(
    () =>
      applyRecoveryPreview(plan, current, old.base, ["editorState"], {
        differentBase: true,
        remoteImages: false,
      }),
    fault("remote_consent"),
  );
  assert.equal(
    applyRecoveryPreview(plan, current, old.base, ["editorState"], {
      differentBase: true,
      remoteImages: true,
    }).editorState!.root.children.length,
    2,
  );
  assert.equal(plan.outcomeUnknown, true);
});
