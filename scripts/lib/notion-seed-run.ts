/**
 * The run half of the Notion seed: bundle in, articles out.
 *
 * `scripts/notion-seed.ts` is the command; this is what the command *does*, kept
 * apart so it can be run against a stub API in a test. The split follows the
 * repository's rule that the interesting behaviour lives in `scripts/lib` with
 * tests next to it and the entry point only parses flags and prints.
 *
 * The run talks HTTP only. It never imports the application's services, so it
 * cannot accidentally take a shortcut the writing desk does not have: identical
 * validation, identical slug rules, identical taxonomy handling, identical
 * visibility to the web app and the Flutter client.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  articleWriteBody,
  emptyNotionSeedState,
  groupNotionWorks,
  idempotencyKeyFor,
  parseNotionBundle,
  parseNotionSeedState,
  planNotionSeed,
  type NotionSeedState,
  type PlannedEdition,
} from "./notion-bundle.ts";
import { collectNotionBundle } from "./notion-client.ts";
import type { InterchangeIssue } from "../../apps/api/src/application/notion-interchange.ts";

export type SeedArgs = {
  bundle: string | null;
  notionDatabase: string | null;
  notionToken: string | null;
  api: string;
  email: string | null;
  password: string | null;
  state: string;
  writeBundle: string | null;
  apply: boolean;
};

export type SeedOutcome = {
  pageId: string;
  title: string;
  locale: string;
  action: "create" | "update" | "skip" | "refused" | "failed";
  slug: string;
  detail: string;
  issues: InterchangeIssue[];
};

export type SeedRun = {
  outcomes: SeedOutcome[];
  state: NotionSeedState;
  applied: boolean;
};

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function api(
  base: string,
  path: string,
  init: { method: string; token?: string; body?: unknown; idempotencyKey?: string },
): Promise<unknown> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;
  const response = await fetch(`${base.replace(/\/+$/, "")}${path}`, {
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  let parsed: { data?: unknown; error?: { code?: string; message?: string } } = {};
  try {
    parsed = text.length > 0 ? (JSON.parse(text) as typeof parsed) : {};
  } catch {
    parsed = {};
  }
  if (!response.ok) {
    throw new ApiError(`${init.method} ${path} → ${response.status} ${parsed.error?.code ?? ""} ${parsed.error?.message ?? ""}`.trim(), response.status);
  }
  return parsed.data;
}

async function login(args: SeedArgs): Promise<string> {
  if (!args.email || !args.password) {
    throw new Error("An author account is required: pass --email and --password (or NOTION_SEED_EMAIL / NOTION_SEED_PASSWORD).");
  }
  const data = (await api(args.api, "/api/v1/auth/login", {
    method: "POST",
    body: { email: args.email, password: args.password },
  })) as { accessToken?: string } | null;
  if (typeof data?.accessToken !== "string") throw new Error("Login succeeded but returned no access token.");
  return data.accessToken;
}

/**
 * Existing tags by name, created on demand.
 *
 * An import must not invent a second 「诗歌」: the tag is a taxonomy with a slug
 * and a translation row, so a duplicate would split every tag page in two. The
 * lookup is by the zh-CN name, which is the only locale the tag write accepts.
 */
async function ensureTags(args: SeedArgs, token: string, names: readonly string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(names.filter((name) => name.length > 0))];
  const ids = new Map<string, string>();
  if (wanted.length === 0) return ids;

  const existing = (await api(args.api, "/api/v1/tags?locale=zh-CN&limit=100", { method: "GET" })) as { id?: string; name?: string }[] | null;
  for (const tag of Array.isArray(existing) ? existing : []) {
    if (typeof tag?.id === "string" && typeof tag?.name === "string") ids.set(tag.name, tag.id);
  }
  for (const name of wanted) {
    if (ids.has(name)) continue;
    if (!args.apply) {
      ids.set(name, "");
      continue;
    }
    const created = (await api(args.api, "/api/v1/tags", { method: "POST", token, body: { name } })) as { id?: string } | null;
    if (typeof created?.id === "string") ids.set(name, created.id);
  }
  return ids;
}

async function applyEdition(
  args: SeedArgs,
  token: string,
  edition: PlannedEdition,
  tagIds: readonly string[],
  workSlug: string | null,
): Promise<{ outcome: SeedOutcome; articleId: string | null; slug: string | null }> {
  const base: SeedOutcome = {
    pageId: edition.pageId,
    title: edition.draft.title,
    locale: edition.locale,
    action: "skip",
    slug: edition.slug,
    detail: "",
    issues: edition.issues,
  };
  if (edition.unchanged) {
    return { outcome: { ...base, detail: "unchanged since the last run" }, articleId: edition.articleId, slug: edition.slug };
  }

  const body = articleWriteBody(edition.draft, tagIds);
  // An address the author actually wrote is theirs; a derived one is left to the
  // API, which owns uniqueness and can suffix a collision instead of failing.
  if (edition.issues.some((issue) => issue.code === "slug-derived")) delete body.slug;

  if (!args.apply) {
    return {
      outcome: {
        ...base,
        action: edition.articleId === null ? "create" : "update",
        detail: edition.articleId === null ? "would create" : `would update ${edition.articleId}`,
      },
      articleId: edition.articleId,
      slug: edition.slug,
    };
  }

  if (edition.articleId === null) {
    const created = (await api(args.api, "/api/v1/articles", {
      method: "POST",
      token,
      body,
      idempotencyKey: idempotencyKeyFor(edition.pageId),
    })) as { id?: string; slug?: string } | null;
    const slug = typeof created?.slug === "string" ? created.slug : edition.slug;
    return {
      outcome: { ...base, action: "create", slug, detail: "created" },
      articleId: typeof created?.id === "string" ? created.id : null,
      slug,
    };
  }

  // `PUT` addresses the work by id and carries the slug: an edition (a locale)
  // is replaced, the work keeps its address.
  const updated = (await api(args.api, `/api/v1/articles/${edition.articleId}`, {
    method: "PUT",
    token,
    body: { ...body, slug: workSlug ?? edition.slug, publish: edition.draft.publish },
  })) as { id?: string; slug?: string } | null;
  return {
    outcome: { ...base, action: "update", slug: typeof updated?.slug === "string" ? updated.slug : edition.slug, detail: "updated" },
    articleId: edition.articleId,
    slug: typeof updated?.slug === "string" ? updated.slug : edition.slug,
  };
}

