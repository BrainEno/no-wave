import type { ActionFunctionArgs } from "react-router";
import { handleAccountPasswordChange } from "../lib/account-proxy.ts";

/**
 * `PUT /api/authoring/password` — resource route, no component.
 *
 * Changing a password is a write, so the Origin check applies; the identity is
 * the session cookie the proxy attaches, so the route itself only carries the
 * two credentials the visitor typed.
 */
export async function action({ request }: ActionFunctionArgs) {
  return handleAccountPasswordChange(request);
}
