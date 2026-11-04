/**
 * Source-of-truth reader and generator for the persistence domain slices.
 *
 * The 2,264-line `postgres.ts` monolith was split in one round by a script that
 * lived outside the repository. That script cannot be run any more — its input
 * file no longer exists at HEAD — so the `*-store.ts` files are now the source
 * of truth. This module reads their `satisfies Pick<...>` ownership declarations
 * and renders two checked-in artifacts: a JSON manifest and this ownership
 * document. `scripts/persistence-slices.test.ts` proves both are current and
 * that the layout still satisfies the contract's invariants.
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PERSISTENCE_DIR = path.join(ROOT, "apps/api/src/persistence");
const PORTS_FILE = path.join(ROOT, "apps/api/src/application/persistence-ports.ts");
export const MANIFEST_FILE = path.join(ROOT, "scripts/lib/persistence-slices.manifest.json");
export const DOC_FILE = path.join(ROOT, "docs/architecture/persistence-slices.md");

export type Provider = "sqlite" | "postgres";
export type SliceEntry = {
  provider: Provider;
  file: string;
  factory: string;
  methods: string[];
};
export type Manifest = {
  generatedBy: string;
  baseline: { commit: string; file: string; inlineMethods: string[] };
  portMethods: string[];
  mediaMethods: string[];
  slices: SliceEntry[];
};

export const GENERATOR = "scripts/generate-persistence-slices.ts";
/** The pre-split monolith, whose inline method set the first round had to preserve. */
export const BASELINE_COMMIT = "74b3a3a91329c2ae4bfc65a05c6b83a4b714d63d";
export const BASELINE_FILE = "apps/api/src/persistence/postgres.ts";
/** Methods declared inside `return Object.freeze({ ... })` in that monolith. */
export const BASELINE_INLINE_METHODS: readonly string[] = Object.freeze([
  "health", "transaction", "getArticleLikeInfo", "toggleArticleLike", "setArticleLike",
  "listArticleComments", "createArticleComment", "deleteArticleComment", "listArticleCommentAuthorIds",
  "listTaxonomies", "getTaxonomyBySlug", "listTaxonomyArticles", "listArticleTaxonomies",
  "createTag", "createTaxonomy", "deleteTaxonomy", "getAuthorProfile", "getUserRole", "setUserRole",
  "searchAuthors", "searchUsers", "listFollowing", "listFollowers", "followUser", "unfollowUser",
  "upsertAuthorProfile", "listLikedArticles", "listRelatedArticles", "listPublishedArticles",
  "listFollowingArticles", "listFeaturedArticles", "setFeaturedArticles", "getPublishedArticle",
  "listMyArticles", "listMyDeletedArticles", "createArticle", "updateArticle", "deleteArticle",
  "restoreArticle", "purgeExpiredArticles", "createConversation", "updateConversationParticipants",
  "deleteConversation", "markConversationAsRead", "listConversationMessages", "getConversation",
  "listConversations", "persistMessage", "outboxBacklog", "listConversationParticipantIds",
  "deliverMessageNotifications", "listNotifications", "getUnreadNotificationCount",
  "markAllNotificationsRead", "markNotificationRead", "createNotification", "createMediaAsset",
  "getMediaAsset", "listMediaScanRows", "listMediaAssets", "deleteUnusedMediaAsset", "isSessionRevoked",
]);
/** Media metadata is typed on the full adapter but deliberately outside `persistencePortMethods`. */
export const MEDIA_METHODS: readonly string[] = Object.freeze([
  "createMediaAsset", "getMediaAsset", "listMediaScanRows", "listMediaAssets", "deleteUnusedMediaAsset",
]);
/** The one documented overlap: SQLite's identity slice owns `revokeSession`. */
export const ALLOWED_SQLITE_OVERLAPS: readonly string[] = Object.freeze(["revokeSession"]);

