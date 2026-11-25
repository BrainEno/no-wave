import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleCatalogueRestoreRequest } from "@no-wave/web-http";
import { apiProxyConfig } from "../lib/runtime.ts";

export function loader({ request, params }: LoaderFunctionArgs) { return handleCatalogueRestoreRequest(request, { id: params.id ?? "" }, apiProxyConfig()); }
export function action({ request, params }: ActionFunctionArgs) { return handleCatalogueRestoreRequest(request, { id: params.id ?? "" }, apiProxyConfig()); }
