import type { LoaderFunctionArgs } from "react-router";
import { handleAuthoringDeletedArticles } from "../lib/authoring-proxy.ts";

/**
 * `GET /api/authoring/deleted-articles` — resource route, no component.
 *
 * The desk's recycle bin. A read, so it is a loader rather than an action; the
 * shared handler still owns the no-store policy and the token handling, so the
 * prototype cannot drift from the App Router.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  return handleAuthoringDeletedArticles(request);
}
