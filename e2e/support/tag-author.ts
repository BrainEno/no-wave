import { expect, type APIRequestContext } from "@playwright/test";
import { editorState, uniqueEmail, WORK_PASSWORD } from "./works.ts";

export type CreatedTag = { id: string; slug: string; name: string };
export function tagNonce(): string { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

/** Shared real writes for tag discovery and subscription journeys, not mocked content. */
export async function tagAuthor(request: APIRequestContext, api: string) {
  const registered = await request.post(`${api}/api/v1/auth/register`, { data: { email: uniqueEmail("tags"), password: WORK_PASSWORD } });
  expect(registered.status(), "registering a disposable tag author").toBe(201);
  const session = (await registered.json()).data as { accessToken: string };
  expect(typeof session.accessToken).toBe("string");
  const headers = { authorization: `Bearer ${session.accessToken}`, origin: api };
  const profile = await request.put(`${api}/api/v1/me/profile`, { headers, data: { displayName: "标签作者", bio: "公开标签浏览验证。", locale: "zh-CN" } });
  expect(profile.status(), "creating the public author profile").toBe(200);
  return {
    async tag(name: string, locale: "zh-CN" | "en" = "zh-CN"): Promise<CreatedTag> {
      const result = await request.post(`${api}/api/v1/tags`, { headers, data: { name, locale } });
      expect(result.status(), "creating a Unicode hashtag through the existing API").toBe(201);
      const created = (await result.json()).data as CreatedTag;
      expect(typeof created.id).toBe("string");
      expect(created.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      return created;
    },
    async work(title: string, tag: CreatedTag, publish = true, options: { locale?: "zh-CN" | "en"; summary?: string } = {}) {
      const result = await request.post(`${api}/api/v1/articles`, { headers, data: {
        title, editorState: editorState(["同一标签下的作品，只在发布后进入公开阅读。"]), contentBlocksVersion: 1, tagIds: [tag.id], publish, ...options,
      } });
      expect(result.status(), "writing a tagged work through owner-authorized REST").toBe(201);
      const created = (await result.json()).data as { slug: string };
      expect(typeof created.slug).toBe("string");
      return created;
    },
  };
}
