import {
  redirect,
  type HeadersFunction,
  type LoaderFunctionArgs,
  type MetaFunction,
} from "react-router";
import { LocalWritingVault } from "@/components/authoring/writing-vault-workbench.tsx";
import { PRIVATE_PAGE_HEADERS } from "../lib/http-policy.ts";

/** No password, filename, file address or account state can be supplied by this loader. */
export function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  if (url.pathname !== "/write/vault" || url.search)
    throw redirect("/write/vault", { headers: PRIVATE_PAGE_HEADERS });
  return null;
}
export const headers: HeadersFunction = () => PRIVATE_PAGE_HEADERS;
export const meta: MetaFunction = () => [
  { title: "本机文稿加密备份 | 无浪潮" },
  { name: "robots", content: "noindex, nofollow" },
];
export default function WriteVaultRoute() {
  return (
    <main
      id="top"
      tabIndex={-1}
      className="nw-w nw-head nw-private-page"
      data-route="write-vault"
    >
      <LocalWritingVault />
    </main>
  );
}
