import { REST_ROUTES, type HttpMethod, type RestRoute } from "../routes.ts";
import {
  ERROR_DESCRIPTIONS,
  OPERATIONS,
  assertOperationsMatchRoutes,
  operationKey,
  type OperationMetadata,
  type QueryParameter,
} from "./operations.ts";
import { SCHEMAS } from "./schemas.ts";

/**
 * Builds the OpenAPI 3.1 document from the route table.
 *
 * The split matters: `../routes.ts` decides which URLs and methods exist, so it
 * is also the only thing that decides which paths and operations appear here.
 * Adding a route without documenting it fails at start-up (see
 * `assertOperationsMatchRoutes`), and a documented operation with no route fails
 * the same way. Nothing in this file enumerates endpoints by hand.
 *
 * The output is deterministic — paths sorted, methods in a fixed order, two-space
 * JSON — because it is checked in as `docs/api/openapi.json` and compared
 * byte-for-byte by the `openapi:check` script. A document that reordered itself
 * between runs would make that check useless.
 */

export const REST_PREFIX = "/api/v1";

/** The address that serves this document. */
export const OPENAPI_PATH = `${REST_PREFIX}/openapi.json`;

/** The canonical order methods appear in a path item. */
const METHOD_ORDER: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** The path of a route, with `{parameters}` in the OpenAPI spelling. */
export function pathOf(route: RestRoute): string {
  const segments = route.segments.map((segment) => (segment.kind === "literal" ? segment.value : `{${segment.name}}`));
  return `${REST_PREFIX}/${segments.join("/")}`;
}

function pathParameters(route: RestRoute, metadata: OperationMetadata): ReadonlyArray<Record<string, unknown>> {
  return route.segments
    .filter((segment) => segment.kind === "param")
    .map((segment) => {
      if (segment.kind !== "param") throw new Error("unreachable");
      const values = segment.values;
      return {
        name: segment.name,
        in: "path",
        required: true,
        description:
          metadata.pathParams?.[segment.name] ??
          "Opaque identifier taken verbatim from the path: decodable, non-empty, at most 300 characters, no surrounding whitespace. Its shape is not validated here — an id that names nothing is a 404 from the store.",
        schema:
          values === undefined
            ? { type: "string", maxLength: 300 }
            : { type: "string", enum: [...values], maxLength: 300 },
      };
    });
}

function queryParameters(parameters: readonly QueryParameter[] | undefined): ReadonlyArray<Record<string, unknown>> {
  return (parameters ?? []).map((parameter) => ({
    name: parameter.name,
    in: "query",
    required: parameter.required ?? false,
    description: parameter.description,
    schema: parameter.schema,
  }));
}

function idempotencyParameter(mode: "optional" | "required" | undefined): ReadonlyArray<Record<string, unknown>> {
  if (mode === undefined) return [];
  return [
    {
      name: "Idempotency-Key",
      in: "header",
      required: mode === "required",
      description:
        mode === "required"
          ? "Required. A replay with the same key and the same request returns the row the first attempt stored; the same key with a different request is `409 IDEMPOTENCY_CONFLICT`."
          : "Optional. With it, a retry with the same key and the same request returns the row the first attempt stored; without it there is no replay protection.",
      schema: { type: "string", minLength: 1, maxLength: 300, pattern: "^\\S(?:.*\\S)?$" },
    },
  ];
}

/** `[]` means public; an empty object in the list means "anonymous is also fine". */
function securityFor(metadata: OperationMetadata): ReadonlyArray<Record<string, readonly string[]>> {
  if (metadata.security === "none") return [];
  if (metadata.security === "session") return [{ bearerAuth: [] }];
  return [{}, { bearerAuth: [] }];
}

function responseFor(metadata: OperationMetadata): Record<string, unknown> {
  const status = metadata.response.status ?? 200;
  const contentType = metadata.response.contentType ?? "application/json";
  let schema: Record<string, unknown> | undefined;

  if (metadata.response.array === true && metadata.response.data !== undefined) {
    schema = { type: "object", required: ["data"], properties: { data: { type: "array", items: { $ref: `#/components/schemas/${metadata.response.data}` } } } };
  } else if (metadata.response.data !== undefined) {
    schema = { type: "object", required: ["data"], properties: { data: { $ref: `#/components/schemas/${metadata.response.data}` } } };
  } else if (metadata.response.scalar !== undefined) {
    schema = { type: "object", required: ["data"], properties: { data: { type: metadata.response.scalar } } };
  }

  if (metadata.response.meta === true && schema !== undefined) {
    schema = {
      ...schema,
      properties: {
        ...(schema.properties as Record<string, unknown>),
        meta: { type: "object", description: "Response metadata, for example `locales` on a multi-locale author read." },
      },
    };
  }

  const response: Record<string, unknown> = { description: metadata.response.description };
  response.content = schema === undefined ? { [contentType]: {} } : { [contentType]: { schema } };
  return response;
}

function responsesFor(metadata: OperationMetadata): Record<string, unknown> {
  const responses: Record<string, unknown> = {};
  responses[String(metadata.response.status ?? 200)] = responseFor(metadata);

  // `optional-session` operations answer anonymously, so a 401 would be a lie.
  const statuses = new Set<number>([400, ...(metadata.security === "session" ? [401] : []), ...(metadata.errors ?? [])]);
  for (const status of [...statuses].sort((left, right) => left - right)) {
    const description = ERROR_DESCRIPTIONS[status];
    if (description === undefined) throw new Error(`No description for error status ${status}.`);
    responses[String(status)] = {
      description,
      content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
    };
  }
  return responses;
}

