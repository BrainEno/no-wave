import type { LoaderFunctionArgs } from "react-router";
import { handleAuthoringNotionExport } from "../lib/authoring-proxy.ts";

/**
 * `GET /api/authoring/notion-export` — resource route, no component.
 *
 * The desk's "export to Notion" link downloads the author's own bundle. A read, so
 * it is a loader; the shared handler owns the slug check, the attachment header
 * and the token handling, exactly like the other authoring routes.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  return handleAuthoringNotionExport(request);
}
