import type { ActionFunctionArgs } from "react-router";
import { handleAccountEmailChange } from "../lib/account-proxy.ts";

/**
 * `PUT /api/authoring/email` — resource route, no component.
 *
 * Moving the address is a write, so the Origin check applies; the identity is
 * the session cookie the proxy attaches, so the route itself only carries the
 * new address and the password that proves the change is the owner's.
 */
export async function action({ request }: ActionFunctionArgs) {
  return handleAccountEmailChange(request);
}
