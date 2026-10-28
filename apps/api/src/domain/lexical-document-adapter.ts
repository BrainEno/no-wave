import { ArticleInputError } from "./errors.ts";
import { validateArticleBlocks, validateArticleContentBlocksVersion } from "./article.ts";

const TEXT_FORMATS = Object.freeze([
  { mark: "bold", flag: 1 },
  { mark: "italic", flag: 2 },
  { mark: "strikethrough", flag: 4 },
  { mark: "underline", flag: 8 },
  { mark: "code", flag: 16 },
]);
const TEXT_FORMAT_MASK = TEXT_FORMATS.reduce((mask, item) => mask | item.flag, 0);
const MAX_LEXICAL_JSON_CHARACTERS = 1_000_000;
const ELEMENT_KEYS = new Set(["children", "direction", "format", "indent", "type", "version"]);
const TEXT_KEYS = new Set(["detail", "format", "mode", "style", "text", "type", "version"]);

function fail(path, message) {
  throw new ArticleInputError("Lexical adapter: " + path + " " + message);
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function expectRecord(value, path) {
  if (!isRecord(value)) fail(path, "must be an object.");
  return value;
}
function onlyKeys(value, allowed, path) {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) fail(path, 'contains unsupported field "' + unknown + '".');
}
function validateElementEnvelope(node, path) {
  if (node.version !== 1) fail(path, "must use Lexical node version 1.");
  if (node.direction !== undefined && node.direction !== null && node.direction !== "ltr") {
    fail(path, "uses text direction metadata that the article contract cannot preserve.");
  }
  if (node.format !== undefined && node.format !== "" && node.format !== 0) {
    fail(path, "uses block alignment metadata that the article contract cannot preserve.");
  }
  if (node.indent !== undefined && node.indent !== 0) {
    fail(path, "uses indentation metadata that the article contract cannot preserve.");
  }
  if (!Array.isArray(node.children)) fail(path + ".children", "must be an array.");
  return node.children;
}
function textMarks(format, path) {
  const numericFormat = format === undefined ? 0 : format;
  if (!Number.isInteger(numericFormat) || numericFormat < 0 ||
      (numericFormat & ~TEXT_FORMAT_MASK) !== 0) {
    fail(path + ".format", "contains unsupported Lexical text formatting flags.");
  }
  return TEXT_FORMATS.filter((item) => (numericFormat & item.flag) !== 0).map((item) => item.mark);
}
function parseTextNode(node, path, href, { code = false } = {}) {
  expectRecord(node, path);
  const allowedKeys = node.type === "code-highlight"
    ? new Set([...TEXT_KEYS, "highlightType"])
    : TEXT_KEYS;
  onlyKeys(node, allowedKeys, path);
  if (node.type !== "text" && !(code && node.type === "code-highlight")) {
    fail(path, 'contains unsupported inline node type "' + String(node.type) + '".');
  }
  if (node.version !== 1) fail(path, "must use Lexical node version 1.");
  if (typeof node.text !== "string") fail(path + ".text", "must be a string.");
  if (node.detail !== undefined && node.detail !== 0) fail(path + ".detail", "uses unsupported text detail flags.");
  if (node.mode !== undefined && node.mode !== "normal") fail(path + ".mode", "uses unsupported text mode.");
  if (node.style !== undefined && node.style !== "") fail(path + ".style", "uses inline CSS that the article contract cannot preserve.");
  const marks = textMarks(node.format, path);
  return {
    text: node.text,
    ...(marks.length ? { marks } : {}),
    ...(href !== undefined ? { href } : {}),
  };
}
function mergeInlineRuns(runs) {
  const merged = [];
  for (const run of runs) {
    const previous = merged[merged.length - 1];
    const previousMarks = previous && previous.marks ? previous.marks : [];
    const currentMarks = run.marks || [];
    if (previous && previous.href === run.href &&
        JSON.stringify(previousMarks) === JSON.stringify(currentMarks)) {
      previous.text += run.text;
    } else {
      merged.push({ ...run, ...(run.marks ? { marks: [...run.marks] } : {}) });
    }
  }
  return merged;
}
function parseInlineNodes(nodes, path, { code = false } = {}) {
  if (!Array.isArray(nodes)) fail(path, "must be an array.");
  const runs = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const nodePath = path + "[" + index + "]";
    const node = expectRecord(nodes[index], nodePath);
    if (node.type === "text" || (code && node.type === "code-highlight")) {
      runs.push(parseTextNode(node, nodePath, undefined, { code }));
      continue;
    }
    if (node.type === "link" || node.type === "autolink") {
      const linkKeys = new Set([...ELEMENT_KEYS, "url", "rel", "target", "title"]);
      onlyKeys(node, linkKeys, nodePath);
      const children = validateElementEnvelope(node, nodePath);
      if (typeof node.url !== "string" || node.url.length === 0) fail(nodePath + ".url", "must be a non-empty URL.");
      for (const key of ["rel", "target", "title"]) {
        if (node[key] !== undefined && node[key] !== null && node[key] !== "") {
          fail(nodePath + "." + key, "uses link metadata that the article contract cannot preserve.");
        }
      }
      if (children.length === 0) fail(nodePath + ".children", "must not be empty.");
      for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
        const childPath = nodePath + ".children[" + childIndex + "]";
        const child = expectRecord(children[childIndex], childPath);
        if (child.type !== "text") fail(childPath, "contains a nested or unsupported link child.");
        runs.push(parseTextNode(child, childPath, node.url));
      }
      continue;
    }
    fail(nodePath, 'contains unsupported inline node type "' + String(node.type) + '".');
  }
  return mergeInlineRuns(runs);
}
function hasInlineMarkup(runs) {
  return runs.some((run) => run.href !== undefined || (run.marks && run.marks.length > 0));
}
function plainText(runs) {
  return runs.map((run) => run.text).join("");
}
function parseBlock(node, index) {
  const path = "root.children[" + index + "]";
  expectRecord(node, path);
  if (typeof node.type !== "string") fail(path + ".type", "must be a string.");
  if (node.version !== 1) fail(path, "must use Lexical node version 1.");

  if (node.type === "paragraph" || node.type === "heading" || node.type === "quote") {
    const keys = new Set([...ELEMENT_KEYS, ...(node.type === "heading" ? ["tag"] : [])]);
    onlyKeys(node, keys, path);
    const children = validateElementEnvelope(node, path);
    const runs = parseInlineNodes(children, path + ".children");
    const text = plainText(runs);
    if (children.length === 0) fail(path + ".children", "cannot represent an empty block.");
    const block = { id: "lexical-block-" + (index + 1), type: node.type, text };
    if (node.type === "heading") {
      if (typeof node.tag !== "string" || !/^h[2-4]$/.test(node.tag)) fail(path + ".tag", "must be h2, h3, or h4.");
      block.level = Number(node.tag.slice(1));
    }
    if (hasInlineMarkup(runs)) block.inlines = runs;
    return block;
  }

  if (node.type === "list") {
    onlyKeys(node, new Set([...ELEMENT_KEYS, "listType", "start", "tag"]), path);
    const children = validateElementEnvelope(node, path);
    const ordered = node.listType === "number" && node.tag === "ol";
    const unordered = node.listType === "bullet" && node.tag === "ul";
    if (!ordered && !unordered) fail(path, "must be an ordered or unordered list; checklists are not supported.");
    if (node.start !== undefined && node.start !== 1) fail(path + ".start", "must be 1 because custom list start values are not supported.");
    if (children.length < 1 || children.length > 100) fail(path + ".children", "must contain 1 to 100 list items.");
    const items = [];
    const itemInlines = [];
    let anyMarkup = false;
    for (let itemIndex = 0; itemIndex < children.length; itemIndex += 1) {
      const itemPath = path + ".children[" + itemIndex + "]";
      const item = expectRecord(children[itemIndex], itemPath);
      if (item.type !== "listitem") fail(itemPath, "must be a listitem node; nested lists and other list children are unsupported.");
      onlyKeys(item, new Set([...ELEMENT_KEYS, "checked", "value"]), itemPath);
      const itemChildren = validateElementEnvelope(item, itemPath);
      if (item.checked !== undefined && item.checked !== null) fail(itemPath + ".checked", "represents checkbox state not supported by the article contract.");
      if (item.value !== undefined && (!Number.isInteger(item.value) || item.value < 1)) fail(itemPath + ".value", "must be a positive integer.");
      const runs = parseInlineNodes(itemChildren, itemPath + ".children");
      const text = plainText(runs);
      if (!text.trim()) fail(itemPath, "cannot represent an empty list item.");
      items.push(text);
      itemInlines.push(runs);
      anyMarkup ||= hasInlineMarkup(runs);
    }
    const block = { id: "lexical-block-" + (index + 1), type: "list", ordered, items };
    if (anyMarkup) block.itemInlines = itemInlines;
    return block;
  }

  if (node.type === "code") {
    onlyKeys(node, new Set([...ELEMENT_KEYS, "language", "theme"]), path);
    const children = validateElementEnvelope(node, path);
    if (node.theme !== undefined && node.theme !== null && node.theme !== "") {
      fail(path + ".theme", "uses a custom code theme that the article contract cannot preserve.");
    }
    const code = parseInlineNodes(children, path + ".children", { code: true }).map((run) => run.text).join("");
    const language = node.language === undefined || node.language === null || node.language === "" ? "text" : node.language;
    if (typeof language !== "string") fail(path + ".language", "must be a string or null.");
    return { id: "lexical-block-" + (index + 1), type: "code", language, code };
  }

  fail(path, 'contains unsupported block node type "' + node.type + '".');
}
function textFormat(marks = []) {
  return marks.reduce((format, mark) => {
    const descriptor = TEXT_FORMATS.find((item) => item.mark === mark);
    return format | (descriptor ? descriptor.flag : 0);
  }, 0);
}
function lexicalTextNode(run) {
  return {
    detail: 0,
    format: textFormat(run.marks || []),
    mode: "normal",
    style: "",
    text: run.text,
    type: "text",
    version: 1,
  };
}
function lexicalLinkNode(run) {
  return {
    children: [lexicalTextNode(run)],
    direction: null,
    format: "",
    indent: 0,
    rel: null,
    target: null,
    title: null,
    type: "link",
    url: run.href,
    version: 1,
  };
}
function lexicalInlineNodes(runs) {
  return runs.map((run) => run.href === undefined ? lexicalTextNode(run) : lexicalLinkNode(run));
}
function lexicalElement(type, children, extra = {}) {
  return {
    children,
    direction: null,
    format: "",
    indent: 0,
    type,
    version: 1,
    ...extra,
  };
}
function toLexicalBlock(block, index) {
  const path = "contentBlocks[" + index + "]";
  if (block.type === "paragraph") {
    return lexicalElement("paragraph", lexicalInlineNodes(block.inlines || [{ text: block.text }]));
  }
  if (block.type === "heading") {
    return lexicalElement("heading", lexicalInlineNodes(block.inlines || [{ text: block.text }]), { tag: "h" + block.level });
  }
  if (block.type === "quote") {
    if (block.attribution !== undefined && block.attribution !== "") {
      fail(path + ".attribution", "cannot be represented by the configured standard Lexical QuoteNode.");
    }
    return lexicalElement("quote", lexicalInlineNodes(block.inlines || [{ text: block.text }]));
  }
  if (block.type === "list") {
    const items = block.items.map((item, itemIndex) => lexicalElement(
      "listitem",
      lexicalInlineNodes(block.itemInlines ? block.itemInlines[itemIndex] : [{ text: item }]),
      { checked: null, value: itemIndex + 1 },
    ));
    return lexicalElement("list", items, {
      listType: block.ordered ? "number" : "bullet",
      start: 1,
      tag: block.ordered ? "ol" : "ul",
    });
  }
  if (block.type === "code") {
    const children = block.code.length ? [lexicalTextNode({ text: block.code })] : [];
    return lexicalElement("code", children, { language: block.language, theme: "" });
  }
  fail(path, 'block type "' + block.type + '" has no registered Lexical node adapter.');
}
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  const sorted = {};
  for (const key of Object.keys(value).sort()) sorted[key] = canonicalize(value[key]);
  return sorted;
}
function blockSignature(block) {
  const content = { ...block };
  delete content.id;
  return JSON.stringify(canonicalize(content));
}
function assignBlockIds(blocks, previousBlocks, idFactory) {
  const previousBySignature = new Map();
  for (const previous of Array.isArray(previousBlocks) ? previousBlocks : []) {
    if (!isRecord(previous) || typeof previous.id !== "string") continue;
    const signature = blockSignature(previous);
    const matches = previousBySignature.get(signature) || [];
    matches.push(previous.id);
    previousBySignature.set(signature, matches);
  }
  const used = new Set();
  return blocks.map((block, index) => {
    const matches = previousBySignature.get(blockSignature(block));
    let id;
    while (matches && matches.length && !id) {
      const candidate = matches.shift();
      if (!used.has(candidate)) id = candidate;
    }
    if (!id) id = idFactory(index, block);
    if (typeof id !== "string" || id.trim().length === 0 || id.length > 100) {
      fail("root.children[" + index + "]", "idFactory must return a non-empty ID no longer than 100 characters.");
    }
    if (used.has(id)) {
      let suffix = 2;
      const base = id;
      while (used.has(id)) id = (base.slice(0, 94) + "-" + suffix++);
    }
    used.add(id);
    return { ...block, id };
  });
}

