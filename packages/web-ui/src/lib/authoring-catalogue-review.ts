import { AUTHORING_EXPECTED_ACTOR_HEADER, isRecord, parseRetryAfterSeconds } from "@bot-thk/web-http";
import { apiErrorCode } from "./api-error.ts";
import { CATALOGUE_SELECTION_LIMIT, catalogueEntryKey, readCatalogueEntry, type CatalogueEntry } from "./authoring-catalogue.ts";
import { readCatalogueEditions } from "./authoring-catalogue-versions.ts";

export const CATALOGUE_REVIEW_WORK_LIMIT = 20;
export const CATALOGUE_REVIEW_FIELDS = ["title", "summary", "slug", "status", "workType", "createdAt", "updatedAt", "deletedAt"] as const;
type ReviewField = typeof CATALOGUE_REVIEW_FIELDS[number];
export type CatalogueReviewDifference = {
  before: CatalogueEntry; current: CatalogueEntry | null; kind: "unchanged" | "changed" | "unconfirmed"; fields: ReviewField[];
};
export type CatalogueReviewWork = {
  id: string; title: string; status: "waiting" | "checking" | "ready" | "unavailable" | "failed";
  editions: CatalogueEntry[]; differences: CatalogueReviewDifference[]; checkedAt: string | null; error: string;
};
export type CatalogueReviewInput = { actor: string; scope: "active" | "trash"; selected: readonly CatalogueEntry[] };
type CatalogueReviewPlan = CatalogueReviewInput & { fingerprint: string; works: CatalogueReviewWork[] };
export type CatalogueReviewState = {
  status: "idle" | "running" | "complete" | "partial" | "cancelled" | "invalid" | "limited" | "unauthenticated" | "account-changed";
  plan: CatalogueReviewPlan | null; works: CatalogueReviewWork[]; retryAt: number; error: string;
};
type ReviewFetch = (url: string, init: RequestInit) => Promise<Response>;
type RefusedSession = "unauthenticated" | "account-changed";

/** Order-independent, memory-only witness of the exact chosen metadata, not a persistence or authorization key. */
export function catalogueSelectionFingerprint(selected: readonly CatalogueEntry[]): string {
  const rows = selected.map(entry => [entry.id, entry.locale, ...CATALOGUE_REVIEW_FIELDS.map(field => entry[field])]);
  rows.sort((left, right) => String(left[0]).localeCompare(String(right[0])) || String(left[1]).localeCompare(String(right[1])));
  return JSON.stringify(rows);
}

export function planCatalogueReview(input: CatalogueReviewInput): CatalogueReviewPlan {
  if (!input.actor || input.actor.length > 300 || input.actor.trim() !== input.actor || /[\u0000-\u001f\u007f\p{Cs}]/u.test(input.actor)) throw new Error("请先确认目录账户。");
  if (input.scope !== "active" && input.scope !== "trash") throw new Error("请选择明确的目录范围。");
  if (!input.selected.length || input.selected.length > CATALOGUE_SELECTION_LIMIT) throw new Error("请先选择 1–100 个语言版本。");
  const selected = input.selected.map(readCatalogueEntry);
  if (new Set(selected.map(catalogueEntryKey)).size !== selected.length) throw new Error("所选语言版本重复，请重新选择。");
  if (selected.some(entry => (entry.deletedAt !== null) !== (input.scope === "trash"))) throw new Error("所选版本不属于当前在用/回收站范围。");
  const byWork = new Map<string, CatalogueReviewWork>();
  for (const entry of selected) {
    if (!byWork.has(entry.id)) byWork.set(entry.id, { id: entry.id, title: entry.title, status: "waiting", editions: [], differences: [], checkedAt: null, error: "" });
  }
  if (byWork.size > CATALOGUE_REVIEW_WORK_LIMIT) throw new Error("每次最多核对 20 部独立作品；请减少选择后分批核对。普通 CSV 导出仍支持 100 个版本。");
  return { actor: input.actor, scope: input.scope, selected, fingerprint: catalogueSelectionFingerprint(selected), works: [...byWork.values()] };
}

function compareWork(plan: CatalogueReviewPlan, id: string, editions: CatalogueEntry[]): CatalogueReviewDifference[] {
  return plan.selected.filter(entry => entry.id === id).map(before => {
    const current = editions.find(entry => entry.locale === before.locale) ?? null;
    if (!current) return { before, current, kind: "unconfirmed", fields: [] };
    const fields = CATALOGUE_REVIEW_FIELDS.filter(field => before[field] !== current[field]);
    return { before, current, kind: fields.length ? "changed" : "unchanged", fields };
  });
}

/** Applying this read result is a separate user decision; partial work must never replace selection. */
export function reviewedCatalogueSelection(state: CatalogueReviewState): CatalogueEntry[] {
  if (state.status !== "complete" || !state.plan || state.works.length !== state.plan.works.length) throw new Error("核对尚未完整成功，不能替换所选索引。");
  const current = new Map<string, CatalogueEntry>();
  for (const work of state.works) {
    if (work.status !== "ready" || !work.checkedAt) throw new Error("仍有作品未能确认，请保留原选择并重新核对。");
    for (const difference of work.differences) {
      if (!difference.current || difference.kind === "unconfirmed") throw new Error("有语言版本未能确认，请重新选择；不会自动移除。");
      current.set(catalogueEntryKey(difference.before), readCatalogueEntry(difference.current));
    }
  }
  return state.plan.selected.map(before => {
    const entry = current.get(catalogueEntryKey(before));
    if (!entry || entry.id !== before.id || entry.locale !== before.locale) throw new Error("核对结果与原选择不一致，未应用。");
    return entry;
  });
}

