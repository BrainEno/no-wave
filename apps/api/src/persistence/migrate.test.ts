import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPostgresMigrationStatus } from "./migrate.ts";

/**
 * A stand-in for a `postgres` client: `unsafe` is the only method the status
 * check uses, and it answers the two queries it asks. Keeping the check down to
 * two queries is what lets it run on every API boot without a real database.
 */
function fakeSql(appliedVersions: string[] | null) {
  const queries: string[] = [];
  return {
    queries,
    async unsafe(query: string) {
      queries.push(query);
      if (/to_regclass/.test(query)) return [{ present: appliedVersions !== null }];
      if (/SELECT version FROM api_schema_migrations/.test(query)) {
        return appliedVersions.map((version) => ({ version }));
      }
      throw new Error(`Unexpected query: ${query}`);
    },
  };
}

async function migrationDirectory(files: string[]) {
  const directory = await mkdtemp(join(tmpdir(), "nw-migrations-"));
  await Promise.all(files.map((name) => writeFile(join(directory, name), "SELECT 1;\n", "utf8")));
  return directory;
}

test("reports every discovered migration as pending when the journal table is absent", async () => {
  const directory = await migrationDirectory([
    "0001_domain_schema.sql",
    "0014_featured_articles.sql",
  ]);
  const sql = fakeSql(null);
  const status = await getPostgresMigrationStatus(sql, { directory });

  assert.deepEqual(status.pending, ["0001_domain_schema.sql", "0014_featured_articles.sql"]);
  assert.deepEqual(status.applied, []);
  assert.equal(status.discovered, 2);
});

test("reports only the migrations the journal has not recorded", async () => {
  const directory = await migrationDirectory([
    "0001_domain_schema.sql",
    "0013_user_roles.sql",
    "0014_featured_articles.sql",
  ]);
  const sql = fakeSql(["0001_domain_schema", "0013_user_roles"]);
  const status = await getPostgresMigrationStatus(sql, { directory });

  assert.deepEqual(status.applied, ["0001_domain_schema.sql", "0013_user_roles.sql"]);
  assert.deepEqual(status.pending, ["0014_featured_articles.sql"]);
  assert.equal(status.discovered, 3);
});

test("reports an empty pending list for a fully migrated database", async () => {
  const directory = await migrationDirectory([
    "0001_domain_schema.sql",
    "0014_featured_articles.sql",
  ]);
  const sql = fakeSql(["0001_domain_schema", "0014_featured_articles"]);
  const status = await getPostgresMigrationStatus(sql, { directory });

  assert.deepEqual(status.pending, []);
  assert.equal(status.discovered, 2);
});

test("resolves the journal table through search_path rather than assuming public", async () => {
  const directory = await migrationDirectory(["0001_domain_schema.sql"]);
  const sql = fakeSql(["0001_domain_schema"]);
  await getPostgresMigrationStatus(sql, { directory });

  // An unqualified to_regclass follows the connection's search_path, which is
  // where runMigrations creates the table. Qualifying it as "public." would
  // report a false "not migrated" and stop the API from booting.
  assert.match(sql.queries[0], /to_regclass\('api_schema_migrations'\)/);
});

test("refuses to report a status when no versioned migrations are discovered", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nw-migrations-empty-"));
  await assert.rejects(
    () => getPostgresMigrationStatus(fakeSql([]), { directory }),
    /No versioned SQL migrations were found/,
  );
});
