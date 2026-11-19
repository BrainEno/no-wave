import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { notionJobStatus, emptyNotionJobSummary } from "./notion-durable-jobs.ts";
const row = () => ({ id: randomUUID(), state: "queued", completed: 0, total: 1,
  created_at: "1000", updated_at: "1001", expires_at: "2000", retain_until: "3000", report: null });

test("a stored status must be finite, internally consistent and content-free before being polled", () => {
  const queued = row();
  assert.equal(notionJobStatus(queued).expiresAt, 2000);
  for (const patch of [
    { total: 201 }, { total: -1 }, { total: "1 manuscript secret" }, { completed: 2 },
    { completed: 0.5 }, { expires_at: "9".repeat(30) }, { created_at: NaN }, { updated_at: null },
    { state: "succeeded" }, { state: "queued", completed: 1 },
    { state: "failed", completed: 1, report: JSON.stringify({ summary: emptyNotionJobSummary(), pages: [] }) },
  ]) assert.throws(() => notionJobStatus({ ...queued, ...patch }), error => !String(error).includes("manuscript secret"));
  const success = notionJobStatus({ ...queued, state: "succeeded", completed: 1,
    report: JSON.stringify({ summary: { create: 1, update: 0, skip: 0, refused: 0, failed: 0 },
      pages: [{ ordinal: 1, action: "create", locale: "en", articleId: randomUUID(), issueCodes: [], sourceTitle: "do not retain" }], rawError: "do not retain" }) });
  assert.equal(success.state, "succeeded");
  assert.doesNotMatch(JSON.stringify(success), /do not retain|sourceTitle|rawError/);
});