const SLICE_FILE = /^(sqlite|postgres)-[a-z-]+-store\.ts$/;
const OWNERSHIP = /satisfies\s+Pick<TypedPersistenceAdapterContract\s*,\s*([\s\S]*?)>\s*;/;
const FACTORY = /export function (create\w+)\(/;
const PORT_TABLE = /export const persistencePortMethods = Object\.freeze\(\{([\s\S]*?)\n\}\);/;

function quoted(block: string): string[] {
  const found = [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  return [...new Set(found)];
}

async function readPortMethods(): Promise<string[]> {
  const source = await readFile(PORTS_FILE, "utf8");
  const table = source.match(PORT_TABLE);
  if (!table) throw new Error(`Cannot find persistencePortMethods in ${PORTS_FILE}`);
  return quoted(table[1]);
}

/** Read every slice file and the exact method set it declares. */
export async function readSlices(): Promise<SliceEntry[]> {
  const files = (await readdir(PERSISTENCE_DIR)).filter((file) => SLICE_FILE.test(file)).sort();
  const slices: SliceEntry[] = [];
  for (const file of files) {
    const provider = file.startsWith("sqlite-") ? "sqlite" : "postgres";
    const source = await readFile(path.join(PERSISTENCE_DIR, file), "utf8");
    const ownership = source.match(OWNERSHIP);
    const factory = source.match(FACTORY);
    if (!ownership || !factory) throw new Error(`${file} is missing its factory or satisfies Pick<...> ownership declaration`);
    slices.push({ provider, file, factory: factory[1], methods: quoted(ownership[1]) });
  }
  return slices;
}

export async function readManifest(): Promise<Manifest> {
  const portMethods = await readPortMethods();
  return {
    generatedBy: GENERATOR,
    baseline: { commit: BASELINE_COMMIT, file: BASELINE_FILE, inlineMethods: [...BASELINE_INLINE_METHODS] },
    portMethods,
    mediaMethods: [...MEDIA_METHODS],
    slices: await readSlices(),
  };
}

export function renderManifest(manifest: Manifest): string {
  return JSON.stringify(manifest, null, 2) + "\n";
}

export function renderDoc(manifest: Manifest): string {
  const lines: string[] = [
    "# Persistence domain slices",
    "",
    `Generated by \`${GENERATOR}\`. Do not edit by hand: run \`pnpm slices:generate\` to refresh`,
    "and `pnpm slices:check` (also part of `pnpm test`) to prove this file, the manifest",
    "and the slice sources agree.",
    "",
    "## Why there is no checked-in splitter",
    "",
    "The first round (`fb9a892`) split a 2,264-line `postgres.ts` into ten domain slices",
    "with a one-off Python script kept outside the repository. That script consumed a file",
    "which no longer exists at HEAD, so committing it would give reviewers a tool that",
    "cannot run. The 20 `*-store.ts` files are now the source of truth: each closes with",
    "`satisfies Pick<TypedPersistenceAdapterContract, ...>` naming exactly the methods it owns.",
    "This generator emits the reviewed artifacts (`scripts/lib/persistence-slices.manifest.json`",
    "and this document) from those declarations; the checked-in test fails on drift, on a lost",
    "method, on an overlapping PostgreSQL slice, on a changed SQLite exception, or on an `any`",
    "fallback reappearing at the PostgreSQL driver boundary.",
    "",
    `Baseline: \`${BASELINE_COMMIT}\` \`${BASELINE_FILE}\` declared`,
    `${BASELINE_INLINE_METHODS.length} inline methods (including \`health\` and \`transaction\`).`,
    "The 60 domain methods must still exist in the current PostgreSQL slices, while `health`",
    "and `transaction` stay in the small `postgres.ts` entry point. A brace-balanced re-check",
    "of `searchAuthors` — flagged as non-verbatim in the first round — shows its body is",
    "byte-identical to the monolith's; the earlier flag came from the extraction script, not",
    "from a code change.",
    "",
    "## Slice ownership",
    "",
    `The port table declares ${manifest.portMethods.length} methods; each provider's slices own`,
    `${manifest.portMethods.length - 1} of them (all but \`health\`) plus the ${MEDIA_METHODS.length} media`,
    "methods. `health` and PostgreSQL's optional `transaction` are composed by the entry point.",
    "",
    "| Provider | Slice | Factory | Methods |",
    "| --- | --- | --- | --- |",
  ];
  for (const slice of manifest.slices) {
    lines.push(`| ${slice.provider} | \`${slice.file}\` | \`${slice.factory}\` | ${slice.methods.length} |`);
  }
  lines.push("", "### Method lists", "");
  for (const provider of ["sqlite", "postgres"] as const) {
    lines.push(`#### ${provider}`, "");
    for (const slice of manifest.slices.filter((entry) => entry.provider === provider)) {
      lines.push(`- \`${slice.file}\`: ${slice.methods.map((method) => `\`${method}\``).join(", ")}`);
    }
    lines.push("");
  }
  lines.push(
    "## Invariants",
    "",
    "- Every slice declares an exact, non-empty `Pick<...>` set and a factory.",
    "- Per provider the union of slice methods equals the port table minus `health` plus the media methods.",
    "- PostgreSQL slices are pairwise disjoint; the SQLite identity/session `revokeSession` overlap is the single documented exception, and the composition narrows the session slice to `isSessionRevoked`.",
    "- Both compositions call `assertDisjointSlices`, `assertPersistenceAdapter`, `satisfies TypedPersistenceAdapterContract`, and instantiate every factory.",
    "- PostgreSQL source contains no `any` fallback and no `as unknown as`.",
    "",
  );
  return lines.join("\n");
}

/** Comments may quote the very `any` patterns being guarded; check code only. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Structural invariants. An empty array means the layout is valid. */
export async function validateLayout(): Promise<string[]> {
  const problems: string[] = [];
  const manifest = await readManifest();
  const expected = new Set([...manifest.portMethods.filter((method) => method !== "health"), ...MEDIA_METHODS]);

  for (const provider of ["sqlite", "postgres"] as const) {
    const slices = manifest.slices.filter((slice) => slice.provider === provider);
    if (slices.length !== 10) problems.push(`${provider}: expected 10 slices, found ${slices.length}`);
    const owned = new Map<string, string[]>();
    const union = new Set<string>();
    for (const slice of slices) {
      if (slice.methods.length === 0) problems.push(`${provider}/${slice.file}: empty ownership set`);
      for (const method of slice.methods) {
        union.add(method);
        const owners = owned.get(method) ?? [];
        owners.push(slice.file);
        owned.set(method, owners);
      }
    }
    for (const method of expected) {
      if (!union.has(method)) problems.push(`${provider}: no slice owns \`${method}\``);
    }
    for (const method of union) {
      if (!expected.has(method)) problems.push(`${provider}: unexpected method \`${method}\` in a slice`);
    }
    const allowed = new Set(provider === "sqlite" ? ALLOWED_SQLITE_OVERLAPS : []);
    for (const [method, owners] of owned) {
      if (owners.length > 1 && !allowed.has(method)) {
        problems.push(`${provider}: \`${method}\` is declared by ${owners.join(" and ")}`);
      }
    }
    for (const exception of allowed) {
      if ((owned.get(exception)?.length ?? 0) < 2) problems.push(`${provider}: documented \`${exception}\` overlap disappeared; update ALLOWED_SQLITE_OVERLAPS`);
    }

    const compositionFile = provider === "sqlite" ? "sqlite-store.ts" : "postgres.ts";
    const composition = await readFile(path.join(PERSISTENCE_DIR, compositionFile), "utf8");
    for (const slice of slices) {
      if (!composition.includes(`${slice.factory}(`)) problems.push(`${compositionFile}: missing \`${slice.factory}\``);
    }
    for (const guard of ["assertDisjointSlices(", "assertPersistenceAdapter(", "satisfies TypedPersistenceAdapterContract"]) {
      if (!composition.includes(guard)) problems.push(`${compositionFile}: missing \`${guard}\``);
    }
  }

  const pgEntry = await readFile(path.join(PERSISTENCE_DIR, "postgres.ts"), "utf8");
  if (!/async health\(\)/.test(pgEntry)) problems.push("postgres.ts: missing `health`");
  if (!/transaction\(work\)/.test(pgEntry)) problems.push("postgres.ts: missing PostgreSQL-only `transaction`");
  const sqliteEntry = await readFile(path.join(PERSISTENCE_DIR, "sqlite-store.ts"), "utf8");
  if (!/isSessionRevoked:\s*sessionStore\.isSessionRevoked/.test(sqliteEntry)) {
    problems.push("sqlite-store.ts: session slice is no longer narrowed to `isSessionRevoked`");
  }

  const pgSlices = new Set(manifest.slices.filter((slice) => slice.provider === "postgres").flatMap((slice) => slice.methods));
  for (const method of BASELINE_INLINE_METHODS) {
    if (method === "health" || method === "transaction") continue;
    if (!pgSlices.has(method)) problems.push(`first-round baseline method \`${method}\` is missing from the PostgreSQL slices`);
  }

  const pgFiles = (await readdir(PERSISTENCE_DIR)).filter((file) => file.startsWith("postgres") && file.endsWith(".ts") && !file.includes(".test."));
  for (const file of pgFiles) {
    const source = stripComments(await readFile(path.join(PERSISTENCE_DIR, file), "utf8"));
    if (/:\s*any\b|<\s*any\s*>|\bas any\b/.test(source)) problems.push(`${file}: an \`any\` fallback returned to the PostgreSQL driver boundary`);
    if (source.includes("as unknown as")) problems.push(`${file}: \`as unknown as\` returned to a PostgreSQL slice`);
  }
  return problems;
}

/** Compare the checked-in generated artifacts with a fresh render. */
export async function checkGeneratedFiles(): Promise<string[]> {
  const manifest = await readManifest();
  const expected: Array<[string, string]> = [
    [MANIFEST_FILE, renderManifest(manifest)],
    [DOC_FILE, renderDoc(manifest)],
  ];
  const problems: string[] = [];
  for (const [file, content] of expected) {
    let current: string;
    try { current = await readFile(file, "utf8"); }
    catch { problems.push(`${path.relative(ROOT, file)} is missing; run pnpm slices:generate`); continue; }
    if (current !== content) problems.push(`${path.relative(ROOT, file)} is stale; run pnpm slices:generate`);
  }
  return problems;
}

export async function writeGeneratedFiles(): Promise<void> {
  const manifest = await readManifest();
  await writeFile(MANIFEST_FILE, renderManifest(manifest), "utf8");
  await writeFile(DOC_FILE, renderDoc(manifest), "utf8");
}
