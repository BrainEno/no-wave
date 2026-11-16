import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleAuthoringCatalogueEditions } from "../lib/authoring-proxy.ts";

export function loader({ request, params }: LoaderFunctionArgs) { return handleAuthoringCatalogueEditions(request, params.id); }
export function action({ request, params }: ActionFunctionArgs) { return handleAuthoringCatalogueEditions(request, params.id); }
