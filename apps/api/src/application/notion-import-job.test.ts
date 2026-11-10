import { strict as assert } from "node:assert";
import { test } from "node:test";
import { advanceNotionImportJob, claimNotionImportJob, createNotionImportJob, finishNotionImportJob, visibleNotionImportJob } from "./notion-import-job.ts";

test("jobs expose status only to their owner and never expose worker tokens", () => {
  const job = claimNotionImportJob(createNotionImportJob("job", "owner", 2), "secret", 10, 10)!;
  assert.equal(visibleNotionImportJob(job, "other"), null);
  assert.equal(visibleNotionImportJob(job, "owner")?.leaseToken, null);
});

test("expired workers are fenced out after a job is reclaimed", () => {
  const first = claimNotionImportJob(createNotionImportJob("job", "owner", 2), "first", 10, 10)!;
  assert.equal(claimNotionImportJob(first, "second", 19, 10), null);
  assert.equal(advanceNotionImportJob(first, "first", 20, 1, 10), null);
  assert.throws(() => claimNotionImportJob(first, "first", 20, 10));
  const second = claimNotionImportJob(first, "second", 20, 10)!;
  assert.equal(advanceNotionImportJob(second, "first", 21, 1, 10), null);
  assert.equal(finishNotionImportJob(second, "first", 21, "failed"), null);
  assert.equal(second.version, 2);
});

test("progress is monotonic, bounded and success requires completion", () => {
  const claimed = claimNotionImportJob(createNotionImportJob("job", "owner", 2), "token", 0, 10)!;
  const progressed = advanceNotionImportJob(claimed, "token", 1, 1, 10)!;
  assert.throws(() => advanceNotionImportJob(progressed, "token", 2, 0, 10));
  assert.throws(() => advanceNotionImportJob(progressed, "token", 2, 3, 10));
  assert.throws(() => finishNotionImportJob(progressed, "token", 2, "succeeded"));
  const complete = advanceNotionImportJob(progressed, "token", 2, 2, 10)!;
  const done = finishNotionImportJob(complete, "token", 3, "succeeded")!;
  assert.equal(done.completed, 2);
  assert.equal(done.leaseToken, null);
  assert.equal(claimNotionImportJob(done, "new", 100, 10), null);
  assert.equal(advanceNotionImportJob(done, "token", 3, 2, 10), null);
});

test("invalid input is rejected and failures can finish with partial progress", () => {
  assert.throws(() => createNotionImportJob("", "owner", 0));
  assert.throws(() => createNotionImportJob("job", "owner", -1));
  const job = createNotionImportJob("job", "owner", 1);
  assert.throws(() => claimNotionImportJob(job, "", 0, 1));
  assert.throws(() => claimNotionImportJob(job, "token", 0, 0));
  const claimed = claimNotionImportJob(job, "token", 0, 10)!;
  assert.equal(finishNotionImportJob(claimed, "token", 1, "failed")?.state, "failed");
});
