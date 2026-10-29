import {
  handleAuthoringArticleRequest,
  handleAuthoringArticlesRequest,
  handleAuthoringSessionRequest,
} from "@bot-thk/web-http";
import { optionalApiBaseUrl } from "./runtime.ts";

/**
 * React Router binding for the writing desk's API (ADR 0012, Phase 4b).
 *
 * The session, list, create and update calls are one implementation in
 * `@bot-thk/web-http`, shared with the App Router's route handlers; the only
 * framework-specific step left is resolving the server-only API origin, exactly
 * like `auth-proxy.ts` and the media and comments adapters.
 */
export function handleAuthoringSession(request: Request): Promise<Response> {
  return handleAuthoringSessionRequest(request, { apiBaseUrl: optionalApiBaseUrl() });
}

export function handleAuthoringArticles(request: Request): Promise<Response> {
  return handleAuthoringArticlesRequest(request, { apiBaseUrl: optionalApiBaseUrl() });
}

export function handleAuthoringArticle(request: Request, id: string | undefined): Promise<Response> {
  return handleAuthoringArticleRequest(request, { id: id ?? "" }, { apiBaseUrl: optionalApiBaseUrl() });
}
