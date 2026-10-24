import { ArticleInputError } from "./errors.mjs";
import { isUuid, requiredText } from "./validation.mjs";

const SUPPORTED_ARTICLE_LOCALES = new Set(["zh-CN", "zh-TW", "en"]);
const ARTICLE_WORK_TYPES = new Set(["novel", "short_story", "poetry", "essay", "criticism", "literary_criticism", "nonfiction", "serial", "other"]);

export const supportedArticleWorkTypes = Object.freeze([...ARTICLE_WORK_TYPES]);

export function validateArticleWorkType(value) {
  if (!ARTICLE_WORK_TYPES.has(value)) {
    throw new ArticleInputError("workType must be one of the supported literary work types.");
  }
  return value;
}
const ARTICLE_BLOCK_TYPES = new Set(["paragraph", "heading", "quote", "list", "image", "code"]);

export { SUPPORTED_ARTICLE_LOCALES };

export function validateArticleSlug(value) {
  const slug = requiredText("slug", value, 160);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new ArticleInputError("slug must contain lowercase ASCII letters, digits, and single hyphens.");
  }
  return slug;
}

export function validateArticleLocale(value) {
  if (!SUPPORTED_ARTICLE_LOCALES.has(value)) {
    throw new ArticleInputError("locale must be zh-CN, zh-TW or en.");
  }
  return value;
}

export function validateArticleBlocks(blocks) {
    if (!Array.isArray(blocks) || blocks.length < 1 || blocks.length > 200) {
      throw new ArticleInputError("contentBlocks must be an array containing between 1 and 200 blocks.");
    }
    const seenIds = new Set();
    return blocks.map((block, index) => {
      if (!block || typeof block !== "object" || Array.isArray(block)) {
        throw new ArticleInputError(`contentBlocks[${index}] must be an object.`);
      }
      const id = requiredText(`contentBlocks[${index}].id`, block.id, 100);
      if (seenIds.has(id)) throw new ArticleInputError("content block IDs must be unique within an article.");
      seenIds.add(id);
      if (!ARTICLE_BLOCK_TYPES.has(block.type)) throw new ArticleInputError(`contentBlocks[${index}].type is unsupported.`);
      if (block.type === "paragraph" || block.type === "heading" || block.type === "quote") {
        requiredText(`contentBlocks[${index}].text`, block.text, 20000);
        if (block.type === "heading" && (!Number.isInteger(block.level) || block.level < 2 || block.level > 4)) {
          throw new ArticleInputError("heading level must be an integer between 2 and 4.");
        }
        if (block.type === "quote" && block.attribution !== undefined &&
            (typeof block.attribution !== "string" || block.attribution.length > 300)) {
          throw new ArticleInputError("quote attribution must be a string no longer than 300 characters.");
        }
      } else if (block.type === "list") {
        if (typeof block.ordered !== "boolean" || !Array.isArray(block.items) || block.items.length < 1 || block.items.length > 100 ||
            !block.items.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= 2000)) {
          throw new ArticleInputError("list blocks require an ordered flag and 1 to 100 non-empty text items.");
        }
      } else if (block.type === "image") {
        const src = requiredText(`contentBlocks[${index}].src`, block.src, 2048);
        if (!(src.startsWith("/") && !src.startsWith("//")) && !/^https?:\/\//i.test(src)) {
          throw new ArticleInputError("image src must be a site-relative path or an HTTP(S) URL.");
        }
        if (typeof block.alt !== "string" || block.alt.length > 1000) {
          throw new ArticleInputError("image alt must be a string no longer than 1000 characters.");
        }
        if (block.caption !== undefined && (typeof block.caption !== "string" || block.caption.length > 1000)) {
          throw new ArticleInputError("image caption must be a string no longer than 1000 characters.");
        }
      } else if (block.type === "code") {
        requiredText(`contentBlocks[${index}].language`, block.language, 50);
        if (typeof block.code !== "string" || block.code.length > 50000) {
          throw new ArticleInputError("code blocks must contain at most 50000 characters.");
        }
      }
      return block;
    });
}

export function normalizeArticleInput({ slug, title, summary, locale, contentBlocks, publish, workType }) {
  return {
    slug: validateArticleSlug(slug),
    title: requiredText("title", title, 250),
    summary: summary === undefined ? "" : (typeof summary === "string" && summary.length <= 2000 ? summary : (() => { throw new ArticleInputError("summary must be a string no longer than 2000 characters."); })()),
    locale: validateArticleLocale(locale),
    workType: workType === undefined ? undefined : validateArticleWorkType(workType),
    contentBlocks: validateArticleBlocks(contentBlocks),
    publish: publish === true,
  };
}

export function normalizeTaxonomyIds(name, ids, max) {
  if (ids === undefined || ids === null) return undefined;
  if (!Array.isArray(ids) || ids.length > max || !ids.every(isUuid)) {
    throw new ArticleInputError(`${name} must contain at most ${max} valid UUIDs.`);
  }
  if (new Set(ids).size !== ids.length) throw new ArticleInputError(`${name} cannot contain duplicate IDs.`);
  return ids;
}
