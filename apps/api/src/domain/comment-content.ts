import { ArticleInputError } from "./errors.ts";
import { validateArticleBlocks } from "./article.ts";
import { lexicalEditorStateToArticleDocument } from "./lexical-document-adapter.ts";

const MAX_COMMENT_CHARACTERS = 5000;
const MAX_COMMENT_PARAGRAPHS = 20;

export type CommentInlineRun = { text: string; marks?: string[]; href?: string };
export type CommentContentBlock = { id: string; type: "paragraph"; text: string; inlines?: CommentInlineRun[] };
export type NormalizedCommentContent = { content: string; contentBlocks: CommentContentBlock[] | null; contentBlocksVersion: 0 | 1 };

function invalid(message: string): never { throw new ArticleInputError(message); }

function validatePlainText(content: unknown): string {
  if (typeof content !== "string" || content.trim().length === 0 || content.length > MAX_COMMENT_CHARACTERS) {
    invalid("content must be non-empty and no longer than 5000 characters.");
  }
  return content.trim();
}

function validateRichDocument(blocks: unknown): CommentContentBlock[] {
  if (!Array.isArray(blocks) || blocks.length < 1 || blocks.length > MAX_COMMENT_PARAGRAPHS) {
    invalid("Rich comment content must contain between 1 and 20 paragraphs.");
  }
  const validated = validateArticleBlocks(blocks, 1) as CommentContentBlock[];
  if (validated.some((block) => block.type !== "paragraph")) invalid("Rich comments support paragraph blocks only.");
  return validated;
}

function richTextFallback(blocks: CommentContentBlock[]): string {
  const content = blocks.map((block) => block.text).join("\n");
  if (content.trim().length === 0 || content.length > MAX_COMMENT_CHARACTERS) {
    invalid("Comment text must be non-empty and no longer than 5000 characters.");
  }
  return content;
}

/** Normalize legacy plain text, application v1 paragraph blocks, or serialized Lexical state. */
export function normalizeCommentContentInput(body: Record<string, unknown>): NormalizedCommentContent {
  const hasContent = Object.hasOwn(body, "content");
  const hasBlocks = Object.hasOwn(body, "contentBlocks");
  const hasEditorState = Object.hasOwn(body, "editorState");
  if (Number(hasContent) + Number(hasBlocks) + Number(hasEditorState) !== 1) {
    invalid("Supply exactly one of content, contentBlocks, or editorState.");
  }
  if (hasContent) {
    if (body.contentBlocksVersion !== undefined && body.contentBlocksVersion !== 0) {
      invalid("Plain-text comments require contentBlocksVersion 0.");
    }
    return { content: validatePlainText(body.content), contentBlocks: null, contentBlocksVersion: 0 };
  }
  if (body.contentBlocksVersion !== undefined && body.contentBlocksVersion !== 1) {
    invalid("Rich comment content requires contentBlocksVersion 1.");
  }
  let blocks: unknown;
  if (hasEditorState) {
    if (typeof body.editorState !== "object" || body.editorState === null || Array.isArray(body.editorState)) {
      invalid("editorState must be a serialized Lexical EditorState object.");
    }
    blocks = lexicalEditorStateToArticleDocument(body.editorState).contentBlocks;
  } else {
    blocks = body.contentBlocks;
  }
  const contentBlocks = validateRichDocument(blocks);
  return { content: richTextFallback(contentBlocks), contentBlocks, contentBlocksVersion: 1 };
}

/** Persistence-level validation; callers cannot bypass it through another transport. */
export function validateStoredCommentContent({
  content, contentBlocks = null, contentBlocksVersion = 0,
}: {
  content: unknown; contentBlocks?: unknown; contentBlocksVersion?: unknown;
}): NormalizedCommentContent {
  if (contentBlocksVersion === 0) {
    if (contentBlocks !== null && contentBlocks !== undefined) invalid("Version-0 comments must not contain rich content blocks.");
    return { content: validatePlainText(content), contentBlocks: null, contentBlocksVersion: 0 };
  }
  if (contentBlocksVersion !== 1) invalid("contentBlocksVersion must be 0 or 1.");
  const blocks = validateRichDocument(contentBlocks);
  const expectedContent = richTextFallback(blocks);
  if (typeof content !== "string" || content !== expectedContent) {
    invalid("The comment plain-text fallback must exactly match its rich content blocks.");
  }
  return { content: expectedContent, contentBlocks: blocks, contentBlocksVersion: 1 };
}
