import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleCatalogueEditionsRequest } from "@no-wave/web-http";
import { apiProxyConfig } from "../lib/runtime.ts";

export function loader({ request, params }: LoaderFunctionArgs) { return handleCatalogueEditionsRequest(request, { id: params.id ?? "" }, apiProxyConfig()); }
export function action({ request, params }: ActionFunctionArgs) { return handleCatalogueEditionsRequest(request, { id: params.id ?? "" }, apiProxyConfig()); }
