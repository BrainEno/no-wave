import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleCatalogueArticleRequest } from "@no-wave/web-http";
import { apiProxyConfig } from "../lib/runtime.ts";

export function loader({ request, params }: LoaderFunctionArgs) { return handleCatalogueArticleRequest(request, { id: params.id ?? "" }, apiProxyConfig()); }
export function action({ request, params }: ActionFunctionArgs) { return handleCatalogueArticleRequest(request, { id: params.id ?? "" }, apiProxyConfig()); }
