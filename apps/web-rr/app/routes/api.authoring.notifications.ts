import type { LoaderFunctionArgs } from "react-router";
import { handleNotifications } from "../lib/notifications-proxy.ts";

/**
 * `GET /api/authoring/notifications` — resource route, no component.
 *
 * The signed-in reader's inbox: the notice a commenter gets when a work they
 * commented on is deleted. A read, so it is a loader rather than an action; the
 * shared handler still owns the no-store policy and the token handling, so the
 * prototype cannot drift from the App Router.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  return handleNotifications(request);
}
