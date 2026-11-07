import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { MEDIA_PAGE_SIZE, MEDIA_PAGE_SIZE_MAX } from "../../application/media-assets.ts";
import {
  OPENAPI_DOCUMENT,
  OPENAPI_DOCUMENT_JSON,
  OPENAPI_PATH,
  OPERATIONS,
  SCHEMAS,
  buildOpenApiDocument,
  operationKey,
  pathOf,
} from "./openapi/index.ts";
import { MEDIA_LIMIT_BOUNDS } from "./openapi/schemas.ts";
import { REST_ROUTES, resolveRestRoute, type HttpMethod } from "./routes.ts";

/**
 * The published contract against the route table it claims to describe.
 *
 * The document is generated, so the interesting assertions are the ones that
 * would survive a bug in the generator: every route is in the document, every
 * documented path routes back to the table, every `$ref` resolves, and the two
 * claims about authentication (anonymous operations really declare no credential,
 * optional ones really offer both) hold for all 65 operations.
 *
 * These run without a database or a server. `openapi.integration.test.ts` boots
 * one and checks the served document and the authentication claims against the
 * handlers themselves.
 */

type Operation = Record<string, unknown>;

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

function operations(document: Record<string, unknown> = OPENAPI_DOCUMENT): Array<{ path: string; method: string; operation: Operation }> {
  const paths = document.paths as Record<string, Record<string, unknown>>;
  const found: Array<{ path: string; method: string; operation: Operation }> = [];
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!HTTP_METHODS.has(method)) continue;
      found.push({ path, method: method.toUpperCase(), operation: operation as Operation });
    }
  }
  return found;
}

/** Substitute path parameters so a documented path can be handed to the router. */
function concretePath(path: string, operation: Operation): string {
  const parameters = (operation.parameters as Array<Record<string, unknown>> | undefined) ?? [];
  return path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const parameter = parameters.find((candidate) => candidate.name === name);
    const schema = parameter?.schema as Record<string, unknown> | undefined;
    const values = schema?.enum as string[] | undefined;
    return values?.[0] ?? randomUUID();
  });
}

/** Walk every `$ref` in the document so a renamed component cannot hide. */
function collectRefs(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, found);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      if (key === "$ref" && typeof entry === "string") found.push(entry);
      else collectRefs(entry, found);
    }
  }
  return found;
}

test("the document lists exactly the routes the dispatcher serves", () => {
  const expected = new Map<string, Set<string>>();
  for (const route of REST_ROUTES) {
    const path = pathOf(route);
    const methods = expected.get(path) ?? new Set<string>();
    for (const method of route.methods) methods.add(method);
    expected.set(path, methods);
  }

  const documented = new Map<string, Set<string>>();
  for (const { path, method } of operations()) {
    const methods = documented.get(path) ?? new Set<string>();
    methods.add(method);
    documented.set(path, methods);
  }

  assert.deepEqual([...documented.keys()].sort(), [...expected.keys()].sort(), "the set of paths must match the route table");
  for (const [path, methods] of expected) {
    assert.deepEqual([...documented.get(path) ?? []].sort(), [...methods].sort(), `methods for ${path}`);
  }
});

test("every documented path routes back to the table it was generated from", () => {
  for (const { path, method, operation } of operations()) {
    const resolution = resolveRestRoute(concretePath(path, operation), method);
    assert.equal(resolution.kind, "matched", `${method} ${path} should resolve`);
  }
});

test("the contract endpoint is itself a route", () => {
  const resolution = resolveRestRoute(OPENAPI_PATH, "GET");
  assert.equal(resolution.kind === "matched" ? resolution.id : null, "openapi");
});

test("every operation documents an id, a summary, a success response and a 400", () => {
  const operationIds = new Set<string>();
  for (const { path, method, operation } of operations()) {
    assert.equal(typeof operation.summary, "string", `${method} ${path} needs a summary`);
    assert.ok(String(operation.summary).length > 0, `${method} ${path} needs a non-empty summary`);
    assert.equal(typeof operation.operationId, "string", `${method} ${path} needs an operationId`);
    const operationId = String(operation.operationId);
    assert.equal(operationIds.has(operationId), false, `duplicate operationId ${operationId}`);
    operationIds.add(operationId);

    const responses = operation.responses as Record<string, unknown>;
    assert.ok(Object.hasOwn(responses, "400"), `${method} ${path} must document 400`);
    const success = Object.keys(responses).find((status) => Number(status) < 300);
    assert.ok(success !== undefined, `${method} ${path} must document a success status`);
    assert.equal(typeof (responses[success] as Record<string, unknown>).description, "string");

    const tags = operation.tags as string[] | undefined;
    assert.ok(Array.isArray(tags) && tags.length === 1, `${method} ${path} must carry exactly one tag`);
  }
  assert.equal(operationIds.size, operations().length);
});

test("every path parameter is declared and every declared parameter is used", () => {
  for (const { path, method, operation } of operations()) {
    const template = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
    const declared = ((operation.parameters as Array<Record<string, unknown>> | undefined) ?? [])
      .filter((parameter) => parameter.in === "path")
      .map((parameter) => parameter.name);
    assert.deepEqual(declared, template, `${method} ${path} path parameters`);
  }
});

