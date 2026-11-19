import assert from "node:assert/strict";
import test from "node:test";
import { createNotionJobPoller, notionJobStatusEtag } from "./notion-job-poll.ts";
import type { NotionJobStatus } from "./notion-durable-jobs.ts";
import { randomUUID } from "node:crypto";
const status = (): NotionJobStatus => ({ id: randomUUID(), state: "queued", completed: 0, total: 1,
  createdAt: 1, updatedAt: 1, expiresAt: Date.now() + 10000, retainUntil: Date.now() + 20000, report: null, recovery: "none" });
const options = { intervalMs: 5, readTimeoutMs: 100, maxGroups: 2, maxWaiters: 2 };
test("conditional status wait coalesces reads for the same owner/job and wakes on progress", async t => {
  let current = status(), calls = 0;
  const poller = createNotionJobPoller({ ...options, read: async () => { calls++; return current; } });
  t.after(poller.close);
  const input = { actorId: "author", jobId: current.id, etag: notionJobStatusEtag(current), waitMs: 200 };
  const a = poller.wait(input), b = poller.wait(input);
  await new Promise(resolve => setTimeout(resolve, 10));
  current = { ...current, state: "running", updatedAt: 2 };
  const [one, two] = await Promise.all([a, b]);
  assert.equal(one.status?.state, "running");
  assert.equal(one.notModified, false);
  assert.deepEqual(one, two);
  assert.ok(calls < 8, `coalesced calls: ${calls}`);
});
test("owner identity is part of coalescing, with missing jobs indistinguishable from foreign jobs", async t => {
  const job = status();
  const poller = createNotionJobPoller({ ...options, read: async ({ actorId }) => actorId === "author" ? job : null });
  t.after(poller.close);
  const own = poller.wait({ actorId: "author", jobId: job.id, waitMs: 0 });
  const foreign = poller.wait({ actorId: "foreign", jobId: job.id, waitMs: 0 });
  assert.equal((await own).status?.id, job.id);
  assert.equal((await foreign).status, null);
});
test("timed-out or disconnected subscribers do not free a physical query or launch another one", async t => {
  let release!: (value: NotionJobStatus) => void, calls = 0;
  const held = new Promise<NotionJobStatus>(resolve => { release = resolve; });
  const job = status();
  const poller = createNotionJobPoller({ ...options, maxGroups: 1, read: async () => { calls++; return held; } });
  t.after(poller.close);
  const first = poller.wait({ actorId: "author", jobId: job.id, waitMs: 0 });
  await assert.rejects(first, /unavailable/);
  await assert.rejects(poller.wait({ actorId: "other", jobId: randomUUID(), waitMs: 0 }), /capacity/);
  const controller = new AbortController();
  const joined = poller.wait({ actorId: "author", jobId: job.id, waitMs: 0, signal: controller.signal });
  controller.abort();
  await assert.rejects(joined);
  assert.equal(calls, 1);
  release(job);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await poller.wait({ actorId: "other", jobId: job.id, waitMs: 0 })).status?.id, job.id);
});
test("terminal or unchanged responses are conditional, and a close rejects outstanding waits", async () => {
  const job = { ...status(), state: "succeeded" as const, completed: 1 };
  const poller = createNotionJobPoller({ ...options, read: async () => job });
  const result = await poller.wait({ actorId: "author", jobId: job.id, etag: notionJobStatusEtag(job), waitMs: 200 });
  assert.equal(result.notModified, true);
  poller.close();
  await assert.rejects(poller.wait({ actorId: "author", jobId: job.id, waitMs: 0 }), /capacity/);
});

test("status wait groups share a separate physical-query cap, including abandoned reads and queued cancellation", async () => {
  let release!: () => void, calls = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const first = status(), second = status(), third = status();
  const poller = createNotionJobPoller({ ...options, maxReads: 1, readTimeoutMs: 40,
    read: async ({ jobId }) => { calls++; if (jobId === first.id) await held; return { ...third, id: jobId }; } });
  try {
    const a = poller.wait({ actorId: "author", jobId: first.id, waitMs: 0 });
    const b = poller.wait({ actorId: "author", jobId: second.id, waitMs: 0 });
    const results = await Promise.allSettled([a, b]);
    assert.ok(results.every(result => result.status === "rejected"));
    assert.equal(calls, 1, "a subscriber deadline must not manufacture another physical slot");
    const c = poller.wait({ actorId: "author", jobId: third.id, waitMs: 200 });
    release();
    assert.equal((await c).status?.id, third.id);
    assert.equal(calls, 2, "the cancelled queued read never starts later");
  } finally { release(); poller.close(); }
});

test("shutdown rejects subscribers immediately but drain awaits abandoned physical reads", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const job = status();
  const poller = createNotionJobPoller({ ...options, read: async () => { await held; return job; } });
  const waiting = poller.wait({ actorId: "author", jobId: job.id });
  poller.close();
  await assert.rejects(waiting, /unavailable/);
  let drained = false;
  try {
    const settled = poller.drain().then(() => { drained = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(drained, false, "no HTTP subscriber does not mean no database query");
    release();
    await settled;
    assert.equal(drained, true);
    await poller.drain();
  } finally { release(); }
});