async function readState(path: string): Promise<NotionSeedState> {
  try {
    return parseNotionSeedState(JSON.parse(await readFile(resolve(path), "utf8")));
  } catch {
    return emptyNotionSeedState();
  }
}

export async function runNotionSeed(args: SeedArgs, deps: { fetchBundle?: () => Promise<unknown> } = {}): Promise<SeedRun> {
  const raw = args.bundle !== null
    ? JSON.parse(await readFile(resolve(args.bundle), "utf8"))
    : await (deps.fetchBundle ?? (async () => {
      if (!args.notionToken) throw new Error("Fetching needs NOTION_TOKEN (or --notion-token).");
      if (!args.notionDatabase) throw new Error("Fetching needs a database id: --notion-database <id>.");
      return collectNotionBundle({ token: args.notionToken, sourceId: args.notionDatabase });
    }))();

  const bundle = parseNotionBundle(raw);
  if (args.writeBundle !== null && args.bundle === null) {
    await writeFile(resolve(args.writeBundle), `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  }

  const state = await readState(args.state);
  const { works, issues: groupingIssues } = groupNotionWorks(bundle.pages);
  const plan = planNotionSeed({ works, state });
  const outcomes: SeedOutcome[] = [];

  for (const refused of plan.refused) {
    outcomes.push({
      pageId: refused.pageId,
      title: refused.title,
      locale: "zh-CN",
      action: "refused",
      slug: "",
      detail: refused.issues.map((issue) => issue.code).join(", "),
      issues: refused.issues,
    });
  }
  for (const issue of groupingIssues) {
    outcomes.push({ pageId: "", title: "", locale: "", action: "skip", slug: "", detail: issue.detail, issues: [issue] });
  }

  const token = args.apply ? await login(args) : null;
  const tagNames = plan.works.flatMap((work) => [work.primary, ...work.translations].flatMap((edition) => edition.draft.tags));
  const tagIds = token !== null ? await ensureTags(args, token, tagNames) : new Map<string, string>();

  const nextState: NotionSeedState = structuredClone(state);
  for (const work of plan.works) {
    const idsFor = (edition: PlannedEdition): string[] =>
      edition.draft.tags.map((name) => tagIds.get(name)).filter((id): id is string => typeof id === "string" && id.length > 0);

    let workArticleId = work.primary.articleId;
    let workSlug: string | null = null;

    try {
      const primary = await applyEdition(args, token ?? "", work.primary, idsFor(work.primary), work.primary.slug);
      outcomes.push(primary.outcome);
      workArticleId = primary.articleId ?? workArticleId;
      workSlug = primary.slug ?? work.primary.slug;
      if (args.apply && workArticleId !== null) {
        nextState.pages[work.primary.pageId] = {
          articleId: workArticleId,
          slug: workSlug ?? work.primary.slug,
          locale: work.primary.locale,
          digest: work.primary.digest,
          syncedAt: new Date().toISOString(),
        };
      }
    } catch (error) {
      outcomes.push({
        pageId: work.primary.pageId,
        title: work.primary.draft.title,
        locale: work.primary.locale,
        action: "failed",
        slug: work.primary.slug,
        detail: error instanceof Error ? error.message : String(error),
        issues: work.primary.issues,
      });
    }

    for (const translation of work.translations) {
      if (workArticleId === null) {
        // A dry run has no id yet; the edition is still part of the plan, and
        // saying so is the difference between "we will import this" and "we
        // silently dropped half a work".
        outcomes.push({
          pageId: translation.pageId,
          title: translation.draft.title,
          locale: translation.locale,
          action: args.apply ? "skip" : "create",
          slug: workSlug ?? "",
          detail: args.apply
            ? "the work itself was not written, so the edition has nowhere to attach"
            : "would attach to the work created above",
          issues: translation.issues,
        });
        continue;
      }
      try {
        const applied = await applyEdition(
          args,
          token ?? "",
          { ...translation, articleId: workArticleId },
          idsFor(translation),
          workSlug,
        );
        outcomes.push(applied.outcome);
        if (args.apply) {
          nextState.pages[translation.pageId] = {
            articleId: workArticleId,
            slug: workSlug ?? translation.slug,
            locale: translation.locale,
            digest: translation.digest,
            syncedAt: new Date().toISOString(),
          };
        }
      } catch (error) {
        outcomes.push({
          pageId: translation.pageId,
          title: translation.draft.title,
          locale: translation.locale,
          action: "failed",
          slug: workSlug ?? "",
          detail: error instanceof Error ? error.message : String(error),
          issues: translation.issues,
        });
      }
    }
  }

  if (args.apply) await writeFile(resolve(args.state), `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  return { outcomes, state: nextState, applied: args.apply };
}
