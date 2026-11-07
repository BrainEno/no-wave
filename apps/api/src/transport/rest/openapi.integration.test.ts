import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createApiServer } from "../../server.ts";
import { createSqliteClient, runSqliteMigrations } from "../../persistence/sqlite.ts";
import { createSqliteStore } from "../../persistence/sqlite-store.ts";
import { OPENAPI_DOCUMENT, OPENAPI_PATH } from "./openapi/index.ts";

/**
 * The served contract, and the authentication claims in it, against the real
 * handlers.
 *
 * `openapi.test.ts` proves the document is internally consistent. This test proves
 * it is *true*: the endpoint answers what the file says, and the two security
 * postures behave the way the document describes them —
 *
 *  - an operation documented as anonymous must not answer `401` without a token;
 *  - an operation documented as session-only must answer `401` without one.
 *
 * The second direction is checked for `GET`/`DELETE`, where a request carries no
 * body, because a `POST` with an empty body is answered by body validation before
 * the token is read and would prove nothing about authentication. Media operations
 * are excluded: an instance with no image storage answers `409`/`503` before it
 * looks at the token, which is deliberate (`media.ts` explains the ordering).
 */

const env = {
  AUTH_JWT_SECRET: "test-only-secret-at-least-thirty-two-bytes",
  AUTH_JWT_ISSUER: "https://auth.example.test",
  AUTH_JWT_AUDIENCE: "bot-thk-api",
};

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

type DocumentedOperation = {
  path: string;
  method: string;
  operation: Record<string, unknown>;
};

function documentedOperations(): DocumentedOperation[] {
  const paths = OPENAPI_DOCUMENT.paths as Record<string, Record<string, Record<string, unknown>>>;
  const found: DocumentedOperation[] = [];
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (HTTP_METHODS.has(method)) found.push({ path, method: method.toUpperCase(), operation });
    }
  }
  return found;
}

/** Replace `{parameters}` with a value the handlers will try to use. */
function concretePath(path: string, operation: Record<string, unknown>): string {
  const parameters = (operation.parameters as Array<Record<string, unknown>> | undefined) ?? [];
  return path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const parameter = parameters.find((candidate) => candidate.name === name);
    const schema = parameter?.schema as Record<string, unknown> | undefined;
    const values = schema?.enum as string[] | undefined;
    return values?.[0] ?? randomUUID();
  });
}

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  await runSqliteMigrations(db);
  const store = createSqliteStore(db);
  const server = createApiServer({ store, env, logger: () => {} });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  }
}

test("GET /api/v1/openapi.json serves exactly the generated document", async () => {
  await withServer(async (origin) => {
    const response = await fetch(`${origin}${OPENAPI_PATH}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    assert.deepEqual(await response.json(), OPENAPI_DOCUMENT);

    // A read-only route answers the documented 405 rather than a 404 or a body.
    const write = await fetch(`${origin}${OPENAPI_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(write.status, 405);
    assert.equal(write.headers.get("allow"), "GET");
  });
});

test("an operation documented as anonymous does not answer 401", async () => {
  await withServer(async (origin) => {
    const anonymous = documentedOperations().filter(({ operation }) => (operation.security as unknown[]).length === 0);
    assert.ok(anonymous.length > 0, "the document should contain anonymous operations");

    for (const { path, method, operation } of anonymous) {
      const url = `${origin}${concretePath(path, operation)}`;
      const init: RequestInit = { method };
      if (method !== "GET" && method !== "DELETE") {
        init.headers = { "content-type": "application/json" };
        init.body = "{}";
      }
      const response = await fetch(url, init);
      assert.notEqual(response.status, 401, `${method} ${path} is documented as anonymous`);
    }
  });
});

test("a session-only GET or DELETE answers 401 without a credential", async () => {
  await withServer(async (origin) => {
    const sessionOnly = documentedOperations().filter(({ method, operation }) => {
      const security = operation.security as Array<Record<string, unknown>>;
      const tags = (operation.tags as string[] | undefined) ?? [];
      return security.length === 1 && (method === "GET" || method === "DELETE") && !tags.includes("media");
    });
    assert.ok(sessionOnly.length > 0, "the document should contain session-only reads and deletes");

    for (const { path, method, operation } of sessionOnly) {
      const response = await fetch(`${origin}${concretePath(path, operation)}`, { method });
      assert.equal(response.status, 401, `${method} ${path} requires a session`);
    }
  });
});
