import { randomUUID } from "node:crypto";
import { expect, type Page, type Route } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import { test } from "./support/csp-fixture.ts";
import { registerThroughForm, uniqueEmail } from "./support/accounts.ts";
import {
  mockNotionImport,
  type MockImportRequest,
} from "./support/notion-import-mock.ts";

/**
 * Local images in a Notion export ZIP, uploaded to the author's media library on
 * the author's click (P2).
 *
 * What only the browser can show: nothing is uploaded until the button is
 * clicked; one click sends at most ten uploads and says how many are left; an
 * upload writes no article and discards a plan made before it; the next dry run
 * and the confirm carry the library addresses; a 429 stops the run without
 * waiting; and a later visit reuses what is already in the library instead of
 * spending the hour's uploads again.
 *
 * The media endpoints are stood in for — the real one allows ten uploads per
 * author per hour — and so is the import (see support/notion-import-mock.ts).
 */

const PNG = (n: number) =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, n, n, n]);
const mediaId = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function exportZip() {
  const id = randomUUID().replaceAll("-", "");
  const folder = `有图的文章 ${id}`;
  const images: Record<string, Uint8Array> = {};
  const lines: string[] = [];
  for (let i = 1; i <= 12; i++) {
    const name = `image ${String(i).padStart(2, "0")}.png`;
    images[`导出/${folder}/${name}`] = PNG(i);
    lines.push(
      `![第 ${i} 张](${encodeURIComponent(folder)}/${encodeURIComponent(name)})`,
    );
  }
  images[`导出/${folder}/动图.gif`] = strToU8("GIF89a");
  lines.push(
    `![动图](${encodeURIComponent(folder)}/${encodeURIComponent("动图.gif")})`,
  );
  return Buffer.from(
    zipSync({
      [`导出/有图的文章 ${id}.md`]: strToU8(
        `# 有图的文章\n\nPublished: No\n\n${lines.join("\n\n")}\n\n正文`,
      ),
      ...images,
    }),
  );
}

type MediaServer = { posts: string[]; library: string[]; refuseFrom: number };

/** Stand in for `POST` (upload) and `GET` (library) on `/api/authoring/media`. */
async function mockMedia(page: Page): Promise<MediaServer> {
  const server: MediaServer = { posts: [], library: [], refuseFrom: Infinity };
  await page.route(
    (url) => url.pathname === "/api/authoring/media",
    async (route: Route) => {
      const request = route.request();
      if (request.method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              items: server.library.map((id) => ({ id })),
              nextCursor: null,
            },
          }),
        });
      }
      const call = server.posts.push(request.headers()["content-type"] ?? "");
      if (call >= server.refuseFrom) {
        return route.fulfill({
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": "3600",
          },
          body: JSON.stringify({
            error: { code: "RATE_LIMITED", message: "Too many requests." },
          }),
        });
      }
      server.library.push(mediaId(call));
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          data: { id: mediaId(call), src: `/api/media/${mediaId(call)}` },
        }),
      });
    },
  );
  return server;
}

const imageUrls = (request: MockImportRequest) =>
  request.bundle.pages[0]!.blocks.filter(
    (block) => (block as { type?: string }).type === "image",
  ).map(
    (block) =>
      (block as { image: { external: { url: string } } }).image.external.url,
  );

