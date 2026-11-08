/**
 * Source-of-truth reader and generator for the persistence domain slices.
 *
 * The 2,264-line `postgres.ts` monolith was split in one round by a script that
 * lived outside the repository. That script cannot be run any more — its input
 * file no longer exists at HEAD — so the `*-store.ts` files are now the source
 * of truth. This module reads their `satisfies Pick<...>` ownership declarations
 * and renders two checked-in artifacts: a JSON manifest and this ownership
 * document. Every path is rooted through `layoutPaths(root)`, so
 * `scripts/persistence-slices.test.ts` can mutate a disposable copy and prove
 * the guards actually fail, as well as prove both artifacts are current.
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Every filesystem path goes through here. A caller can point at a different
 * root, which is what lets the regression tests mutate a copy of the layout and
 * prove the guards actually fail instead of trusting that they would.
 */
export type LayoutPaths = {
  root: string;
  persistenceDir: string;
  portsFile: string;
  manifestFile: string;
  docFile: string;
};

export function layoutPaths(root: string = ROOT): LayoutPaths {
  return {
    root,
    persistenceDir: path.join(root, "apps/api/src/persistence"),
    portsFile: path.join(root, "apps/api/src/application/persistence-ports.ts"),
    manifestFile: path.join(root, "scripts/lib/persistence-slices.manifest.json"),
    docFile: path.join(root, "docs/architecture/persistence-slices.md"),
  };
}

export const MANIFEST_FILE = layoutPaths().manifestFile;
export const DOC_FILE = layoutPaths().docFile;

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
  "listArticleComments", "createArticleComment", "updateArticleComment", "deleteArticleComment", "listArticleCommentAuthorIds",
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
  "getMediaAsset", "listMediaScanRows", "listReferencesForAssets", "listMediaAssets", "deleteUnusedMediaAsset", "isSessionRevoked",
]);
/** Media metadata is typed on the full adapter but deliberately outside `persistencePortMethods`. */
export const MEDIA_METHODS: readonly string[] = Object.freeze([
  "createMediaAsset", "getMediaAsset", "listMediaScanRows", "listReferencesForAssets", "listMediaAssets", "deleteUnusedMediaAsset",
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

async function readPortMethods(root: string = ROOT): Promise<string[]> {
  const { portsFile } = layoutPaths(root);
  const source = await readFile(portsFile, "utf8");
  const table = source.match(PORT_TABLE);
  if (!table) throw new Error(`Cannot find persistencePortMethods in ${portsFile}`);
  return quoted(table[1]);
}

/** Read every slice file and the exact method set it declares. */
export async function readSlices(root: string = ROOT): Promise<SliceEntry[]> {
  const { persistenceDir } = layoutPaths(root);
  const files = (await readdir(persistenceDir)).filter((file) => SLICE_FILE.test(file)).sort();
  const slices: SliceEntry[] = [];
  for (const file of files) {
    const provider = file.startsWith("sqlite-") ? "sqlite" : "postgres";
    const source = await readFile(path.join(persistenceDir, file), "utf8");
    const ownership = source.match(OWNERSHIP);
    const factory = source.match(FACTORY);
    if (!ownership || !factory) throw new Error(`${file} is missing its factory or satisfies Pick<...> ownership declaration`);
    slices.push({ provider, file, factory: factory[1], methods: quoted(ownership[1]) });
  }
  return slices;
}

export async function readManifest(root: string = ROOT): Promise<Manifest> {
  const portMethods = await readPortMethods(root);
  return {
    generatedBy: GENERATOR,
    baseline: { commit: BASELINE_COMMIT, file: BASELINE_FILE, inlineMethods: [...BASELINE_INLINE_METHODS] },
    portMethods,
    mediaMethods: [...MEDIA_METHODS],
    slices: await readSlices(root),
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
    "fallback reappearing at the PostgreSQL driver boundary. A mutation test copies this layout,",
    "breaks each invariant in turn and asserts the guard reports it, so the checks are proven",
    "rather than merely documented.",
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
export async function validateLayout(root: string = ROOT): Promise<string[]> {
  const problems: string[] = [];
  const { persistenceDir } = layoutPaths(root);
  const manifest = await readManifest(root);
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
    const composition = await readFile(path.join(persistenceDir, compositionFile), "utf8");
    for (const slice of slices) {
      if (!composition.includes(`${slice.factory}(`)) problems.push(`${compositionFile}: missing \`${slice.factory}\``);
    }
    for (const guard of ["assertDisjointSlices(", "assertPersistenceAdapter(", "satisfies TypedPersistenceAdapterContract"]) {
      if (!composition.includes(guard)) problems.push(`${compositionFile}: missing \`${guard}\``);
    }
  }

  const pgEntry = await readFile(path.join(persistenceDir, "postgres.ts"), "utf8");
  if (!/async health\(\)/.test(pgEntry)) problems.push("postgres.ts: missing `health`");
  // The signature is annotated under `strict`, so match the method and its
  // callback parameter rather than the exact pre-strict spelling.
  if (!/transaction\(work\s*[:,)]/.test(pgEntry)) problems.push("postgres.ts: missing PostgreSQL-only `transaction`");
  const sqliteEntry = await readFile(path.join(persistenceDir, "sqlite-store.ts"), "utf8");
  if (!/isSessionRevoked:\s*sessionStore\.isSessionRevoked/.test(sqliteEntry)) {
    problems.push("sqlite-store.ts: session slice is no longer narrowed to `isSessionRevoked`");
  }

  const pgSlices = new Set(manifest.slices.filter((slice) => slice.provider === "postgres").flatMap((slice) => slice.methods));
  for (const method of BASELINE_INLINE_METHODS) {
    if (method === "health" || method === "transaction") continue;
    if (!pgSlices.has(method)) problems.push(`first-round baseline method \`${method}\` is missing from the PostgreSQL slices`);
  }

  const pgFiles = (await readdir(persistenceDir)).filter((file) => file.startsWith("postgres") && file.endsWith(".ts") && !file.includes(".test."));
  for (const file of pgFiles) {
    const source = stripComments(await readFile(path.join(persistenceDir, file), "utf8"));
    if (/:\s*any\b|<\s*any\s*>|\bas any\b/.test(source)) problems.push(`${file}: an \`any\` fallback returned to the PostgreSQL driver boundary`);
    if (source.includes("as unknown as")) problems.push(`${file}: \`as unknown as\` returned to a PostgreSQL slice`);
  }
  return problems;
}

/** Compare the checked-in generated artifacts with a fresh render. */
export async function checkGeneratedFiles(root: string = ROOT): Promise<string[]> {
  const { manifestFile, docFile } = layoutPaths(root);
  const manifest = await readManifest(root);
  const expected: Array<[string, string]> = [
    [manifestFile, renderManifest(manifest)],
    [docFile, renderDoc(manifest)],
  ];
  const problems: string[] = [];
  for (const [file, content] of expected) {
    let current: string;
    try { current = await readFile(file, "utf8"); }
    catch { problems.push(`${path.relative(root, file)} is missing; run pnpm slices:generate`); continue; }
    if (current !== content) problems.push(`${path.relative(root, file)} is stale; run pnpm slices:generate`);
  }
  return problems;
}

export async function writeGeneratedFiles(root: string = ROOT): Promise<void> {
  const { manifestFile, docFile } = layoutPaths(root);
  const manifest = await readManifest(root);
  await writeFile(manifestFile, renderManifest(manifest), "utf8");
  await writeFile(docFile, renderDoc(manifest), "utf8");
}
