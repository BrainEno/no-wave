import { createWritingBackup, parseWritingBackup } from "./writing-backup.ts";
import {
  createWritingCollection,
  openWritingCollection,
} from "./writing-collection.ts";
import type { WritingNode } from "./writing-document.ts";

const now = new Date("2026-11-12T00:00:00Z");
export const cadenceParagraph = (text: string): WritingNode => ({
  type: "paragraph",
  version: 1,
  children: [{ type: "text", version: 1, text }],
});
export async function cadenceSource(documents: (string | WritingNode)[][]) {
  const value = await createWritingCollection(
    documents.map((blocks, ordinal) => ({
      group: `g${ordinal}`,
      backup: parseWritingBackup(
        createWritingBackup(
          {
            title: `PRIVATE_TITLE_${ordinal}`,
            summary: "PRIVATE_SUMMARY",
            locale: "en",
            workType: "essay",
            editorState: {
              root: {
                type: "root",
                version: 1,
                children: blocks.map((block) =>
                  typeof block === "string" ? cadenceParagraph(block) : block,
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
