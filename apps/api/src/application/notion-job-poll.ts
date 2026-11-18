import { performance } from "node:perf_hooks";
import { notionJobHash, NotionJobError, assertNotionJobOwner, validNotionJobId, type NotionJobStatus } from "./notion-durable-jobs.ts";

export const NOTION_JOB_ETAG_PATTERN = /^"[A-Za-z0-9_-]{43}"$/;
export function notionJobStatusEtag(status: NotionJobStatus): string {
  return `"${Buffer.from(notionJobHash(JSON.stringify(status)), "hex").toString("base64url")}"`;
}
type Result = { status: NotionJobStatus | null; etag: string | null; notModified: boolean };
type Waiter = {
  etag?: string; waitMs: number; deadline: number; observed: boolean;
  timer?: ReturnType<typeof setTimeout>; detach(): void;
  resolve(result: Result): void; reject(error: unknown): void;
};
type Group = {
  key: string; actorId: string; jobId: string; waiters: Set<Waiter>; reading: boolean; queued: boolean;
  latest?: { status: NotionJobStatus | null; etag: string | null }; timer?: ReturnType<typeof setTimeout>;
};

/** Owner-scoped single-flight reads. A vanished HTTP client never releases a physical query. */
export function createNotionJobPoller({ read, maxGroups = 16, maxWaiters = 4, maxReads = 2, intervalMs = 1000, readTimeoutMs = 2000 }: {
  read(input: { actorId: string; jobId: string }): Promise<NotionJobStatus | null> | NotionJobStatus | null;
  maxGroups?: number; maxWaiters?: number; maxReads?: number; intervalMs?: number; readTimeoutMs?: number;
}) {
  for (const [value, minimum, maximum] of [[maxGroups, 1, 32], [maxWaiters, 1, 8], [maxReads, 1, 4], [intervalMs, 1, 5000], [readTimeoutMs, 1, 5000]]) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError("Invalid import status poll bounds.");
  }
  const groups = new Map<string, Group>();
  const queued: Group[] = [];
  let activeReads = 0, pumping = false, closed = false;
  let drained: Promise<void> | undefined, resolveDrain: (() => void) | undefined;
  function retire(group: Group): void {
    if (group.waiters.size) return;
    clearTimeout(group.timer);
    const index = queued.indexOf(group);
    if (index >= 0) queued.splice(index, 1);
    group.queued = false;
    // Keep a stalled physical read accounted for, even if every waiter timed out.
    if (!group.reading) groups.delete(group.key);
  }
  function finish(group: Group, waiter: Waiter, error?: unknown): void {
    if (!group.waiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    waiter.detach();
    if (error) waiter.reject(error);
    else {
      const latest = group.latest!;
      waiter.resolve({ ...latest, notModified: latest.etag !== null && latest.etag === waiter.etag });
    }
    retire(group);
  }
  function expire(group: Group, waiter: Waiter): void {
    const remaining = waiter.deadline - performance.now();
    if (remaining > 0) { waiter.timer = setTimeout(() => expire(group, waiter), Math.ceil(remaining)); return; }
    // An old checkpoint is not evidence of "unchanged" while its next read is stuck.
    finish(group, waiter, !waiter.observed || group.reading || group.queued || !group.latest ? new NotionJobError("IMPORT_STATUS_UNAVAILABLE") : undefined);
  }
  function schedule(group: Group): void {
    if (closed || !group.waiters.size) { retire(group); return; }
    const earliest = Math.min(...[...group.waiters].map(waiter => waiter.deadline));
    const delay = Math.max(1, Math.min(intervalMs, Math.ceil(earliest - performance.now())));
    group.timer = setTimeout(() => requestRead(group), delay);
  }
  function requestRead(group: Group): void {
    if (closed || group.reading || group.queued || !group.waiters.size) return;
    clearTimeout(group.timer);
    group.queued = true;
    queued.push(group);
    pump();
  }
  function pump(): void {
    if (pumping || closed) return;
    pumping = true;
    try {
      while (activeReads < maxReads && queued.length) {
        const group = queued.shift()!;
        for (const waiter of [...group.waiters]) if (performance.now() >= waiter.deadline) expire(group, waiter);
        group.queued = false;
        if (!group.waiters.size) { retire(group); continue; }
        group.reading = true;
        activeReads += 1;
        void readGroup(group);
      }
    } finally { pumping = false; }
  }
  async function readGroup(group: Group): Promise<void> {
    try {
      const status = await read({ actorId: group.actorId, jobId: group.jobId });
      if (status && status.id !== group.jobId) throw new Error("Invalid import status projection.");
      group.latest = { status, etag: status ? notionJobStatusEtag(status) : null };
      for (const waiter of [...group.waiters]) {
        waiter.observed = true;
        if (!status || waiter.waitMs === 0 || waiter.etag !== group.latest.etag ||
            (status.state !== "queued" && status.state !== "running") || performance.now() >= waiter.deadline) finish(group, waiter);
      }
    } catch {
      for (const waiter of [...group.waiters]) finish(group, waiter, new NotionJobError("IMPORT_STATUS_UNAVAILABLE"));
    } finally {
      group.reading = false;
      activeReads -= 1;
      if (closed && activeReads === 0) resolveDrain?.();
      if (group.waiters.size) schedule(group);
      else retire(group);
      pump();
    }
  }
  const poller = Object.freeze({
    wait(input: { actorId: string; jobId: string; etag?: string; waitMs?: number; signal?: AbortSignal }): Promise<Result> {
      const waitMs = input.waitMs ?? 0;
      try {
        assertNotionJobOwner(input.actorId);
        if (!validNotionJobId(input.jobId) || !Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 5000 ||
            (input.etag !== undefined && !NOTION_JOB_ETAG_PATTERN.test(input.etag))) throw new NotionJobError("IMPORT_JOB_INPUT_INVALID");
        if (input.signal?.aborted) throw new NotionJobError("IMPORT_STATUS_UNAVAILABLE");
        if (closed) throw new NotionJobError("IMPORT_STATUS_BUSY");
        const key = JSON.stringify([input.actorId, input.jobId]);
        let group = groups.get(key);
        if (!group) {
          if (groups.size >= maxGroups) throw new NotionJobError("IMPORT_STATUS_BUSY");
          group = { key, actorId: input.actorId, jobId: input.jobId, waiters: new Set(), reading: false, queued: false };
          groups.set(key, group);
        }
        if (group.waiters.size >= maxWaiters) throw new NotionJobError("IMPORT_STATUS_BUSY");
        const owned = group;
        return new Promise<Result>((resolve, reject) => {
          const onAbort = () => finish(owned, waiter, new NotionJobError("IMPORT_STATUS_UNAVAILABLE"));
          const waiter: Waiter = { etag: input.etag, waitMs, deadline: performance.now() + (waitMs || readTimeoutMs),
            observed: false, resolve, reject, detach: () => input.signal?.removeEventListener("abort", onAbort) };
          owned.waiters.add(waiter);
          waiter.timer = setTimeout(() => expire(owned, waiter), (waitMs || readTimeoutMs));
          input.signal?.addEventListener("abort", onAbort, { once: true });
          if (input.signal?.aborted) onAbort();
          else requestRead(owned);
        });
      } catch (error) { return Promise.reject(error); }
    },
    drain(): Promise<void> {
      poller.close();
      if (!activeReads) return Promise.resolve();
      drained ??= new Promise<void>(resolve => { resolveDrain = resolve; });
      return drained;
    },
    close(): void {
      if (closed) return;
      closed = true;
      for (const group of groups.values()) {
        clearTimeout(group.timer);
        for (const waiter of [...group.waiters]) finish(group, waiter, new NotionJobError("IMPORT_STATUS_UNAVAILABLE"));
      }
    },
  });
  return poller;
}
export type NotionJobPoller = ReturnType<typeof createNotionJobPoller>;
