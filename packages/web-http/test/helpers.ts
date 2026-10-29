import assert from "node:assert/strict";

/**
 * Shared fixtures for the contract tests.
 *
 * The handlers take an injected `fetchImpl`, so the tests stay deterministic and
 * offline while still exercising the real request/response mapping.
 */

export const API_BASE = "https://api.example.test";

export const TOKENS = {
  accessToken: `access-token-${"a".repeat(32)}`,
  refreshToken: "r".repeat(43),
  tokenType: "Bearer" as const,
  accessExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  refreshExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
};

export const ROTATED = {
  accessToken: `rotated-access-${"b".repeat(32)}`,
  refreshToken: "s".repeat(43),
  tokenType: "Bearer" as const,
  accessExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  refreshExpiresAt: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString(),
};

export type StubCall = { url: string; init: RequestInit | undefined };

export type StubFetch = {
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  calls: StubCall[];
};

/**
 * Route stub: the first handler whose key matches the request URL (substring
 * match) wins, so tests can register `api/v1/me/articles` without caring about
 * the full origin.
 */
export function stubFetch(
  handlers: Record<string, (call: StubCall) => Response | Promise<Response>>,
  fallback: (call: StubCall) => Response = () => json({ error: { code: "NOT_STUBBED", message: "no stub" } }, 404),
): StubFetch {
  const calls: StubCall[] = [];
  return {
    calls,
    async fetchImpl(input, init) {
      const call: StubCall = { url: input, init };
      calls.push(call);
      for (const [needle, handler] of Object.entries(handlers)) {
        if (input.includes(needle)) return handler(call);
      }
      return fallback(call);
    },
  };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function tokenEnvelope(tokens: typeof TOKENS | typeof ROTATED = TOKENS, status = 200): Response {
  return json({ data: tokens }, status);
}

export function request(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Request {
  return new Request(`https://no-wave.test${path}`, {
    method: init.method ?? "POST",
    headers: { origin: "https://no-wave.test", "content-type": "application/json", ...init.headers },
    ...(init.body === undefined ? {} : { body: init.body }),
  });
}

export function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

export function findCookie(response: Response, name: string): string | undefined {
  return setCookies(response).find((cookie) => cookie.startsWith(`${name}=`));
}

/** Assert the response carries the standard private cache policy. */
export function assertNoStore(response: Response): void {
  assert.match(response.headers.get("cache-control") ?? "", /no-store/, "every proxied response must be no-store");
}