test("the document keeps the OpenAPI 3.1 shapes a reader and a generator rely on", () => {
  const pathItemKeys = new Set(["get", "post", "put", "patch", "delete", "parameters", "summary", "description", "servers"]);
  const paths = OPENAPI_DOCUMENT.paths as Record<string, Record<string, unknown>>;
  for (const [path, item] of Object.entries(paths)) {
    for (const key of Object.keys(item)) assert.ok(pathItemKeys.has(key), `${path} has an unexpected path-item key ${key}`);
    for (const { method, operation } of operations({ paths: { [path]: item } })) {
      const responses = operation.responses as Record<string, Record<string, unknown>>;
      for (const [status, response] of Object.entries(responses)) {
        assert.match(status, /^\d{3}$/, `${method} ${path}: ${status} is not a status code`);
        assert.equal(typeof response.description, "string", `${method} ${path}: ${status} needs a description`);
        for (const mediaType of Object.keys((response.content as Record<string, unknown> | undefined) ?? {})) {
          assert.match(mediaType, /^[\w.+-]+\/[\w.+-]+$/, `${method} ${path}: ${mediaType} is not a media type`);
        }
      }
      for (const parameter of (operation.parameters as Array<Record<string, unknown>> | undefined) ?? []) {
        assert.equal(typeof parameter.name, "string");
        assert.ok(["path", "query", "header"].includes(String(parameter.in)), `${method} ${path}: parameter location ${String(parameter.in)}`);
        assert.equal(typeof parameter.schema, "object", `${method} ${path}: ${String(parameter.name)} needs a schema`);
        if (parameter.in === "path") assert.equal(parameter.required, true);
      }
      const requestBody = operation.requestBody as Record<string, unknown> | undefined;
      if (requestBody !== undefined) {
        assert.equal(typeof requestBody.description, "string", `${method} ${path}: requestBody needs a description`);
        assert.ok(Object.keys(requestBody.content as Record<string, unknown>).length > 0, `${method} ${path}: requestBody needs a media type`);
      }
    }
  }
});

test("every $ref resolves to a component schema", () => {
  for (const ref of collectRefs(OPENAPI_DOCUMENT)) {
    const name = ref.replace("#/components/schemas/", "");
    assert.equal(ref.startsWith("#/components/schemas/"), true, `unexpected ref ${ref}`);
    assert.ok(Object.hasOwn(SCHEMAS, name), `missing component schema ${name}`);
  }
});

test("authentication claims match the documented security posture", () => {
  const securityOf = (operation: Operation) => operation.security as Array<Record<string, unknown>>;
  for (const { path, method, operation } of operations()) {
    const security = securityOf(operation);
    const responses = operation.responses as Record<string, unknown>;
    assert.equal(Object.hasOwn(responses, "401"), security.length > 0 && security.length === 1, `${method} ${path}: a 401 belongs only to a session-only operation`);

    if (security.length === 0) {
      assert.equal(Object.hasOwn(responses, "401"), false, `${method} ${path}: an anonymous operation cannot answer 401`);
      continue;
    }
    const requiresBearer = security.some((entry) => Object.hasOwn(entry, "bearerAuth"));
    assert.equal(requiresBearer, true, `${method} ${path}: a credentialed operation must name bearerAuth`);
    if (security.length > 1) {
      assert.deepEqual(security[0], {}, `${method} ${path}: the anonymous alternative must come first`);
    }
  }
});

test("the media library bounds in the document are the media service's bounds", () => {
  assert.equal(MEDIA_LIMIT_BOUNDS.default, MEDIA_PAGE_SIZE);
  assert.equal(MEDIA_LIMIT_BOUNDS.max, MEDIA_PAGE_SIZE_MAX);
  assert.equal(MEDIA_LIMIT_BOUNDS.min, 1);
});

test("the document never claims a closed object", () => {
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const record = value as Record<string, unknown>;
    assert.notEqual(record.additionalProperties, false, `${path} claims additionalProperties: false`);
    for (const [key, entry] of Object.entries(record)) walk(entry, `${path}.${key}`);
  };
  walk(OPENAPI_DOCUMENT, "document");
});

test("generation is deterministic and every operation has metadata", () => {
  const rebuilt = `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
  assert.equal(rebuilt, OPENAPI_DOCUMENT_JSON, "two builds must produce identical bytes");
  assert.equal(OPENAPI_DOCUMENT_JSON.endsWith("\n"), true);

  assert.equal(Object.keys(OPERATIONS).length, operations().length, "one metadata row per operation, no leftovers");
  for (const [key, metadata] of Object.entries(OPERATIONS)) {
    assert.ok(metadata.summary.length > 0, `${key} needs a summary`);
    const [method] = key.split(" ") as [HttpMethod];
    assert.ok(["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method), `${key} names a real method`);
    assert.ok(operationKey(method, key.slice(method.length + 1)) === key);
  }
});
