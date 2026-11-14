import { expect, type Page } from "@playwright/test";

/** No mounted private readers may race a deliberate cookie transition. A JSON
 * /healthz document now correctly has default-src 'none', so it is not a fetch
 * harness. Borrow a real HTML response's enforcing policy for an explicitly
 * synthetic, script-free document; the browser's actual cookie jar, paths,
 * same-origin fetches and real API/DB still do all authentication work. */
export async function openCookieProbe(page: Page, origin: string): Promise<void> {
  const source = await page.context().request.get(`${origin}/sign-in`);
  expect(source.status()).toBe(200);
  const headers = source.headers();
  expect(headers["content-security-policy"]).toContain("connect-src 'self'");
  expect(headers["content-security-policy"]).not.toMatch(/unsafe-eval|script-src[^;]*unsafe-inline/);
  const target = `${origin}/__e2e_cookie_probe`;
  await page.route(target, route => route.fulfill({ status: 200, headers: {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
    ...Object.fromEntries(["content-security-policy", "x-content-type-options", "x-frame-options", "referrer-policy", "permissions-policy"].map(name => [name, headers[name]!])),
  }, body: "<!doctype html><html lang=\"en\"><head><title>Cookie transport probe</title></head><body><main><h1>Cookie transport probe</h1></main></body></html>" }));
  await page.goto(target);
  await expect(page.getByRole("heading", { name: "Cookie transport probe" })).toBeVisible();
}
