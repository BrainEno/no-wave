import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { TypedPersistenceAdapterContract, StoredArticle } from "../../../api/src/application/persistence-ports.ts";

/** Existing domain-valid persisted works, not larger HTTP writes or relaxed limits. */
export async function seedLargeWorks(store: Pick<TypedPersistenceAdapterContract, "createArticle" | "upsertAuthorProfile" | "createTag" | "createTaxonomy">, authorId: string) {
  const code = "浪".repeat(49_900);
  const works: StoredArticle[] = [], poems: StoredArticle[] = [];
  const tags: Record<string, { slug: string }> = {}, categories: Record<string, { slug: string }> = {};
  const blocks = [{ id: "section", type: "heading", level: 2, text: "Complete section" },
    { id: "text", type: "paragraph", text: "Complete body paragraph, including the last words." },
    { id: "second-section", type: "heading", level: 2, text: "Another section" },
    ...Array.from({ length: 19 }, (_, index) => ({ id: `code-${index}`, type: "code", language: "text", code }))];
  for (const locale of ["zh-CN", "en"] as const) {
    await store.upsertAuthorProfile({ userId: authorId, displayName: "集合验证作者", bio: "Stored public data", locale });
    const tag = await store.createTag({ actorId: authorId, name: locale === "en" ? "Large-collections" : "大集合", locale });
    const category = await store.createTaxonomy({ actorId: authorId, actorIsEditor: true, kind: "category", slug: `large-${locale.toLowerCase()}-${randomUUID()}`, name: "Large works", locale });
    tags[locale] = tag; categories[locale] = category;
    const poem = await store.createArticle({ authorId, locale, slug: `poem-${locale.toLowerCase()}-${randomUUID()}`, title: `Poetry ${locale}`, workType: "poetry", contentBlocks: [
      { id: "poem", type: "paragraph", text: "第一行\n第二行\n第三行" }, { id: "quote", type: "quote", text: "另有四字", attribution: "Not counted" },
    ], publish: true });
    poems.push(poem);
    // Ensure the poem is a non-lead row, so the archive's dedicated excerpt is
    // exercised as well as the ordinary WorkRow preview.
    await delay(5);
    for (let index = 0; index < 3; index++) works.push(await store.createArticle({ authorId, locale,
      slug: `large-${locale.toLowerCase()}-${index}-${randomUUID()}`, title: `Large ${locale} work ${index}`, contentBlocks: blocks,
      categoryIds: [category.id], tagIds: [tag.id], publish: true }));
  }
  return { works, poems, tags, categories, blocks };
}
