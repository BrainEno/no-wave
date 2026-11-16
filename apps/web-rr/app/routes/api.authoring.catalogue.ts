import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleAuthoringCatalogue } from "../lib/authoring-proxy.ts";

export function loader({ request }: LoaderFunctionArgs) { return handleAuthoringCatalogue(request); }
export function action({ request }: ActionFunctionArgs) { return handleAuthoringCatalogue(request); }
