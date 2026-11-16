import { ArticleInputError } from "../domain/errors.ts";
import { isUuid, requiredText } from "../domain/validation.ts";
import type { ArticleCatalogueEditionsInput } from "../domain/article-catalogue.ts";
import {
  catalogueFacetMatches, decodeArticleCatalogueCursor, encodeArticleCatalogueCursor, validateArticleCatalogueInput,
  type ArticleCatalogueEntry, type ArticleCatalogueFacet, type ArticleCatalogueInput, type ArticleCataloguePage,
} from "../domain/article-catalogue.ts";

export type CatalogueStatement = { text: string; values: unknown[] };
type CatalogueRow = Record<string, unknown>;
type CatalogueExecutor = (statement: CatalogueStatement) => CatalogueRow[] | Promise<CatalogueRow[]>;
type CatalogueDialect = "sqlite" | "postgres";

/** Both providers share predicates and seek order; only fixed SQL syntax differs. */
export function articleCatalogueStatements(raw: ArticleCatalogueInput, dialect: CatalogueDialect) {
  const input = validateArticleCatalogueInput(raw);
  const point = input.cursor ? decodeArticleCatalogueCursor(input.cursor, input.actorId, input) : null;
  const activity = input.sort === "created" ? "t.created_at" : input.scope === "trash" ? "a.deleted_at" : "t.updated_at";
  const direction = input.sort === "created" ? "ASC" : "DESC";
  const compare = direction === "ASC" ? ">" : "<";
  const localeColumn = dialect === "postgres" ? 't.locale COLLATE "C"' : "t.locale COLLATE BINARY";
  function predicate(withFilters: boolean, withCursor = false): CatalogueStatement {
    const values: unknown[] = [];
    const bind = (value: unknown) => { values.push(value); return dialect === "postgres" ? `$${values.length}` : "?"; };
    const clauses = [`a.author_id = ${bind(input.actorId)}`, `a.deleted_at IS ${input.scope === "active" ? "NULL" : "NOT NULL"}`];
    if (input.q) {
      const contains = dialect === "postgres" ? "strpos" : "instr";
      clauses.push(`(${contains}(t.title, ${bind(input.q)}) > 0 OR ${contains}(t.summary, ${bind(input.q)}) > 0)`);
    }
    if (input.from) clauses.push(`${activity} >= ${bind(input.from + "T00:00:00.000Z")}`);
    if (input.until) clauses.push(`${activity} < ${bind(new Date(Date.parse(input.until + "T00:00:00.000Z") + 86_400_000).toISOString())}`);
    if (withFilters) {
      if (input.locale !== "all") clauses.push(`t.locale = ${bind(input.locale)}`);
      if (input.status !== "all") clauses.push(`a.status = ${bind(input.status)}`);
      if (input.workType !== "all") clauses.push(`a.work_type = ${bind(input.workType)}`);
    }
    if (withCursor && point) {
      clauses.push(`(${activity} ${compare} ${bind(point.at)} OR (${activity} = ${bind(point.at)} AND
        (a.id ${compare} ${bind(point.id)} OR (a.id = ${bind(point.id)} AND ${localeColumn} > ${bind(point.locale)}))))`);
    }
    return { text: clauses.join(" AND "), values };
  }
  const join = " FROM articles a JOIN article_translations t ON t.article_id = a.id WHERE ";
  const page = predicate(true, true), facets = predicate(false), works = predicate(true);
  const cursorAt = dialect === "postgres" ? `to_char(${activity} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` : activity;
  page.text = `SELECT a.id, a.slug, a.work_type, a.status, t.created_at, t.updated_at, a.deleted_at,
    t.locale, t.title, t.summary, ${cursorAt} AS cursor_at${join}${page.text}
    ORDER BY ${activity} ${direction}, a.id ${direction}, ${localeColumn} ASC LIMIT ${dialect === "postgres" ? `$${page.values.length + 1}` : "?"}`;
  page.values.push(input.limit + 1);
  facets.text = `SELECT t.locale, a.status, a.work_type, COUNT(*) AS editions${join}${facets.text} GROUP BY t.locale, a.status, a.work_type`;
  works.text = `SELECT COUNT(DISTINCT a.id) AS works${join}${works.text}`;
  return { input, page, facets, works };
}

function count(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError("The catalogue returned an invalid count.");
  return number;
}
function timestamp(value: unknown): string {
  if (!(value instanceof Date) && typeof value !== "string") throw new TypeError("The catalogue returned an invalid timestamp.");
  return new Date(value).toISOString();
}
function catalogueEntry(row: CatalogueRow): ArticleCatalogueEntry {
  if (row.status !== "draft" && row.status !== "published") throw new TypeError("The catalogue returned an invalid publication state.");
  return { id: String(row.id), slug: String(row.slug), title: String(row.title), summary: String(row.summary ?? ""),
    locale: String(row.locale), status: row.status, workType: String(row.work_type),
    createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at),
    deletedAt: row.deleted_at === null || row.deleted_at === undefined ? null : timestamp(row.deleted_at) };
}

/** Three bounded metadata queries; never SELECT body JSON or fetch every work into application memory. */
export async function readArticleCatalogue(input: ArticleCatalogueInput, dialect: CatalogueDialect, execute: CatalogueExecutor): Promise<ArticleCataloguePage> {
  const statements = articleCatalogueStatements(input, dialect);
  const [rows, facetRows, workRows] = await Promise.all([execute(statements.page), execute(statements.facets), execute(statements.works)]);
  const facets: ArticleCatalogueFacet[] = facetRows.map(row => {
    if (row.status !== "draft" && row.status !== "published") throw new TypeError("The catalogue returned an invalid facet.");
    return { locale: String(row.locale), status: row.status, workType: String(row.work_type), count: count(row.editions) };
  });
  const visible = rows.slice(0, statements.input.limit);
  const last = visible.at(-1);
  const nextCursor = rows.length > statements.input.limit && last ? encodeArticleCatalogueCursor({
    at: String(last.cursor_at), id: String(last.id), locale: String(last.locale),
  }, statements.input.actorId, statements.input) : null;
  return { items: visible.map(catalogueEntry), facets, nextCursor,
    total: facets.filter(facet => catalogueFacetMatches(facet, statements.input)).reduce((sum, facet) => sum + facet.count, 0),
    works: count(workRows[0]?.works) };
}

/** A complete three-language view of one owned work, independent of list filters. */
export async function readCatalogueEditions(input: ArticleCatalogueEditionsInput, dialect: CatalogueDialect, execute: CatalogueExecutor): Promise<ArticleCatalogueEntry[]> {
  requiredText("actorId", input.actorId, 300);
  if (!isUuid(input.articleId) || input.scope !== "active" && input.scope !== "trash") throw new ArticleInputError("Invalid catalogue work or scope.");
  const bind = (index: number) => dialect === "postgres" ? `$${index}` : "?";
  const text = `SELECT a.id, a.slug, a.work_type, a.status, t.created_at, t.updated_at, a.deleted_at, t.locale, t.title, t.summary
    FROM articles a JOIN article_translations t ON t.article_id = a.id
    WHERE a.author_id = ${bind(1)} AND a.id = ${bind(2)} AND a.deleted_at IS ${input.scope === "active" ? "NULL" : "NOT NULL"}
    ORDER BY t.locale LIMIT 3`;
  return (await execute({ text, values: [input.actorId, input.articleId] })).map(catalogueEntry);
}
