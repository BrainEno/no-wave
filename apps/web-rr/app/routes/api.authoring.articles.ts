import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleAuthoringArticles } from "../lib/authoring-proxy.ts";

/**
 * `GET`/`POST /api/authoring/articles` — resource route, no component.
 *
 * The desk's list and its "save draft"/"publish" write. Both go through the
 * shared handler, so the Origin check, the body ceiling and the token handling
 * cannot drift between the two frameworks.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  return handleAuthoringArticles(request);
}

export async function action({ request }: ActionFunctionArgs) {
  return handleAuthoringArticles(request);
}
