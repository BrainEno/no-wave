import {
  handleAuthoringArticleRequest,
  handleAuthoringArticlesRequest,
  handleAuthoringDeletedArticlesRequest,
  handleAuthoringFeaturedCandidatesRequest,
  handleAuthoringFeaturedRequest,
  handleAuthoringProfileRequest,
  handleAuthoringRestoreRequest,
  handleAuthoringSessionRequest,
} from "@bot-thk/web-http";
import { apiProxyConfig } from "./runtime.ts";

/**
 * React Router binding for the writing desk's API (ADR 0012, Phase 4b).
 *
 * The session, list, create and update calls are one implementation in
 * `@bot-thk/web-http`, shared by every route that serves them; the only step
 * left here is resolving the server-only API origin, exactly
 * like `auth-proxy.ts` and the media and comments adapters.
 */
export function handleAuthoringSession(request: Request): Promise<Response> {
  return handleAuthoringSessionRequest(request, apiProxyConfig());
}

export function handleAuthoringArticles(request: Request): Promise<Response> {
  return handleAuthoringArticlesRequest(request, apiProxyConfig());
}

export function handleAuthoringProfile(request: Request): Promise<Response> {
  return handleAuthoringProfileRequest(request, apiProxyConfig());
}

export function handleAuthoringArticle(request: Request, id: string | undefined): Promise<Response> {
  return handleAuthoringArticleRequest(request, { id: id ?? "" }, apiProxyConfig());
}
export function handleAuthoringDeletedArticles(request: Request): Promise<Response> {
  return handleAuthoringDeletedArticlesRequest(request, apiProxyConfig());
}
export function handleAuthoringFeatured(request: Request): Promise<Response> {
  return handleAuthoringFeaturedRequest(request, apiProxyConfig());
}
export function handleAuthoringFeaturedCandidates(request: Request): Promise<Response> {
  return handleAuthoringFeaturedCandidatesRequest(request, apiProxyConfig());
}
export function handleAuthoringRestoreArticle(request: Request, id: string | undefined): Promise<Response> {
  return handleAuthoringRestoreRequest(request, { id: id ?? "" }, apiProxyConfig());
}
