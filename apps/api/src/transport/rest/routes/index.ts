import type { RestRouteGroup } from "./context.ts";
import { handleAuthRoutes } from "./auth.ts";
import { handleMediaRoutes } from "./media.ts";
import { handleHealthRoute } from "./health.ts";
import { handleIdentityRoutes } from "./identity.ts";
import { handleNotificationRoutes } from "./notifications.ts";
import { handleConversationRoutes } from "./conversations.ts";
import { handleArticleRoutes } from "./articles.ts";
import { handleAuthorRoutes } from "./authors.ts";
import { handleTaxonomyRoutes } from "./taxonomies.ts";
import { enforceWriteRateLimit } from "./write-rate-limit.ts";

/**
 * Dispatch order for the REST transport.
 *
 * Every group is id-guarded, so the order only matters where it always mattered:
 * identity actions run before the generic write rate limiter, and the rate
 * limiter runs before any group that can read a request body or touch
 * persistence. The route table (`../routes.ts`) still owns path matching, the
 * allowed methods and the 405 allow-list; this list only decides who handles a
 * route that already matched.
 */
export const REST_ROUTE_GROUPS: readonly RestRouteGroup[] = Object.freeze([
  handleAuthRoutes,
  enforceWriteRateLimit,
  handleMediaRoutes,
  handleHealthRoute,
  handleIdentityRoutes,
  handleNotificationRoutes,
  handleConversationRoutes,
  handleArticleRoutes,
  handleAuthorRoutes,
  handleTaxonomyRoutes,
]);
