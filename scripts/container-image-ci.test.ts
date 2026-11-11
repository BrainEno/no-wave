import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

/**
 * The actual image/HTTP contract runs in CI with Docker. This guard checks the
 * ordering and shared database that contract needs before the runtime starts:
 * a fresh API exits on a pending schema, taking concurrent `docker exec`
 * processes with it. A detached container's id does not mean it is ready.
 */
test("container CI migrates the shared SQLite volume before starting the API", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const start = workflow.indexOf("      - name: Run both images and probe them over HTTP");
  const end = workflow.indexOf("      - name: Stop the containers", start);
  assert.ok(start >= 0 && end > start, "the required image smoke and cleanup steps must exist");
  const step = workflow.slice(start, end).replace(/\\\r?\n\s*/g, " ");
  const commands = step.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("docker run "));
  const migration = commands.findIndex((line) => line.includes("bot-thk-api:ci") && line.includes("apps/api/src/persistence/migrate.ts"));
  const api = commands.findIndex((line) => /--name\s+api\b/.test(line) && line.includes("bot-thk-api:ci"));
  const web = commands.findIndex((line) => /--name\s+web\b/.test(line) && line.includes("bot-thk-web-rr:ci"));
  assert.ok(migration >= 0, "migrate in a separate API-image container, not via exec in the starting server");
  assert.ok(api > migration && web > api, "migrate, then start the API, then start the Web image");

  const migrateCommand = commands[migration]!;
  const apiCommand = commands[api]!;
  assert.match(step, /^\s*set -eu\s*$/m, "a failed migration must stop the smoke step");
  assert.doesNotMatch(migrateCommand, /\|\|/, "migration errors must not be suppressed");
  assert.match(migrateCommand, /(?:^|\s)--rm(?:\s|$)/, "the one-off migration container must be removed");
  assert.match(migrateCommand, /-e\s+DATABASE_PROVIDER=sqlite\b/);
  assert.match(apiCommand, /-e\s+DATABASE_PROVIDER=sqlite\b/);
  for (const field of ["AUTH_JWT_SECRET", "AUTH_JWT_ISSUER", "AUTH_JWT_AUDIENCE"]) {
    assert.match(apiCommand, new RegExp(`-e\\s+${field}=[^\\s]+`), `${field} must be set for API readiness`);
  }
  const mount = (command: string) => command.match(/(?:^|\s)(?:-v|--volume)\s+(\S+)/)?.[1];
  const dbPath = (command: string) => command.match(/(?:^|\s)-e\s+DATABASE_PATH=(\S+)/)?.[1];
  const migrationMount = mount(migrateCommand);
  const database = dbPath(migrateCommand);
  assert.ok(migrationMount && database, "the migration must use a mounted SQLite file");
  assert.equal(mount(apiCommand), migrationMount, "both containers must use the same mounted volume");
  assert.equal(dbPath(apiCommand), database, "both containers must use the same database file");
  const [volume, target] = migrationMount.split(":");
  assert.ok(volume && target && database.startsWith(`${target}/`), "the database must live on the shared volume");
  assert.ok(step.includes(`docker volume create ${volume}`), "the disposable volume must be created explicitly");
  assert.ok(workflow.slice(end).includes(`docker volume rm ${volume}`), "the disposable volume must be cleaned up");

  assert.ok((step.match(/pnpm test:container-smoke/g) ?? []).length >= 2, "both cold-start and restart HTTP probes remain required");
  assert.match(step, /docker stop web/);
  assert.match(step, /docker start web/);
});

/**
 * Every `docker build -f <file>` in the workflow names a file that exists.
 *
 * The repository ships no platform manifest (ADR 0029), so the Dockerfiles are
 * the only build definition there is: a `-f` path that no longer exists is a
 * deployment path nobody can take, and CI would report it as a red build with a
 * message about a missing file rather than about a missing image.
 */
test("the container CI job builds Dockerfiles that exist", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const root = new URL("..", import.meta.url).pathname;
  const buildFiles = [...workflow.matchAll(/docker build -f (\S+)/g)].map((match) => match[1]!);
  assert.deepEqual(
    buildFiles.map((file) => file.replace(/\/$/, "")),
    ["apps/api/Dockerfile", "apps/web-rr/Dockerfile"],
    "the workflow must build the API and Web images, by their real paths",
  );
  const missing = buildFiles.filter((file) => !existsSync(join(root, file)));
  assert.deepEqual(missing, [], "a Dockerfile named in CI must exist");
});

test("API image and CI require an unprivileged user and working readiness probe", async () => {
  const dockerfile = await readFile(new URL("../apps/api/Dockerfile", import.meta.url), "utf8");
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(dockerfile, /^ENV PORT=4000$/m);
  assert.match(dockerfile, /^ENV DATABASE_PATH=\/var\/lib\/no-wave\/no-wave\.sqlite$/m);
  assert.match(dockerfile, /chown node:node \/var\/lib\/no-wave/);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^HEALTHCHECK\b/m);
  assert.match(dockerfile, /127\.0\.0\.1:.*\/ready/);
  assert.match(dockerfile, /AbortSignal\.timeout/);
  assert.match(workflow, /docker image inspect --format '\{\{\.Config.User\}\}' bot-thk-api:ci/);
  assert.match(workflow, /docker run --rm bot-thk-api:ci id -u/);
  assert.match(workflow, /docker exec api id -u/);
  assert.match(workflow, /\.State.Health.Status/);
  assert.match(workflow, /\[ "\$health" != healthy \]/);
  assert.match(workflow, /-p 4000:4000 bot-thk-api:ci/);
  assert.match(workflow, /API_BASE_URL=http:\/\/api:4000/);
});
