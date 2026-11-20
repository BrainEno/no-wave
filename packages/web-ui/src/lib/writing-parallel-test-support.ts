import { createWritingBackup, parseWritingBackup } from "./writing-backup.ts";
import {
  createWritingCollection,
  openWritingCollection,
  type OpenedCollection,
} from "./writing-collection.ts";
import type { WritingNode } from "./writing-document.ts";

const now = new Date("2026-11-12T00:00:00Z");

export const parallelParagraph = (text: string): WritingNode => ({
  type: "paragraph",
  version: 1,
  children: [{ type: "text", version: 1, text }],
});

export const parallelHeading = (
  text: string,
  tag: "h1" | "h2" | "h3" = "h2",
): WritingNode => ({
  type: "heading",
  version: 1,
  tag: tag === "h1" ? "h2" : tag, // writing-backup accepts h2-h4
  children: [{ type: "text", version: 1, text }],
});

export const parallelQuote = (text: string): WritingNode => ({
  type: "quote",
  version: 1,
  children: [{ type: "text", version: 1, text }],
});

export const parallelLinkParagraph = (
  text: string,
  url: string,
): WritingNode => ({
  type: "paragraph",
  version: 1,
  children: [
    { type: "text", version: 1, text },
    {
      type: "link",
      version: 1,
      url,
      children: [{ type: "text", version: 1, text: url }],
    },
  ],
});

export const parallelImage = (src: string, alt: string): WritingNode => ({
  type: "image",
  version: 1,
  src,
  alt,
});

export type DocumentSpec = {
  locale?: string;
  title?: string;
  blocks: (string | WritingNode)[];
};

export async function parallelSource(
  documents: DocumentSpec[],
): Promise<OpenedCollection> {
  const value = await createWritingCollection(
    documents.map((spec, ordinal) => ({
      group: `g${ordinal}`,
      backup: parseWritingBackup(
        createWritingBackup(
          {
            title: spec.title ?? `TITLE_${ordinal}`,
            summary: `SUMMARY_${ordinal}`,
            locale: spec.locale ?? (ordinal === 0 ? "zh-TW" : "en"),
            workType: "essay",
            editorState: {
              root: {
                type: "root",
                version: 1,
                children: spec.blocks.map((block) =>
                  typeof block === "string" ? parallelParagraph(block) : block,
                ),
              },
            },
          },
          now,
        ),
      ),
    })),
    now,
  );
  return openWritingCollection(value.text);
}
