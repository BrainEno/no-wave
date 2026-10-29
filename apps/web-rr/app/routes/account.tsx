import { data, redirect, useLoaderData } from "react-router";
import type { HeadersFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { ACCESS_TOKEN_COOKIE } from "@/lib/authoring-proxy-policy.ts";
import { apiBaseUrl } from "../lib/runtime.ts";

/**
 * Private route.
 *
 * Three properties are asserted by `test/prototype.test.ts`:
 *   1. signed out      -> redirect to `/sign-in`, never an empty 200 page;
 *   2. signed in       -> `Cache-Control: no-store` so no shared cache can keep it;
 *   3. rendered HTML   -> contains the display name and **no** token value.
 */
function accessToken(request: Request): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === ACCESS_TOKEN_COOKIE) return part.slice(separator + 1).trim();
  }
  return undefined;
}

type Profile = { userId: string; displayName: string; email: string };

function isProfile(value: unknown): value is Profile {
  return typeof value === "object" && value !== null &&
    typeof (value as Profile).userId === "string" &&
    typeof (value as Profile).displayName === "string" &&
    typeof (value as Profile).email === "string";
}

export async function loader({ request }: LoaderFunctionArgs) {
  const token = accessToken(request);
  if (!token) throw redirect("/sign-in?next=%2Faccount");

  const base = apiBaseUrl();
  if (!base) throw data({ reason: "api-unconfigured" }, { status: 503 });

  let response: Response;
  try {
    response = await fetch(new URL("api/v1/me", `${base.replace(/\/+$/, "")}/`), {
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
      cache: "no-store",
    });
  } catch {
    throw data({ reason: "api-unreachable" }, { status: 502 });
  }

  // An expired or forged token is not an error page: it is a signed-out visitor.
  if (response.status === 401) throw redirect("/sign-in?next=%2Faccount");
  if (!response.ok) throw data({ reason: "api-error", status: response.status }, { status: 502 });

  const payload: unknown = await response.json().catch(() => null);
  const candidate = typeof payload === "object" && payload !== null && "data" in payload
    ? (payload as { data: unknown }).data
    : null;
  if (!isProfile(candidate)) throw data({ reason: "api-invalid-response" }, { status: 502 });

  return { profile: { userId: candidate.userId, displayName: candidate.displayName, email: candidate.email } };
}

export const headers: HeadersFunction = () => ({ "Cache-Control": "no-store, max-age=0" });

export const meta: MetaFunction = () => [
  { title: "我的账户 | 无浪潮" },
  { name: "robots", content: "noindex, nofollow" },
];

export default function AccountRoute() {
  const { profile } = useLoaderData<typeof loader>();
  return (
    <main className="nw-w" data-route="account">
      <h1 data-reveal>我的账户</h1>
      <p className="nw-m" data-session-state="authenticated">已登录</p>
      <dl>
        <dt>显示名称</dt><dd data-account-name>{profile.displayName}</dd>
        <dt>邮箱</dt><dd>{profile.email}</dd>
        <dt>用户 ID</dt><dd>{profile.userId}</dd>
      </dl>
      <p className="nw-ep">此页面按请求渲染且不可缓存；令牌只存在于 HttpOnly cookie 中。</p>
    </main>
  );
}
