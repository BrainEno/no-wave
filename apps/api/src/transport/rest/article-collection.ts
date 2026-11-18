import type { ServerResponse } from "node:http";
import type { ArticleReadProjection, StoredArticle } from "../../application/persistence-ports.ts";
import { articleReadingPreview } from "../../application/article-reading.ts";
import type { RestServices } from "./http.ts";
import { serializeRestArticles } from "./serializers.ts";
import { sendJsonCollection } from "./json-collection.ts";
import { collectionReadBudgetFor } from "./collection-read-budget.ts";

export type ArticleListView = "full" | "card";

/** Additive opt-in only: absent/explicit full keeps the historical REST body. */
export function parseArticleListView(url: URL): ArticleListView | null {
  const values = url.searchParams.getAll("view");
  if (values.length === 0) return "full";
  return values.length === 1 && (values[0] === "full" || values[0] === "card") ? values[0] : null;
}

export function articleReadOptions(response: ServerResponse, projection: ArticleListView): ArticleReadProjection {
  const readBudget = collectionReadBudgetFor(response);
  readBudget?.checkpoint();
  if (projection === "full") return {};
  const controller = new AbortController();
  const detach = () => { response.off("finish", detach); response.off("close", close); };
  const close = () => { controller.abort(); detach(); };
  response.once("finish", detach);
  response.once("close", close);
  if (response.destroyed || response.writableEnded) close();
  return { projection, signal: readBudget ? AbortSignal.any([controller.signal, readBudget.signal]) : controller.signal };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Derive exactly the public reading length and first paragraph's first two
 * nonempty lines. This is not a second domain validator, a body truncation, or
 * an authoring representation. The explicit marker prevents using it as detail.
 */
export function articleCardProjection(value: unknown): unknown {
  if (!record(value)) throw new Error("Stored article is not a readable record.");
  const { contentBlocks, readingPreview, ...metadata } = value;
  return { ...metadata, contentProjection: "card", reading: readingPreview ?? articleReadingPreview(contentBlocks, value.locale) };
}

/** Keep the three batched author/taxonomy queries; output is demand-driven. */
export async function sendRestArticleCollection(response: ServerResponse, services: RestServices, articles: readonly StoredArticle[], viewerId: string | null, options: { view?: ArticleListView; meta?: unknown } = {}): Promise<void> {
  const readBudget = collectionReadBudgetFor(response);
  readBudget?.checkpoint();
  const data = await serializeRestArticles(services, articles, viewerId);
  readBudget?.complete();
  await sendJsonCollection(response, data, { view: options.view, meta: options.meta,
    ...(options.view === "card" ? { project: articleCardProjection } : {}) });
}
