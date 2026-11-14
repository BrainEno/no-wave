import type { Page, Route } from "@playwright/test";

export type BrowserNotice = { id: string; eventKey: string; payload: string; createdAt: string; readAt: string | null };
type RequestKind = "count" | "page" | "more" | "write";
export function browserNotices(count: number): BrowserNotice[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `10000000-0000-4000-8000-${(count - index).toString(16).padStart(12, "0")}`,
    eventKey: `browser-notification-${index}`,
    payload: JSON.stringify({ type: index % 2 ? "user.followed" : "article.commented", followerId: `writer-${index}`, slug: "notification-work" }),
    createdAt: "2026-11-01T00:00:00.000Z",
    readAt: null,
  }));
}
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

/** Socket-independent failure controls; the actual React application still owns all state. */
export async function interceptNotifications(page: Page, count = 3) {
  const items = browserNotices(count);
  const calls: { method: string; path: string; cursor: string | null }[] = [];
  const held: { kind: RequestKind; entered: ReturnType<typeof latch>; wait: ReturnType<typeof latch>; finished: ReturnType<typeof latch> }[] = [];
  let countStatus = 200;
  let writeStatus = 200;
  let listStatus = 200;
  let countPayload: unknown;
  async function send(route: Route, kind: RequestKind, status: number, data: unknown) {
    // Capture at request time, before later mutations can change the fixture.
    const body = JSON.stringify(data);
    const index = held.findIndex((response) => response.kind === kind);
    const response = index === -1 ? undefined : held.splice(index, 1)[0];
    if (response) { response.entered.release(); await response.wait.promise; }
    try { await route.fulfill({ status, contentType: "application/json", body }); }
    finally { response?.finished.release(); }
  }
  await page.route((url) => url.pathname.startsWith("/api/authoring/notifications"), async (route) => {
    const url = new URL(route.request().url());
    calls.push({ method: route.request().method(), path: url.pathname, cursor: url.searchParams.get("cursor") });
    if (url.pathname.endsWith("/unread-count")) return send(route, "count", countStatus, countPayload ?? { data: items.filter((item) => item.readAt === null).length });
    if (url.pathname.endsWith("/read-all")) {
      if (writeStatus !== 200) return send(route, "write", writeStatus, { error: { message: "synthetic-private-upstream-detail" } });
      const unread = items.filter((item) => item.readAt === null);
      for (const item of unread) item.readAt = "2026-11-02T00:00:00.000Z";
      return send(route, "write", 200, { data: unread.length });
    }
    if (url.pathname.endsWith("/read")) {
      if (writeStatus !== 200) return send(route, "write", writeStatus, { error: { message: "synthetic-private-upstream-detail" } });
      const item = items.find((entry) => url.pathname.endsWith(`/${entry.id}/read`));
      if (!item) return send(route, "write", 404, { error: { code: "NOT_FOUND" } });
      item.readAt = "2026-11-02T00:00:00.000Z";
      return send(route, "write", 200, { data: item });
    }
    const cursor = url.searchParams.get("cursor");
    const kind = cursor ? "more" : "page";
    if (listStatus !== 200) return send(route, kind, listStatus, { error: { message: "synthetic-private-upstream-detail" } });
    const id = cursor ? Buffer.from(cursor, "base64url").toString("utf8").split("|")[1] : null;
    const start = id ? items.findIndex((item) => item.id === id) + 1 : 0;
    return send(route, kind, 200, { data: items.slice(start, start + 50) });
  });
  return {
    items, calls,
    failCounts: (status: number) => { countStatus = status; },
    countBody: (payload: unknown) => { countPayload = payload; },
    failWrites: (status: number) => { writeStatus = status; },
    failLists: (status: number) => { listStatus = status; },
    holdNext(kind: RequestKind) {
      const response = { kind, entered: latch(), wait: latch(), finished: latch() };
      held.push(response);
      return { started: response.entered.promise, release: response.wait.release, finished: response.finished.promise };
    },
  };
}