test("local images are uploaded only on click, ten at a time, and the plan then carries their library addresses", async ({
  page,
}) => {
  await registerThroughForm(
    page,
    uniqueEmail("notion-zip-images"),
    "/write/notion",
  );
  const media = await mockMedia(page);
  const imports = await mockNotionImport(page);
  const zip = exportZip();
  await page.getByRole("tab", { name: "上传导出文件" }).click();
  await page.setInputFiles("#notion-bundle-file", {
    name: "export.zip",
    mimeType: "application/zip",
    buffer: zip,
  });

  // Found and offered, but nothing is sent before the click.
  await expect(page.getByText(/本地图片 第 1 张 未导入/)).toBeVisible();
  await expect(
    page.getByText(
      "动图.gif：只支持 JPEG、PNG、WebP 格式，未上传，导入时会移除。",
    ),
  ).toBeVisible();
  const upload = page.getByRole("button", {
    name: "上传 10 张本地图片到你的媒体库",
  });
  await expect(upload).toBeVisible();
  expect(media.posts).toHaveLength(0);

  // A plan made before the upload has no images, and the upload discards it.
  await page.getByRole("button", { name: "试跑所选文章" }).click();
  await expect(page.getByText(/计划：新建 1 件/)).toBeVisible();
  expect(imageUrls(imports[0]!)).toEqual([]);
  await upload.click();
  await expect(page.getByText(/已上传 10 张图片到你的媒体库/)).toContainText(
    "还有 2 张没有上传（每次最多上传 10 张）",
  );
  expect(media.posts).toEqual(Array(10).fill("image/png"));
  await expect(page.getByText(/计划：新建 1 件/)).toHaveCount(0);
  // Uploading wrote no article.
  expect(imports).toHaveLength(1);
  await expect(page.getByText(/本地图片 第 10 张 未导入/)).toHaveCount(0);
  await expect(page.getByText(/本地图片 第 11 张 未导入/)).toBeVisible();

  // The next dry run and the confirm send the library addresses, in page order.
  await page.getByRole("button", { name: "试跑所选文章" }).click();
  await expect(page.getByText(/计划：新建 1 件/)).toBeVisible();
  const expected = Array.from(
    { length: 10 },
    (_, i) => `/api/media/${mediaId(i + 1)}`,
  );
  expect(imageUrls(imports[1]!)).toEqual(expected);
  await page.getByRole("button", { name: /确认导入（写入 1 件作品）/ }).click();
  await expect(page.getByText(/已导入：新建 1 件/)).toBeVisible();
  expect(imports[2]!.apply).toBe(true);
  expect(imageUrls(imports[2]!)).toEqual(expected);
});

test("a 429 stops the upload at once, and a later visit reuses the library instead of uploading again", async ({
  page,
}) => {
  await registerThroughForm(
    page,
    uniqueEmail("notion-zip-images-later"),
    "/write/notion",
  );
  const media = await mockMedia(page);
  const imports = await mockNotionImport(page);
  const zip = exportZip();
  const choose = async () => {
    await page.getByRole("tab", { name: "上传导出文件" }).click();
    await page.setInputFiles("#notion-bundle-file", {
      name: "export.zip",
      mimeType: "application/zip",
      buffer: zip,
    });
  };

  media.refuseFrom = 4;
  await choose();
  await page
    .getByRole("button", { name: "上传 10 张本地图片到你的媒体库" })
    .click();
  await expect(page.getByText(/已上传 3 张图片到你的媒体库/)).toContainText(
    "还有 9 张没有上传（已达到媒体库每小时的上传上限）",
  );
  // Stopped at the refusal: nothing after it was sent.
  expect(media.posts).toHaveLength(4);

  // An hour later, in a fresh page: the three already in the library are reused.
  media.refuseFrom = Infinity;
  await page.reload({ waitUntil: "load" });
  await choose();
  await page
    .getByRole("button", { name: "上传 10 张本地图片到你的媒体库" })
    .click();
  await expect(page.getByText(/已上传 9 张图片到你的媒体库/)).toContainText(
    "复用了之前上传过的 3 张",
  );
  expect(media.posts).toHaveLength(4 + 9);
  await expect(
    page.getByText(
      "导出包里能上传的本地图片都已在你的媒体库中，并已放进对应文章。",
    ),
  ).toBeVisible();

  await page.getByRole("button", { name: "试跑所选文章" }).click();
  await expect(page.getByText(/计划：新建 1 件/)).toBeVisible();
  expect(imageUrls(imports[0]!)).toHaveLength(12);
  expect(new Set(imageUrls(imports[0]!)).size).toBe(12);
});
