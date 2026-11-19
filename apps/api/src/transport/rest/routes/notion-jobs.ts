import { NOTION_JOB_ETAG_PATTERN } from "../../../application/notion-job-poll.ts";
import { NotionBundleError } from "../../../application/notion-bundle.ts";
import { NotionJobError, validNotionJobId } from "../../../application/notion-durable-jobs.ts";
import { MAX_NOTION_JOB_PAYLOAD_BYTES } from "../../../application/notion-import-job-payload.ts";
import { MAX_NOTION_PLAN_TOKEN_BYTES } from "../../../application/notion-import-plan.ts";
import {
  authenticatedActorId, parseInteger, readJsonObject, sendBadInput, sendJson, sendJsonBodyError,
  sendServiceError, sendUnauthenticated, sendUnavailable,
} from "../http.ts";
import type { RestRouteContext } from "./context.ts";

export const NOTION_JOB_ROUTE_IDS: readonly string[] = Object.freeze(["imports.notion.jobs", "imports.notion.jobs.item"]);
const MAX_REQUEST_BYTES = MAX_NOTION_JOB_PAYLOAD_BYTES + MAX_NOTION_PLAN_TOKEN_BYTES + 1024;
const notFound = (ctx: RestRouteContext) => sendJson(ctx.response, 404, { error: { code: "NOT_FOUND", message: "The import job was not found." } });

/** Session-only, owner-filtered operations. HTTP bodies can never supply a lease or actor. */
export async function handleNotionJobRoutes(ctx: RestRouteContext): Promise<boolean> {
  if (!NOTION_JOB_ROUTE_IDS.includes(ctx.routeId ?? "")) return false;
  const { services, request, response, url, notionJobs } = ctx;
  response.setHeader("x-robots-tag", "noindex, nofollow");
  if (!services) { sendUnavailable(response); return true; }
  try {
    const actorId = await authenticatedActorId(request, services, ctx.env);
    if (!actorId) { sendUnauthenticated(response); return true; }
    if (ctx.routeId === "imports.notion.jobs.item") {
      const jobId = ctx.routeParams.jobId;
      if (!validNotionJobId(jobId)) { notFound(ctx); return true; }
      if (url.search) { sendBadInput(response, "Import job status does not accept query parameters."); return true; }
      // Cancellation/status remain available when new admissions are disabled or a key is lost.
      let status;
      if (request.method === "DELETE") status = await services.cancelNotionImportJob({ actorId, jobId });
      else {
        const etag = request.headers["if-none-match"], prefer = request.headers.prefer;
        if ((etag !== undefined && (typeof etag !== "string" || !NOTION_JOB_ETAG_PATTERN.test(etag))) ||
            (prefer !== undefined && (typeof prefer !== "string" || !/^wait=[0-5]$/.test(prefer)))) {
          sendBadInput(response, "Use one strong job ETag and Prefer: wait=0..5.");
          return true;
        }
        if (!ctx.notionPoller) { sendUnavailable(response); return true; }
        const controller = new AbortController();
        const disconnect = () => controller.abort();
        response.once("close", disconnect);
        try {
          const polled = await ctx.notionPoller.wait({ actorId, jobId, etag,
            waitMs: prefer === undefined ? 0 : Number(prefer.slice(5)) * 1000, signal: controller.signal });
          status = polled.status;
          if (polled.etag) response.setHeader("etag", polled.etag);
          if (status?.state === "queued" || status?.state === "running") response.setHeader("retry-after", "2");
          if (polled.notModified) {
            response.writeHead(304, { "cache-control": "no-store" });
            response.end();
            return true;
          }
        } finally { response.off("close", disconnect); }
      }
      if (!status) { notFound(ctx); return true; }
      if (status.state === "queued" || status.state === "running") response.setHeader("retry-after", "2");
      sendJson(response, 200, { data: status });
      return true;
    }
    if (request.method === "GET") {
      const requestKey = request.headers["idempotency-key"];
      if (requestKey !== undefined) {
        if (typeof requestKey !== "string" || url.search) throw new NotionJobError("IMPORT_JOB_INPUT_INVALID");
        const found = await services.findMyNotionImportJobRequest({ actorId, requestKey });
        sendJson(response, 200, { data: found ? [found] : [] });
        return true;
      }
      if ([...url.searchParams.keys()].some(key => key !== "limit")) {
        sendBadInput(response, "Only the limit query parameter is supported.");
        return true;
      }
      const limit = parseInteger(url.searchParams, "limit", 20, 1, 20);
      if (limit === null) { sendBadInput(response); return true; }
      sendJson(response, 200, { data: await services.listMyNotionImportJobs({ actorId, limit }) });
      return true;
    }
    if (!notionJobs) throw new NotionJobError("IMPORT_JOBS_DISABLED");
    if (url.search) { sendBadInput(response, "Starting an import job does not accept query parameters."); return true; }
    const body = await readJsonObject(request, MAX_REQUEST_BYTES);
    if (!body.ok) { sendJsonBodyError(response, request, body); return true; }
    const keys = Object.keys(body.value);
    if (keys.some(key => key !== "bundle" && key !== "planToken") || !("bundle" in body.value) || !("planToken" in body.value)) {
      throw new NotionJobError("IMPORT_JOB_INPUT_INVALID");
    }
    if (Buffer.byteLength(JSON.stringify(body.value.bundle)) > MAX_NOTION_JOB_PAYLOAD_BYTES) {
      sendJson(response, 413, { error: { code: "PAYLOAD_TOO_LARGE", message: "The bundle exceeds the 8 MiB limit." } });
      return true;
    }
    const status = await notionJobs.start({ actorId, bundle: body.value.bundle, planToken: body.value.planToken,
      idempotencyKey: request.headers["idempotency-key"] });
    response.setHeader("location", `/api/v1/imports/notion/jobs/${status.id}`);
    if (status.state === "queued" || status.state === "running") response.setHeader("retry-after", "2");
    sendJson(response, 202, { data: status });
  } catch (error) {
    if (response.destroyed || response.writableEnded) return true;
    if (error instanceof NotionJobError) {
      if (error.status === 429 || error.status === 503) response.setHeader("retry-after", error.status === 429 ? "60" : "2");
      sendJson(response, error.status, { error: { code: error.code, message: error.message } });
    } else if (error instanceof NotionBundleError) {
      sendBadInput(response, "A valid Notion bundle is required.");
    } else sendServiceError(response, error);
  }
  return true;
}