/**
 * Convert Lexical EditorState.toJSON() into application-owned article v1.
 * Unsupported/custom nodes fail closed; no HTML rendering or Lexical runtime
 * package is required by this adapter.
 */
export function lexicalEditorStateToArticleDocument(serializedState, { previousBlocks = [], idFactory = (index) => "lexical-block-" + (index + 1) } = {}) {
  let state = serializedState;
  if (typeof state === "string") {
    if (state.length > MAX_LEXICAL_JSON_CHARACTERS) fail("state", "exceeds the serialized size limit.");
    try {
      state = JSON.parse(state);
    } catch {
      fail("state", "is not valid JSON.");
    }
  } else {
    try {
      if (JSON.stringify(state).length > MAX_LEXICAL_JSON_CHARACTERS) fail("state", "exceeds the serialized size limit.");
    } catch (error) {
      if (error instanceof ArticleInputError) throw error;
      fail("state", "cannot be serialized as JSON.");
    }
  }

  expectRecord(state, "state");
  onlyKeys(state, new Set(["root"]), "state");
  const root = expectRecord(state.root, "state.root");
  onlyKeys(root, new Set([...ELEMENT_KEYS]), "state.root");
  if (root.type !== "root") fail("state.root", "must be a Lexical root node.");
  const children = validateElementEnvelope(root, "state.root");
  if (children.length < 1 || children.length > 200) fail("state.root.children", "must contain 1 to 200 blocks.");
  const blocks = children.map((node, index) => parseBlock(node, index));
  const contentBlocks = assignBlockIds(blocks, previousBlocks, idFactory);
  return {
    contentBlocksVersion: 1,
    contentBlocks: validateArticleBlocks(contentBlocks, 1),
  };
}

/**
 * Convert validated application blocks to serialized Lexical EditorState.
 * Image nodes and quote attributions are rejected until matching custom-node
 * and media-workflow contracts are implemented.
 */
export function articleDocumentToLexicalEditorState(contentBlocks, { contentBlocksVersion = 1 } = {}) {
  const version = validateArticleContentBlocksVersion(contentBlocksVersion);
  const validated = validateArticleBlocks(contentBlocks, version);
  return { root: lexicalElement("root", validated.map(toLexicalBlock)) };
}