function operationFor(route: RestRoute, method: HttpMethod, metadata: OperationMetadata): Record<string, unknown> {
  const operation: Record<string, unknown> = {
    tags: [...metadata.tags],
    summary: metadata.summary,
    operationId: `${route.id}.${method.toLowerCase()}`,
    responses: responsesFor(metadata),
    security: securityFor(metadata),
  };
  if (metadata.description !== undefined) operation.description = metadata.description;

  const parameters = [
    ...pathParameters(route, metadata),
    ...queryParameters(metadata.query),
    ...idempotencyParameter(metadata.idempotency),
  ];
  if (parameters.length > 0) operation.parameters = parameters;

  if (metadata.requestBody !== undefined) {
    operation.requestBody = {
      required: metadata.requestBody.required ?? true,
      description: metadata.requestBody.description,
      content: {
        [metadata.requestBody.contentType ?? "application/json"]: {
          // A binary request body has no JSON schema; the media upload documents
          // the bytes with a media type rather than pretending they are an object.
          schema: metadata.requestBody.contentType === undefined
            ? { $ref: `#/components/schemas/${metadata.requestBody.schema}` }
            : { type: "string", format: "binary" },
        },
      },
    };
  }
  return operation;
}

function info(): Record<string, unknown> {
  return {
    title: "No Wave REST API",
    version: "1.0.0",
    summary: "The versioned REST contract under /api/v1.",
    description: [
      "This document is generated from the API's own route table (`apps/api/src/transport/rest/routes.ts`), so an endpoint that is not listed here does not exist, and an endpoint that exists is listed here.",
      "",
      "Conventions that hold for every operation:",
      "",
      "- Bearer authentication: `Authorization: Bearer <accessToken>`. Private routes derive the acting account from the token and never accept a client-supplied actor or owner id.",
      "- `Cache-Control: no-store` on JSON responses; uploaded images are immutable and cached for a year.",
      "- JSON write bodies require `Content-Type: application/json`, are limited in size, and reject unsupported fields rather than ignoring them.",
      "- Errors are `{\"error\":{\"code\",\"message\"}}` with stable codes; messages are sanitized.",
      "- Article locales are `zh-CN`, `zh-TW` and `en`. An omitted locale means `zh-CN`.",
      "- Discovery lists accept `limit` and `offset`; article discovery also accepts a `cursor` with `sort=latest`.",
    ].join("\n"),
    license: { name: "See the repository's LICENSE file." },
  };
}

/** Assembles the whole document. Pure: same input, same bytes, every run. */
export function buildOpenApiDocument(routes: readonly RestRoute[] = REST_ROUTES): Record<string, unknown> {
  assertOperationsMatchRoutes(routes);

  const paths = new Map<string, Map<HttpMethod, Record<string, unknown>>>();
  for (const route of routes) {
    const path = pathOf(route);
    const item = paths.get(path) ?? new Map<HttpMethod, Record<string, unknown>>();
    for (const method of route.methods) {
      const metadata = OPERATIONS[operationKey(method, route.id)];
      if (metadata === undefined) throw new Error(`No metadata for ${operationKey(method, route.id)}.`);
      item.set(method, operationFor(route, method, metadata));
    }
    paths.set(path, item);
  }

  const pathItems: Record<string, unknown> = {};
  for (const path of [...paths.keys()].sort()) {
    const methods = paths.get(path);
    if (methods === undefined) continue;
    const item: Record<string, unknown> = {};
    for (const method of METHOD_ORDER) {
      const operation = methods.get(method);
      if (operation !== undefined) item[method.toLowerCase()] = operation;
    }
    pathItems[path] = item;
  }

  return {
    openapi: "3.1.0",
    info: info(),
    servers: [
      { url: "/", description: "The origin this document was served from." },
      { url: "http://localhost:4000", description: "Local development (`pnpm dev`)." },
    ],
    tags: [
      { name: "health", description: "Liveness and the contract itself." },
      { name: "identity", description: "Accounts, sessions, profiles and the follow graph." },
      { name: "articles", description: "The corpus: writing, editing, discovery, likes and the featured shelf." },
      { name: "comments", description: "Comments and replies." },
      { name: "taxonomy", description: "Categories (editorial) and tags (the author's own words)." },
      { name: "authors", description: "Public author profiles and the author directory." },
      { name: "media", description: "Image upload, the author's library and immutable image reads." },
      { name: "notifications", description: "The recipient's inbox." },
      { name: "conversations", description: "Direct conversations and messages." },
    ],
    paths: pathItems,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description:
            "A signed access token from `POST /auth/login` or `/auth/register`. It names the session it belongs to, so revoking that session stops it working before it expires.",
        },
      },
      schemas: SCHEMAS,
    },
    externalDocs: {
      description: "Generated-contract guide: how to regenerate, and what the document does and does not claim.",
      url: "https://github.com/BrainEno/no-wave/blob/main/docs/api/openapi.md",
    },
  };
}

/** The document, serialized once at import so both the HTTP route and the file agree. */
export const OPENAPI_DOCUMENT = Object.freeze(buildOpenApiDocument());
export const OPENAPI_DOCUMENT_JSON = `${JSON.stringify(OPENAPI_DOCUMENT, null, 2)}\n`;
