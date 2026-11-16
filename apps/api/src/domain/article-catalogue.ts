import { createHash } from "node:crypto";
import { SUPPORTED_ARTICLE_LOCALES, validateArticleWorkType } from "./article.ts";
import { ArticleInputError } from "./errors.ts";
import { isUuid, requiredText } from "./validation.ts";

export type ArticleCatalogueQuery = {
  scope: "active" | "trash";
  q: string;
  locale: string;
  status: "all" | "draft" | "published";
  workType: string;
  sort: "updated" | "created";
  from: string;
  until: string;
  limit: number;
  cursor: string | null;
};
export type ArticleCataloguePoint = { at: string; id: string; locale: string };
export type ArticleCatalogueEntry = {
  id: string; slug: string; title: string; summary: string; locale: string; status: "draft" | "published";
  workType: string; createdAt: string; updatedAt: string; deletedAt: string | null;
};
export type ArticleCatalogueFacet = { locale: string; status: "draft" | "published"; workType: string; count: number };
export type ArticleCataloguePage = {
  items: ArticleCatalogueEntry[]; total: number; works: number;
  facets: ArticleCatalogueFacet[]; nextCursor: string | null;
};
export type ArticleCatalogueInput = ArticleCatalogueQuery & { actorId: string };

const PARAMS = new Set(["scope", "q", "locale", "status", "workType", "sort", "from", "until", "limit", "cursor"]);
const CURSOR_KEYS = ["v", "context", "at", "id", "locale"];
function invalid(): never { throw new ArticleInputError("Invalid article catalogue query or cursor. Restart the catalogue with valid filters."); }

function calendarDay(value: string): boolean {
  if (!/^(?:[1-9]\d{3})-\d{2}-\d{2}$/.test(value)) return false;
  const stamp = Date.parse(value + "T00:00:00.000Z");
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value && value < "9999-12-31";
}

/** Closed query vocabulary prevents typos and duplicate parameters from changing private reads silently. */
export function parseArticleCatalogueQuery(params: URLSearchParams): ArticleCatalogueQuery {
  for (const name of params.keys()) if (!PARAMS.has(name) || params.getAll(name).length !== 1) invalid();
  const scope = params.get("scope") ?? "active";
  const q = (params.get("q") ?? "").trim();
  const locale = params.get("locale") ?? "all";
  const status = params.get("status") ?? "all";
  const workType = params.get("workType") ?? "all";
  const sort = params.get("sort") ?? "updated";
  const from = params.get("from") ?? "", until = params.get("until") ?? "";
  const rawLimit = params.get("limit") ?? "20";
  const cursor = params.get("cursor");
  if (scope !== "active" && scope !== "trash" || status !== "all" && status !== "draft" && status !== "published" ||
      sort !== "updated" && sort !== "created" || locale !== "all" && !SUPPORTED_ARTICLE_LOCALES.has(locale) ||
      q.length > 120 || /[\u0000-\u001f\u007f\p{Cs}]/u.test(q) ||
      !/^[1-9]\d?$/.test(rawLimit) || Number(rawLimit) > 50 ||
      from !== "" && !calendarDay(from) || until !== "" && !calendarDay(until) || from !== "" && until !== "" && from > until ||
      cursor !== null && (!/^[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > 1024)) invalid();
  if (workType !== "all") validateArticleWorkType(workType);
  return { scope, q, locale, status, workType, sort, from, until, limit: Number(rawLimit), cursor };
}

/** Providers validate direct port calls as well as already-normalized HTTP calls. */
export function validateArticleCatalogueInput(input: ArticleCatalogueInput): ArticleCatalogueInput {
  requiredText("actorId", input.actorId, 300);
  const params = new URLSearchParams();
  for (const name of PARAMS) {
    const value = input[name as keyof ArticleCatalogueQuery];
    if (value !== undefined && value !== null) params.set(name, String(value));
  }
  return { ...parseArticleCatalogueQuery(params), actorId: input.actorId };
}

function catalogueContext(actorId: string, input: ArticleCatalogueQuery): string {
  return createHash("sha256").update(JSON.stringify(["article-catalogue-v1", actorId, input.scope,
    input.q, input.locale, input.status, input.workType, input.sort, input.from, input.until])).digest("hex");
}

function validPoint(point: ArticleCataloguePoint): boolean {
  if (typeof point.at !== "string" || !isUuid(point.id) || !SUPPORTED_ARTICLE_LOCALES.has(point.locale)) return false;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{3,6})Z$/.exec(point.at);
  if (!match || !Number.isFinite(Date.parse(point.at))) return false;
  // A JS Date only stores milliseconds. Compare its representable prefix while
  // retaining all six PostgreSQL microsecond digits in the actual seek witness.
  return new Date(point.at).toISOString() === `${match[1]}.${match[2]!.slice(0, 3)}Z`;
}

/** Unsigned seek hints are never authorization; every query still predicates on the verified actor. */
export function encodeArticleCatalogueCursor(point: ArticleCataloguePoint, actorId: string, query: ArticleCatalogueQuery): string {
  if (!validPoint(point)) invalid();
  return Buffer.from(JSON.stringify({ v: 1, context: catalogueContext(actorId, query), ...point })).toString("base64url");
}

export function decodeArticleCatalogueCursor(cursor: string, actorId: string, query: ArticleCatalogueQuery): ArticleCataloguePoint {
  if (!/^[A-Za-z0-9_-]{1,1024}$/.test(cursor)) invalid();
  let raw: unknown;
  try {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) invalid();
    raw = JSON.parse(bytes.toString("utf8"));
  } catch { invalid(); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid();
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).length !== CURSOR_KEYS.length || Object.keys(value).some(key => !CURSOR_KEYS.includes(key)) ||
      value.v !== 1 || value.context !== catalogueContext(actorId, query)) invalid();
  const point = { at: value.at, id: value.id, locale: value.locale } as ArticleCataloguePoint;
  if (!validPoint(point)) invalid();
  return point;
}

export function catalogueFacetMatches(facet: ArticleCatalogueFacet, query: ArticleCatalogueQuery): boolean {
  return (query.locale === "all" || facet.locale === query.locale) && (query.status === "all" || facet.status === query.status) &&
    (query.workType === "all" || facet.workType === query.workType);
}

export type ArticleCatalogueEditionsInput = { actorId: string; articleId: string; scope: "active" | "trash" };
