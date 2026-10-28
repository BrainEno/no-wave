import { ArticleInputError } from "./errors.ts";
import { isUuid, requiredText } from "./validation.ts";

const SUPPORTED_ARTICLE_LOCALES = new Set(["zh-CN", "zh-TW", "en"]);
const ARTICLE_WORK_TYPES = new Set(["novel", "short_story", "poetry", "essay", "criticism", "literary_criticism", "nonfiction", "serial", "other"]);
const ARTICLE_BLOCK_TYPES = new Set(["paragraph", "heading", "quote", "list", "image", "code"]);
const ARTICLE_CONTENT_BLOCK_VERSIONS = new Set([0, 1]);
const INLINE_MARKS = new Set(["bold", "italic", "underline", "strikethrough", "code"]);
const MAX_DOCUMENT_JSON_CHARACTERS = 1_000_000;
const MAX_INLINE_RUNS_PER_BLOCK = 1_000;

export { SUPPORTED_ARTICLE_LOCALES };

export function validateArticleWorkType(value) {
  if (!ARTICLE_WORK_TYPES.has(value)) {
    throw new ArticleInputError("workType must be one of the supported literary work types.");
  }
  return value;
}

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

export function validateArticleContentBlocksVersion(value) {
  const version = value === undefined ? 0 : value;
  if (!Number.isInteger(version) || !ARTICLE_CONTENT_BLOCK_VERSIONS.has(version)) {
    throw new ArticleInputError("contentBlocksVersion must be 0 or 1.");
  }
  return version;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownFields(value, allowedFields, name) {
  if (Object.keys(value).some((field) => !allowedFields.has(field))) {
    throw new ArticleInputError(`${name} contains unsupported fields.`);
  }
}

function validateDocumentUrl(name, value) {
  const urlValue = requiredText(name, value, 2048);
  if (/[\u0000-\u0020\u007f\\]/.test(urlValue)) {
    throw new ArticleInputError(`${name} must not contain whitespace, control characters, or backslashes.`);
  }
  if (urlValue.startsWith("/") && !urlValue.startsWith("//")) return urlValue;

  let parsed;
  try {
    parsed = new URL(urlValue);
  } catch {
    throw new ArticleInputError(`${name} must be a site-relative path or a valid HTTP(S) URL.`);
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname ||
      parsed.username.length > 0 || parsed.password.length > 0) {
    throw new ArticleInputError(`${name} must be a site-relative path or a valid HTTP(S) URL without credentials.`);
  }
  return urlValue;
}

function validateInlineRuns(runs, expectedText, name) {
  if (!Array.isArray(runs) || runs.length < 1 || runs.length > MAX_INLINE_RUNS_PER_BLOCK) {
    throw new ArticleInputError(`${name} must contain between 1 and ${MAX_INLINE_RUNS_PER_BLOCK} inline runs.`);
  }
  let combinedText = "";
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index];
    const runName = `${name}[${index}]`;
    if (!isRecord(run)) throw new ArticleInputError(`${runName} must be an object.`);
    rejectUnknownFields(run, new Set(["text", "marks", "href"]), runName);
    if (typeof run.text !== "string" || run.text.length < 1 || run.text.length > 20_000) {
      throw new ArticleInputError(`${runName}.text must be a non-empty string no longer than 20000 characters.`);
    }
    if (run.marks !== undefined &&
        (!Array.isArray(run.marks) || run.marks.length > INLINE_MARKS.size ||
         !run.marks.every((mark) => typeof mark === "string" && INLINE_MARKS.has(mark)) ||
         new Set(run.marks).size !== run.marks.length)) {
      throw new ArticleInputError(`${runName}.marks must contain unique supported inline marks.`);
    }
    if (run.href !== undefined) validateDocumentUrl(`${runName}.href`, run.href);
    combinedText += run.text;
  }
  if (combinedText !== expectedText) {
    throw new ArticleInputError(`${name} text must exactly match the block's plain-text fallback.`);
  }
}

const BLOCK_FIELDS = {
  paragraph: new Set(["id", "type", "text", "inlines"]),
  heading: new Set(["id", "type", "text", "level", "inlines"]),
  quote: new Set(["id", "type", "text", "attribution", "inlines"]),
  list: new Set(["id", "type", "ordered", "items", "itemInlines"]),
  image: new Set(["id", "type", "src", "alt", "caption"]),
  code: new Set(["id", "type", "language", "code"]),
};

