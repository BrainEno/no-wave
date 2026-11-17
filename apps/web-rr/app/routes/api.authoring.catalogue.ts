import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleArticleCatalogueRequest } from "@bot-thk/web-http";
import { apiProxyConfig } from "../lib/runtime.ts";

export function loader({ request }: LoaderFunctionArgs) { return handleArticleCatalogueRequest(request, apiProxyConfig()); }
export function action({ request }: ActionFunctionArgs) { return handleArticleCatalogueRequest(request, apiProxyConfig()); }
