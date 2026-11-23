import {
  createWritingBackup,
  parseWritingBackup,
} from "../lib/writing-backup.ts";
import {
  createWritingCollection,
  openWritingCollection,
} from "../lib/writing-collection.ts";
import type { WritingNode } from "../lib/writing-document.ts";
import {
  DEFAULT_OVERLAP_POLICY,
  type OverlapPolicy,
} from "../lib/writing-overlap-model.ts";
export const overlapStamp = new Date("2026-11-12T00:00:00.000Z");
export const overlapParagraph = (text: string, format = 0): WritingNode => ({
  type: "paragraph",
  version: 1,
  children: [{ type: "text", version: 1, text, format }],
});
export async function overlapFixture(documents: (string | WritingNode)[][]) {
  const prepared = await createWritingCollection(
    documents.map((items, index) => ({
      group: `document-${index}`,
      backup: parseWritingBackup(
        createWritingBackup(
          {
            title: `Private title ${index}`,
            summary: "Private summary",
            workType: "other",
            locale: "en",
            editorState: {
              root: {
                type: "root",
                version: 1,
                children: items.map((item) =>
                  typeof item === "string" ? overlapParagraph(item) : item,
                ),
              },
            },
          },
          overlapStamp,
        ),
      ),
    })),
    overlapStamp,
  );
  return openWritingCollection(prepared.text);
}
export const overlapPolicy = (
  patch: Partial<OverlapPolicy> = {},
): OverlapPolicy => ({ ...DEFAULT_OVERLAP_POLICY, minimum: 8, ...patch });
export function overlapDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
