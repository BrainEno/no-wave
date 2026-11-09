import { assertWriteRateLimitsCoverRoutes } from "../../application/rate-limit.ts";

/**
 * Declarative REST route table.
 *
 * Before this table, the transport parsed the request path with ~30 regexes and
 * then re-derived permission for each method in a 26-branch `if` chain: the same
 * path appeared three times (parse, gate, dispatch) and adding one endpoint meant
 * keeping all three in sync by hand.
 *
 * The table is now the only place that knows a URL exists. It answers two
 * questions in one pass — which route is this, and which methods does it accept —
 * so the `405` allow-list is derived instead of maintained, and an unknown path
 * cannot accidentally be treated as a known one.
 *
 * Scope of this slice (issue #58, step 1): classification and method gating. The
 * per-route handler bodies still live in `handler.ts`; extracting them into
 * `routes/*.ts` modules is the next slice.
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

type RouteSegment =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "param"; readonly name: string; readonly values?: readonly string[] };

export type RestRoute = {
  /** Stable identifier used by the dispatcher. */
  readonly id: string;
  readonly methods: readonly HttpMethod[];
  /** Segments after `/api/v1`. */
  readonly segments: readonly RouteSegment[];
};

const literal = (value: string): RouteSegment => ({ kind: "literal", value });
const param = (name: string, values?: readonly string[]): RouteSegment =>
  values ? { kind: "param", name, values } : { kind: "param", name };

const AUTH_ACTIONS = ["register", "login", "refresh", "logout", "forgot-password", "reset-password", "verify-email"] as const;
const RELATIONS = ["followers", "following"] as const;

export const REST_ROUTES: readonly RestRoute[] = Object.freeze([
  { id: "health", methods: ["GET"], segments: [literal("health")] },
  // The contract endpoint. It is a route like any other on purpose: the document
  // is generated from this table, so serving it from the table keeps the answer
  // and the API's own idea of itself in one place (`./openapi/`).
  { id: "openapi", methods: ["GET"], segments: [literal("openapi.json")] },
  { id: "auth", methods: ["POST"], segments: [literal("auth"), param("action", AUTH_ACTIONS)] },

  { id: "me", methods: ["GET"], segments: [literal("me")] },
  { id: "me.profile", methods: ["GET", "PUT"], segments: [literal("me"), literal("profile")] },
  { id: "me.session", methods: ["DELETE"], segments: [literal("me"), literal("session")] },
  // Devices: the list is a read, `DELETE` on the collection ends every *other*
  // one, and `DELETE` on one id ends exactly that one.
  { id: "me.sessions", methods: ["GET", "DELETE"], segments: [literal("me"), literal("sessions")] },
  { id: "me.sessions.item", methods: ["DELETE"], segments: [literal("me"), literal("sessions"), param("sessionId")] },
  { id: "me.password", methods: ["PUT"], segments: [literal("me"), literal("password")] },
  { id: "me.email", methods: ["PUT"], segments: [literal("me"), literal("email")] },
  { id: "me.liked-articles", methods: ["GET"], segments: [literal("me"), literal("liked-articles")] },
  { id: "me.articles", methods: ["GET"], segments: [literal("me"), literal("articles")] },
  { id: "me.feed", methods: ["GET"], segments: [literal("me"), literal("feed")] },
  { id: "featured", methods: ["GET", "PUT"], segments: [literal("featured")] },
  {
    id: "me.deleted-articles",
    methods: ["GET"],
    segments: [literal("me"), literal("articles"), literal("deleted")],
  },
  { id: "me.email-verification", methods: ["POST"], segments: [literal("me"), literal("email-verification")] },
  // The media library: the collection is both the upload target and the author's
  // own list, and one asset is deleted by id (ADR 0022).
  { id: "me.media", methods: ["GET", "POST"], segments: [literal("me"), literal("media")] },
  { id: "me.media.item", methods: ["DELETE"], segments: [literal("me"), literal("media"), param("id")] },
  { id: "me.notifications", methods: ["GET"], segments: [literal("me"), literal("notifications")] },
  {
    id: "me.notifications.unread-count",
    methods: ["GET"],
    segments: [literal("me"), literal("notifications"), literal("unread-count")],
  },
  {
    id: "me.notifications.read-all",
    methods: ["POST"],
    segments: [literal("me"), literal("notifications"), literal("read-all")],
  },
  {
    id: "me.notifications.read",
    methods: ["PUT"],
    segments: [literal("me"), literal("notifications"), param("id"), literal("read")],
  },

  { id: "users", methods: ["GET"], segments: [literal("users")] },
  { id: "users.follow", methods: ["POST", "DELETE"], segments: [literal("users"), param("userId"), literal("follow")] },
  { id: "users.role", methods: ["PUT"], segments: [literal("users"), param("userId"), literal("role")] },
  {
    id: "users.relationships",
    methods: ["GET"],
    segments: [literal("users"), param("userId"), param("relation", RELATIONS)],
  },

  { id: "articles", methods: ["GET", "POST"], segments: [literal("articles")] },
  { id: "articles.item", methods: ["GET", "PUT", "DELETE"], segments: [literal("articles"), param("article")] },
  {
    id: "articles.restore",
    methods: ["POST"],
    segments: [literal("articles"), param("id"), literal("restore")],
  },
  { id: "articles.like", methods: ["GET", "PUT"], segments: [literal("articles"), param("slug"), literal("like")] },
  // A read is a `POST` here because it writes: the beacon a page sends once it
  // has actually rendered the work, never part of the cached `GET` (ADR 0035).
  { id: "articles.views", methods: ["POST"], segments: [literal("articles"), param("slug"), literal("views")] },
  {
    id: "articles.comments",
    methods: ["GET", "POST"],
    segments: [literal("articles"), param("slug"), literal("comments")],
  },
  { id: "articles.related", methods: ["GET"], segments: [literal("articles"), param("slug"), literal("related")] },
  // A comment can be corrected by its author (`PATCH`) and withdrawn by them
  // (`DELETE`); both address the same row and both answer `403` for somebody
  // else's comment, so neither can be used to probe which ids exist.
  { id: "comments.item", methods: ["PATCH", "DELETE"], segments: [literal("comments"), param("id")] },

  // Importing is a write on two axes at once — it can create works and tags — so
  // it is a `POST` that reports per page rather than a batch of ordinary creates
  // (ADR 0037). `apply` decides whether anything is written; the default dry run
  // is a read.
  { id: "imports.notion", methods: ["POST"], segments: [literal("imports"), literal("notion")] },

  { id: "tags", methods: ["GET", "POST"], segments: [literal("tags")] },
  { id: "tags.item", methods: ["GET"], segments: [literal("tags"), param("slug")] },
  { id: "tags.articles", methods: ["GET"], segments: [literal("tags"), param("slug"), literal("articles")] },
  { id: "taxonomies", methods: ["POST"], segments: [literal("taxonomies")] },
  { id: "taxonomies.item", methods: ["DELETE"], segments: [literal("taxonomies"), param("id")] },
  { id: "categories", methods: ["GET"], segments: [literal("categories")] },
  { id: "categories.item", methods: ["GET"], segments: [literal("categories"), param("slug")] },
  {
    id: "categories.articles",
    methods: ["GET"],
    segments: [literal("categories"), param("slug"), literal("articles")],
  },
  // The collection first: `/authors` is the public directory (ADR 0024), and it
  // must not be swallowed by the `/authors/:userId` pattern below it.
  { id: "authors", methods: ["GET"], segments: [literal("authors")] },
  { id: "authors.item", methods: ["GET"], segments: [literal("authors"), param("userId")] },
  { id: "authors.articles", methods: ["GET"], segments: [literal("authors"), param("userId"), literal("articles")] },
  { id: "media.item", methods: ["GET"], segments: [literal("media"), param("id")] },

  { id: "conversations", methods: ["GET", "POST"], segments: [literal("conversations")] },
  {
    id: "conversations.messages",
    methods: ["GET", "POST"],
    segments: [literal("conversations"), param("id"), literal("messages")],
  },
  {
    id: "conversations.participants",
    methods: ["PATCH"],
    segments: [literal("conversations"), param("id"), literal("participants")],
  },
  {
    id: "conversations.read",
    methods: ["PUT"],
    segments: [literal("conversations"), param("id"), literal("read")],
  },
  { id: "conversations.item", methods: ["GET", "DELETE"], segments: [literal("conversations"), param("id")] },
]);

