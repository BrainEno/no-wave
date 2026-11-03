import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleAuthoringProfile } from "../lib/authoring-proxy.ts";

/** `GET`/`PUT /api/authoring/profile` — resource route, no component. */
export async function loader({ request }: LoaderFunctionArgs) {
  return handleAuthoringProfile(request);
}

export async function action({ request }: ActionFunctionArgs) {
  return handleAuthoringProfile(request);
}
