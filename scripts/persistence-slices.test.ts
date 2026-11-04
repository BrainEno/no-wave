import assert from "node:assert/strict";
import test from "node:test";

import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { ROOT, checkGeneratedFiles, validateLayout } from "./lib/persistence-slices.ts";

/**
 * These are the cheapest authoritative checks for the first-round split: no
 * database, no server, just the checked-in slice sources against the checked-in
 * generated artifacts and the typed port contract.
 */
test("persistence slice manifest and ownership document are current", async () => {
  const problems = await checkGeneratedFiles();
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("persistence slices own disjoint, complete method sets in both providers", async () => {
  const problems = await validateLayout();
  assert.deepEqual(problems, [], problems.join("\n"));
});

/** A disposable copy of just the files `validateLayout` reads. */
async function copyLayout(root: string): Promise<void> {
  const sourceDir = path.join(ROOT, "apps/api/src/persistence");
  const targetDir = path.join(root, "apps/api/src/persistence");
  await mkdir(targetDir, { recursive: true });
  await mkdir(path.join(root, "apps/api/src/application"), { recursive: true });
  for (const file of await readdir(sourceDir)) {
    if (file.endsWith(".ts")) await copyFile(path.join(sourceDir, file), path.join(targetDir, file));
  }
  await copyFile(
    path.join(ROOT, "apps/api/src/application/persistence-ports.ts"),
    path.join(root, "apps/api/src/application/persistence-ports.ts"),
  );
}

async function replaceOnce(root: string, relativeFile: string, from: string, to: string): Promise<void> {
  const file = path.join(root, relativeFile);
  const source = await readFile(file, "utf8");
  assert.ok(source.includes(from), `${relativeFile} must contain ${JSON.stringify(from)}`);
  await writeFile(file, source.replace(from, to), "utf8");
}

/**
 * A guard nobody has seen fail is only a comment. Mutating a disposable copy
 * proves that losing a method, declaring one twice, or smuggling `any` back
 * into the PostgreSQL slices really does break `pnpm test`.
 */
test("slice layout guards reject a lost method, a duplicate owner and an any fallback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "no-wave-slices-"));
  const article = "apps/api/src/persistence/postgres-article-store.ts";
  const taxonomy = "apps/api/src/persistence/postgres-taxonomy-store.ts";
  const session = "apps/api/src/persistence/postgres-session-store.ts";
  try {
    await copyLayout(root);
    assert.deepEqual(await validateLayout(root), [], "an untouched copy must be valid");

    await replaceOnce(root, article, '"listPublishedArticles" | ', "");
    const lost = await validateLayout(root);
    assert.ok(lost.some((problem) => problem.includes("no slice owns `listPublishedArticles`")), lost.join("\n"));

    await replaceOnce(root, article, '"getPublishedArticle" | ', '"listPublishedArticles" | "getPublishedArticle" | ');
    assert.deepEqual(await validateLayout(root), [], "restoring the declaration must clear the problem");

    await replaceOnce(root, taxonomy, 'satisfies Pick<TypedPersistenceAdapterContract, ', 'satisfies Pick<TypedPersistenceAdapterContract, "getAuthorProfile" | ');
    const duplicated = await validateLayout(root);
    assert.ok(duplicated.some((problem) => problem.includes("`getAuthorProfile` is declared by")), duplicated.join("\n"));

    await replaceOnce(root, taxonomy, '"getAuthorProfile" | ', "");
    assert.deepEqual(await validateLayout(root), [], "restoring the ownership set must clear the problem");

    const sessionFile = path.join(root, session);
    await writeFile(sessionFile, (await readFile(sessionFile, "utf8")) + "\nconst leaked: any = 1;\n", "utf8");
    const leaked = await validateLayout(root);
    assert.ok(leaked.some((problem) => problem.includes("an `any` fallback returned")), leaked.join("\n"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