/**
 * Refuse to start when a mutating route has no rate-limit policy (ADR 0011).
 *
 * This runs at module load because the table above is the only thing that knows a
 * route exists: a route added, renamed or deleted without its policy must fail
 * here — and in the test that calls the same check — rather than go quietly
 * unthrottled in production. Shipping exactly that used to be possible, because the
 * limiter kept its own hand-written list of paths.
 */
assertWriteRateLimitsCoverRoutes(REST_ROUTES);

export type RouteResolution =
  | { readonly kind: "matched"; readonly id: string; readonly params: Readonly<Record<string, string>> }
  | { readonly kind: "method_not_allowed"; readonly allow: string }
  | { readonly kind: "unmatched" };

/**
 * Match once per request.
 *
 * `/api/v1` and `/api/v1/` are not routes: they fall through as `unmatched` so the
 * transport keeps answering them the way it always has.
 */
export function resolveRestRoute(pathname: string, method: string): RouteResolution {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 2 || segments[0] !== "api" || segments[1] !== "v1") return { kind: "unmatched" };
  const rest = segments.slice(2);
  if (rest.length === 0) return { kind: "unmatched" };

  for (const route of REST_ROUTES) {
    if (route.segments.length !== rest.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (let index = 0; index < route.segments.length; index += 1) {
      const pattern = route.segments[index]!;
      const value = rest[index]!;
      if (pattern.kind === "literal") {
        if (pattern.value !== value) { matched = false; break; }
        continue;
      }
      if (pattern.values && !pattern.values.includes(value)) { matched = false; break; }
      params[pattern.name] = value;
    }
    if (!matched) continue;
    if (!route.methods.includes(method as HttpMethod)) {
      return { kind: "method_not_allowed", allow: route.methods.join(", ") };
    }
    return { kind: "matched", id: route.id, params };
  }

  // An unknown path only answers 405 for non-GET methods, matching the previous
  // catch-all: reads fall through to the GET dispatch (and its 404), writes are
  // rejected before any handler runs.
  if (method !== "GET") return { kind: "method_not_allowed", allow: "GET" };
  return { kind: "unmatched" };
}
