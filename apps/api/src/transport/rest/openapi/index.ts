/**
 * The published REST contract.
 *
 * `document.ts` assembles the OpenAPI 3.1 document from the route table,
 * `operations.ts` holds the one line of prose each operation needs, and
 * `schemas.ts` holds the component schemas. `scripts/generate-openapi.ts` writes
 * the same document to `docs/api/openapi.json`, and `GET /api/v1/openapi.json`
 * serves it, so the checked-in file, the served document and the route table are
 * three views of one definition.
 */
export { OPENAPI_DOCUMENT, OPENAPI_DOCUMENT_JSON, OPENAPI_PATH, REST_PREFIX, buildOpenApiDocument, pathOf } from "./document.ts";
export { ERROR_DESCRIPTIONS, OPERATIONS, assertOperationsMatchRoutes, operationKey } from "./operations.ts";
export { SCHEMAS } from "./schemas.ts";
