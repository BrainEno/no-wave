import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleAuthoringCatalogueRestore } from "../lib/authoring-proxy.ts";

export function loader({ request, params }: LoaderFunctionArgs) { return handleAuthoringCatalogueRestore(request, params.id); }
export function action({ request, params }: ActionFunctionArgs) { return handleAuthoringCatalogueRestore(request, params.id); }
