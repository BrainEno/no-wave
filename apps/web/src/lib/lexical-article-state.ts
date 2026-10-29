type JsonObject = Record<string, unknown>;
export type LexicalEditorStateJson = { root: JsonObject & { children: JsonObject[] } };

const INLINE_MARKS = new Set(["bold", "italic", "underline", "strikethrough", "code"]);
const MARK_BITS: Record<string, number> = { bold: 1, italic: 2, underline: 4, strikethrough: 8, code: 16 };

function record(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : null;
}

function element(type: string, children: JsonObject[], extra: JsonObject = {}): JsonObject {
  return { children, direction: null, format: "", indent: 0, type, version: 1, ...extra };
}

function textNode(text: string, marks: string[] = []): JsonObject {
  const format = marks.reduce((value, mark) => value | (MARK_BITS[mark] ?? 0), 0);
  return { detail: 0, format, mode: "normal", style: "", text, type: "text", version: 1 };
}

function inlineChildren(block: JsonObject, textKey: string, inlineKey = "inlines"): JsonObject[] {
  const expectedText = block[textKey];
  if (typeof expectedText !== "string") throw new Error("The saved article block has invalid text.");
  const raw = block[inlineKey];
  if (raw === undefined) return [textNode(expectedText)];
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("The saved article contains invalid inline formatting.");
  const nodes = raw.map((value): JsonObject => {
    const run = record(value);
    if (!run || typeof run.text !== "string" || run.text.length === 0) throw new Error("The saved article contains an invalid inline run.");
    const marks = run.marks === undefined ? [] : run.marks;
    if (!Array.isArray(marks) || !marks.every((mark) => typeof mark === "string" && INLINE_MARKS.has(mark)) ||
      new Set(marks).size !== marks.length) throw new Error("The saved article contains an unsupported inline mark.");
    let node: JsonObject = textNode(run.text, marks as string[]);
    if (run.href !== undefined) {
      if (typeof run.href !== "string" || run.href.length === 0 || run.href.startsWith("//") || /[\u0000-\u0020\u007f\\]/.test(run.href)) {
        throw new Error("The saved article contains an invalid link.");
      }
      if (!run.href.startsWith("/")) {
        let url: URL;
        try { url = new URL(run.href); } catch { throw new Error("The saved article contains an invalid link."); }
        if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
          throw new Error("The saved article contains an unsafe link.");
        }
      }
      node = element("link", [node], { rel: null, target: null, title: null, url: run.href });
    }
    return node;
  });
  const actualText = raw.map((run) => record(run)?.text as string).join("");
  if (actualText !== expectedText) throw new Error("The saved article text and inline runs do not match.");
  return nodes;
}

export function articleBlocksToLexicalEditorState(value: unknown): LexicalEditorStateJson {
  if (value === undefined || value === null) {
    return { root: element("root", [element("paragraph", [textNode("")])]) as LexicalEditorStateJson["root"] };
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > 200) throw new Error("The saved article content is not a supported block list.");
  const children = value.map((item): JsonObject => {
    const block = record(item);
    if (!block || typeof block.type !== "string") throw new Error("The saved article contains an invalid content block.");
    switch (block.type) {
      case "paragraph":
        return element("paragraph", inlineChildren(block, "text"));
      case "heading": {
        if (block.level !== 2 && block.level !== 3 && block.level !== 4) throw new Error("The saved article contains an unsupported heading level.");
        return element("heading", inlineChildren(block, "text"), { tag: `h${block.level}` });
      }
      case "quote":
        if (block.attribution !== undefined && block.attribution !== "") throw new Error("Quotes with attribution are not yet editable in the web editor.");
        return element("quote", inlineChildren(block, "text"));
      case "list": {
        if (typeof block.ordered !== "boolean" || !Array.isArray(block.items) || !block.items.every((item) => typeof item === "string") || block.items.length < 1 || block.items.length > 100) {
          throw new Error("The saved article contains an invalid list.");
        }
        const items = block.items as string[];
        const rawItemRuns = block.itemInlines;
        if (rawItemRuns !== undefined && (!Array.isArray(rawItemRuns) || rawItemRuns.length !== items.length)) {
          throw new Error("The saved article contains invalid list inline formatting.");
        }
        const listItems = items.map((item, index) => {
          const itemBlock: JsonObject = { text: item };
          if (rawItemRuns !== undefined) itemBlock.itemInlines = rawItemRuns[index];
          return element("listitem", inlineChildren(itemBlock, "text", "itemInlines"), { checked: null, value: index + 1 });
        });
        return element("list", listItems, { listType: block.ordered ? "number" : "bullet", start: 1, tag: block.ordered ? "ol" : "ul" });
      }
      case "code":
        if (typeof block.code !== "string" || typeof block.language !== "string") throw new Error("The saved article contains an invalid code block.");
        return element("code", block.code.length ? [textNode(block.code)] : [], { language: block.language || null, theme: "" });
      case "image": {
        if (typeof block.src !== "string" || typeof block.alt !== "string" ||
          (block.caption !== undefined && typeof block.caption !== "string")) {
          throw new Error("The saved article contains an invalid image block.");
        }
        const src = block.src;
        if (src.startsWith("//") || src.includes("\\\\") || /[\\u0000-\\u0020\\u007f]/.test(src)) {
          throw new Error("The saved article contains an unsafe image URL.");
        }
        if (!src.startsWith("/")) {
          let url: URL;
          try { url = new URL(src); } catch { throw new Error("The saved article contains an unsafe image URL."); }
          if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
            throw new Error("The saved article contains an unsafe image URL.");
          }
        }
        return {
          type: "image", version: 1, src, alt: block.alt,
          ...(typeof block.caption === "string" && block.caption.length > 0 ? { caption: block.caption } : {}),
        };
      }
      default:
        throw new Error("This article contains a block type that the current editor cannot safely edit.");
    }
  });
  return { root: element("root", children) as LexicalEditorStateJson["root"] };
}