/** A bounded serial read queue: one owner-checked request per work; no body reads, writes or automatic retries. */
export class CatalogueReviewController {
  private state: CatalogueReviewState = { status: "idle", plan: null, works: [], retryAt: 0, error: "" };
  private listeners = new Set<() => void>();
  private generation = 0;
  private abort: AbortController | null = null;
  private fetcher: ReviewFetch;
  private now: () => number;
  private onSessionRefused: (reason: RefusedSession) => void;
  private onRateLimited: (deadline: number) => void;

  constructor(fetcher: ReviewFetch = (url, init) => fetch(url, init), now: () => number = Date.now, onSessionRefused: (reason: RefusedSession) => void = () => {}, onRateLimited: (deadline: number) => void = () => {}) {
    this.fetcher = fetcher;
    this.now = now;
    this.onSessionRefused = onSessionRefused;
    this.onRateLimited = onRateLimited;
  }
  getSnapshot = (): CatalogueReviewState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private publish(patch: Partial<CatalogueReviewState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private updateWork(id: string, patch: Partial<CatalogueReviewWork>) {
    this.publish({ works: this.state.works.map(work => work.id === id ? { ...work, ...patch } : work) });
  }
  private invalidate() {
    this.generation++;
    this.abort?.abort();
  }
  configure(input: CatalogueReviewInput) {
    this.invalidate();
    try {
      const plan = planCatalogueReview(input);
      this.publish({ status: "idle", plan, works: plan.works, error: "" });
    } catch (error) {
      this.publish({ status: "invalid", plan: null, works: [], error: error instanceof Error ? error.message : "无法核对当前选择。" });
    }
  }
  cancel() {
    this.invalidate();
    if (this.state.status === "running") this.publish({ status: "cancelled", error: "核对已停止；已读片段仅供参考，没有替换选择。可手动重新核对。" });
  }
  private refuseSession(reason: RefusedSession) {
    this.invalidate();
    this.publish({ status: reason, plan: null, works: [], error: "账户或登录状态已变化，本次核对内容已清除，请返回目录重新确认。" });
    this.onSessionRefused(reason);
  }

  async start(): Promise<void> {
    const plan = this.state.plan;
    if (!plan || this.state.status === "running") return;
    if (this.now() < this.state.retryAt) {
      this.publish({ status: "limited", error: "仍在 Retry-After 等待期内，没有发送核对请求。" });
      return;
    }
    this.invalidate();
    const version = this.generation;
    this.abort = new AbortController();
    this.publish({ status: "running", works: plan.works.map(work => ({ ...work })), error: "" });
    const current = () => version === this.generation;
    for (const work of plan.works) {
      if (!current()) return;
      this.updateWork(work.id, { status: "checking" });
      try {
        const response = await this.fetcher(`/api/authoring/catalogue/${encodeURIComponent(work.id)}/editions?scope=${plan.scope}`, {
          method: "GET", credentials: "same-origin", cache: "no-store", signal: this.abort.signal,
          headers: { accept: "application/json", [AUTHORING_EXPECTED_ACTOR_HEADER]: encodeURIComponent(plan.actor) },
        });
        if (!current()) return;
        const payload: unknown = await response.json().catch(() => null);
        if (!current()) return;
        if (response.status === 401 || apiErrorCode(payload) === "ACCOUNT_CHANGED") {
          this.refuseSession(response.status === 401 ? "unauthenticated" : "account-changed");
          return;
        }
        if (response.status === 429) {
          const seconds = parseRetryAfterSeconds(response.headers.get("retry-after"), this.now()) ?? 1;
          this.updateWork(work.id, { status: "failed", error: "请求受限，此作品尚未核对。" });
          const retryAt = this.now() + seconds * 1000;
          this.publish({ status: "limited", retryAt, error: "已停止剩余队列；等待后需手动重新核对，不会自动重试。" });
          this.onRateLimited(retryAt);
          return;
        }
        if (response.status === 404) {
          this.updateWork(work.id, { status: "unavailable", error: "本次范围内无法确认此作品；可能已移动、删除或权限改变，不能据此断言已永久删除。" });
          continue;
        }
        if (!response.ok) {
          this.updateWork(work.id, { status: "failed", error: "读取失败，保留原选择。" });
          this.publish({ status: "partial", error: "服务暂时不可用，剩余队列已停止；没有自动重试或替换索引。" });
          return;
        }
        const editions = readCatalogueEditions(isRecord(payload) ? payload.data : null, work.id, plan.scope);
        const differences = compareWork(plan, work.id, editions);
        this.updateWork(work.id, { status: "ready", editions, differences, checkedAt: new Date(this.now()).toISOString(), error: "" });
      } catch {
        if (!current()) return;
        this.updateWork(work.id, { status: "failed", error: "连接或版本响应无法确认，保留原选择。" });
        this.publish({ status: "partial", error: "已停止核对队列；当前结果不完整，请手动重新核对。" });
        return;
      }
    }
    if (!current()) return;
    const complete = this.state.works.every(work => work.status === "ready" && work.differences.every(difference => difference.current !== null));
    this.publish({ status: complete ? "complete" : "partial", error: complete ? "" : "仍有作品或所选语言版本无法确认；没有自动删除条目或替换索引。" });
  }
}