export function validateArticleBlocks(blocks, contentBlocksVersion = 0) {
  const version = validateArticleContentBlocksVersion(contentBlocksVersion);
  if (!Array.isArray(blocks) || blocks.length < 1 || blocks.length > 200) {
    throw new ArticleInputError("contentBlocks must be an array containing between 1 and 200 blocks.");
  }
  if (JSON.stringify(blocks).length > MAX_DOCUMENT_JSON_CHARACTERS) {
    throw new ArticleInputError("contentBlocks must not exceed 1000000 serialized characters.");
  }

  const seenIds = new Set();
  return blocks.map((block, index) => {
    const name = `contentBlocks[${index}]`;
    if (!isRecord(block)) throw new ArticleInputError(`${name} must be an object.`);
    if (!ARTICLE_BLOCK_TYPES.has(block.type)) throw new ArticleInputError(`${name}.type is unsupported.`);
    rejectUnknownFields(block, BLOCK_FIELDS[block.type], name);
    if (version === 0 && ("inlines" in block || "itemInlines" in block)) {
      throw new ArticleInputError("Inline formatting and links require contentBlocksVersion 1.");
    }

    const id = requiredText(`${name}.id`, block.id, 100);
    if (seenIds.has(id)) throw new ArticleInputError("content block IDs must be unique within an article.");
    seenIds.add(id);

    if (block.type === "paragraph" || block.type === "heading" || block.type === "quote") {
      const text = requiredText(`${name}.text`, block.text, 20_000);
      if (block.type === "heading" && (!Number.isInteger(block.level) || block.level < 2 || block.level > 4)) {
        throw new ArticleInputError("heading level must be an integer between 2 and 4.");
      }
      if (block.type === "quote" && block.attribution !== undefined &&
          (typeof block.attribution !== "string" || block.attribution.length > 300)) {
        throw new ArticleInputError("quote attribution must be a string no longer than 300 characters.");
      }
      if (block.inlines !== undefined) {
        if (version !== 1) throw new ArticleInputError("Inline formatting and links require contentBlocksVersion 1.");
        validateInlineRuns(block.inlines, text, `${name}.inlines`);
      }
    } else if (block.type === "list") {
      if (typeof block.ordered !== "boolean" || !Array.isArray(block.items) || block.items.length < 1 || block.items.length > 100 ||
          !block.items.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= 2000)) {
        throw new ArticleInputError("list blocks require an ordered flag and 1 to 100 non-empty text items.");
      }
      if (block.itemInlines !== undefined) {
        if (version !== 1 || !Array.isArray(block.itemInlines) || block.itemInlines.length !== block.items.length) {
          throw new ArticleInputError("itemInlines requires version 1 and exactly one inline-run array per list item.");
        }
        block.itemInlines.forEach((runs, itemIndex) =>
          validateInlineRuns(runs, block.items[itemIndex], `${name}.itemInlines[${itemIndex}]`));
      }
    } else if (block.type === "image") {
      const src = requiredText(`${name}.src`, block.src, 2048);
      validateDocumentUrl(`${name}.src`, src);
      if (typeof block.alt !== "string" || block.alt.length > 1000) {
        throw new ArticleInputError("image alt must be a string no longer than 1000 characters.");
      }
      if (block.caption !== undefined && (typeof block.caption !== "string" || block.caption.length > 1000)) {
        throw new ArticleInputError("image caption must be a string no longer than 1000 characters.");
      }
    } else if (block.type === "code") {
      requiredText(`${name}.language`, block.language, 50);
      if (typeof block.code !== "string" || block.code.length > 50_000) {
        throw new ArticleInputError("code blocks must contain at most 50000 characters.");
      }
    }
    return block;
  });
}

export function normalizeArticleInput({ slug, title, summary, locale, contentBlocks, contentBlocksVersion, publish, workType }) {
  const version = validateArticleContentBlocksVersion(contentBlocksVersion);
  return {
    slug: validateArticleSlug(slug),
    title: requiredText("title", title, 250),
    summary: summary === undefined ? "" : (typeof summary === "string" && summary.length <= 2000 ? summary : (() => { throw new ArticleInputError("summary must be a string no longer than 2000 characters."); })()),
    locale: validateArticleLocale(locale),
    workType: workType === undefined ? undefined : validateArticleWorkType(workType),
    contentBlocksVersion: version,
    contentBlocks: validateArticleBlocks(contentBlocks, version),
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
