import { expect } from "@playwright/test";
import { test } from "./support/csp-fixture.ts";
import { startFontStack } from "./support/font-stack.ts";
import { installEngine, spokenTexts } from "./support/speech.ts";
import { createSqliteClient } from "../apps/api/src/persistence/sqlite.ts";
import { createSqliteStore } from "../apps/api/src/persistence/sqlite-store.ts";
import { seedLargeWorks } from "../apps/web-rr/test/support/large-works.ts";

// The fixture owns its database and both real processes. Persisting legal large
// documents directly avoids increasing the distinct HTTP write-body ceiling.
test("large legal full lists cross the actual BFF without losing bodies, while SSR cards retain poetry and a full interactive reader", async ({
  page,
}) => {
  const stack = await startFontStack();
  try {
    const registered = await page.request.post(
      `${stack.apiBaseUrl}/api/v1/auth/register`,
      {
        data: {
          email: `collection-${Date.now()}@example.test`,
          password: "fixture-collection-password",
        },
      },
    );
    expect(registered.status()).toBe(201);
    const { accessToken } = (await registered.json()).data;
    const me = await page.request.get(`${stack.apiBaseUrl}/api/v1/me`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(me.status()).toBe(200);
    const authorId: string = (await me.json()).data.id;
    const db = createSqliteClient({ filename: stack.databasePath });
    const fixture = await seedLargeWorks(
      createSqliteStore(db),
      authorId,
    ).finally(() => db.close());
    await page.context().addCookies([
      {
        name: "nw_access",
        value: accessToken,
        url: `${stack.webBaseUrl}/api/authoring`,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    await installEngine(page, 60);
    const response = await page.goto(`${stack.webBaseUrl}/articles`);
    expect(response?.status()).toBe(200);
    expect((await response!.body()).byteLength).toBeLessThan(256 * 1024);
    for (const work of fixture.works.filter((work) => work.locale === "zh-CN"))
      await expect(
        page.getByRole("link", { name: new RegExp(work.title) }).first(),
      ).toBeVisible();
    await expect(page.locator(".nw-pi")).toContainText("第一行");
    await expect(page.locator(".nw-pi")).toContainText("第二行");
    await expect(
      page.locator(".nw-row").filter({ hasText: "Poetry zh-CN" }),
    ).toContainText("13 字");
    const full = await page.evaluate(async () => {
      const response = await fetch(
        "/api/authoring/articles?locale=zh-CN&limit=100",
        { credentials: "same-origin" },
      );
      const bytes = new Uint8Array(await response.arrayBuffer());
      const payload = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      return {
        status: response.status,
        cache: response.headers.get("cache-control"),
        bytes: bytes.byteLength,
        items: payload.data.map(
          (article: {
            slug: string;
            contentBlocks: { id: string; type: string; code?: string }[];
          }) => ({
            slug: article.slug,
            blocks: article.contentBlocks.length,
            lastCodeLength:
              article.contentBlocks.find((block) => block.id === "code-18")
                ?.code?.length ?? 0,
          }),
        ),
      };
    });
    expect(full.status).toBe(200);
    expect(full.cache).toContain("no-store");
    expect(full.bytes).toBeGreaterThan(8 * 1024 * 1024);
    const native = await page.request.get(
      `${stack.apiBaseUrl}/api/v1/me/articles?locale=zh-CN&limit=100`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    expect(native.status()).toBe(200);
    expect(full.items.map((item: { slug: string }) => item.slug)).toEqual(
      (await native.json()).data.map((item: { slug: string }) => item.slug),
    );
    expect(full.items).toHaveLength(4);
    for (const work of fixture.works.filter((work) => work.locale === "zh-CN"))
      expect(
        full.items.find((item: { slug: string }) => item.slug === work.slug),
      ).toMatchObject({ blocks: 22, lastCodeLength: 49_900 });
    const work = fixture.works.find((work) => work.locale === "en")!;
    expect(
      (
        await page.goto(`${stack.webBaseUrl}/en/articles/${work.slug}`)
      )?.status(),
    ).toBe(200);
    await expect(page.locator("#nw-article pre")).toHaveCount(19);
    await expect(page.locator("#nw-article pre").last()).toHaveText(
      "浪".repeat(49_900),
    );
    await expect(
      page.getByRole("link", { name: "Complete section", exact: true }),
    ).toHaveAttribute("href", "#h-section");
    await expect(page.locator("#nw-article")).toContainText(
      "Complete body paragraph, including the last words.",
    );
    await page.getByRole("button", { name: "Listen", exact: true }).click();
    await expect
      .poll(async () => (await spokenTexts(page)).join(" "))
      .toContain("including the last words.");
    expect((await spokenTexts(page)).join(" ")).not.toContain("浪");
    expect((await page.goto(`${stack.webBaseUrl}/en/articles`))?.status()).toBe(
      200,
    );
    await expect(
      page.locator(".nw-row").filter({ hasText: "Poetry en" }),
    ).toContainText("4 words");
    expect(
      (await page.request.get(`${stack.webBaseUrl}/sitemap.xml`)).status(),
    ).toBe(200);
  } finally {
    await stack.close();
  }
});
