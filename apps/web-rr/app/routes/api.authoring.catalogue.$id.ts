import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleAuthoringCatalogueArticle } from "../lib/authoring-proxy.ts";

export function loader({ request, params }: LoaderFunctionArgs) { return handleAuthoringCatalogueArticle(request, params.id); }
export function action({ request, params }: ActionFunctionArgs) { return handleAuthoringCatalogueArticle(request, params.id); }
