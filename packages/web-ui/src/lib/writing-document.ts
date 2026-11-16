import type { WritingDraft } from "./writing-session.ts";

export type WritingNode = Record<string, unknown>;
export type WritingPath = number[];
export type WritingRun = { path: WritingPath; text: string; start: number; end: number; boundary: boolean };
export type WritingBlock = { path: WritingPath; kind: string; text: string; runs: WritingRun[]; searchable: boolean };
export type WritingIssue = { code: string; message: string; path: WritingPath | null; severity: "warning" | "error" };
export type WritingOutlineItem = { path: WritingPath; title: string; level: number };
export type WritingInspection = {
  blocks: WritingBlock[];
  outline: WritingOutlineItem[];
  issues: WritingIssue[];
  limited: boolean;
  statistics: { characters: number; words: number; minutes: number; blocks: number; images: number; links: number; codeBlocks: number };
};
export const WRITING_TEXT_LIMIT = 500_000;
export const WRITING_NODE_LIMIT = 12_000;

export function writingRecord(value: unknown): WritingNode | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as WritingNode : null;
}

export function writingChildren(node: WritingNode): WritingNode[] {
  return Array.isArray(node.children) ? node.children.map(writingRecord).filter((item): item is WritingNode => item !== null) : [];
}

export function writingNodeAt(root: WritingNode, path: readonly number[]): WritingNode | null {
  let node: WritingNode | null = root;
  for (const index of path) {
    if (!Number.isSafeInteger(index) || index < 0 || !Array.isArray(node?.children)) return null;
    node = writingRecord(node.children[index]);
    if (!node) return null;
  }
  return node;
}

/** Current editor inspection is bounded even if pasted/unsupported content cannot yet be saved. */
export function inspectWriting(draft: WritingDraft): WritingInspection {
  const result: WritingInspection = {
    blocks: [], outline: [], issues: [], limited: false,
    statistics: { characters: 0, words: 0, minutes: 0, blocks: 0, images: 0, links: 0, codeBlocks: 0 },
  };
  let visited = 0;
  let textSize = 0;
  const issue = (code: string, message: string, path: WritingPath | null, severity: WritingIssue["severity"] = "warning") => {
    if (result.issues.length < 100) result.issues.push({ code, message, path, severity });
    else result.limited = true;
  };
  const enter = (depth: number): boolean => {
    if (++visited > WRITING_NODE_LIMIT || depth > 8 || textSize > WRITING_TEXT_LIMIT) { result.limited = true; return false; }
    return true;
  };
  const eachChild = (node: WritingNode, path: WritingPath, read: (child: WritingNode, path: WritingPath) => void) => {
    if (!Array.isArray(node.children)) return;
    for (let index = 0; index < node.children.length && !result.limited; index++) {
      const child = writingRecord(node.children[index]);
      if (child) read(child, [...path, index]);
      else issue("unsupported-node", "此处含无效节点；未改动原文。", [...path, index], "error");
    }
  };
  const inline = (node: WritingNode, path: WritingPath, block: WritingBlock, inLink = false): void => {
    if (!enter(path.length)) return;
    if (node.type === "text" || node.type === "code-highlight") {
      const text = typeof node.text === "string" ? node.text : "";
      const start = block.text.length;
      block.text += text.slice(0, Math.max(0, WRITING_TEXT_LIMIT - textSize));
      block.runs.push({ path, text: block.text.slice(start), start, end: block.text.length, boundary: node.mode === "token" });
      textSize += text.length;
      if ((typeof node.style === "string" && node.style !== "") ||
          (typeof node.format === "number" && (node.format & ~31) !== 0) ||
          (node.mode !== undefined && node.mode !== "normal")) issue("unsupported-format", "此处格式无法由文章格式完整保留，请调整后保存。", path, "error");
      return;
    }
    if (node.type === "linebreak" || node.type === "tab") {
      const text = node.type === "tab" ? "\t" : "\n";
      block.runs.push({ path, text, start: block.text.length, end: block.text.length + 1, boundary: true });
      block.text += text;
      textSize++;
      issue("unsupported-break", "正文含显式换行或制表节点；请在保存前改为段落或普通文字。查找替换不会跨越此节点。", path, "error");
      return;
    }
    if ((node.type === "link" || node.type === "autolink") && !inLink) {
      result.statistics.links++;
      eachChild(node, path, (child, childPath) => inline(child, childPath, block, true));
      return;
    }
    issue("unsupported-node", "此处包含当前文章格式不支持的节点；未改动原文。", path, "error");
  };
  const addTextBlock = (node: WritingNode, path: WritingPath) => {
    const kind = String(node.type);
    const block: WritingBlock = { path, kind, text: "", runs: [], searchable: kind !== "code" };
    eachChild(node, path, (child, childPath) => inline(child, childPath, block));
    result.blocks.push(block);
    if (kind === "code") result.statistics.codeBlocks++;
    if (kind === "heading") {
      const level = /^h[2-4]$/.test(String(node.tag)) ? Number(String(node.tag).slice(1)) : 0;
      if (!level) issue("heading-level", "标题仅支持二至四级，请重新选择级别。", path, "error");
      else result.outline.push({ path, title: block.text.trim() || "（空标题）", level });
      if (!block.text.trim()) issue("heading-empty", "空标题会在保存时被省略，请补写或改为段落。", path);
    }
    if (kind === "paragraph" && Array.from(block.text).length > 800) issue("paragraph-long", "此段超过 800 字符；可按内容需要分段，方便阅读。", path);
  };
  const visit = (node: WritingNode, path: WritingPath): void => {
    if (!enter(path.length)) return;
    if ((node.format !== undefined && node.format !== "" && node.format !== 0) ||
        (node.indent !== undefined && node.indent !== 0) || node.direction === "rtl") {
      issue("unsupported-layout", "此处包含文章格式无法保留的对齐、缩进或书写方向。", path, "error");
    }
    switch (node.type) {
      case "paragraph": case "heading": case "quote": case "code": case "listitem":
        addTextBlock(node, path);
        break;
      case "list":
        eachChild(node, path, (child, childPath) => {
          if (child.type !== "listitem") issue("unsupported-node", "非标准列表项暂不支持安全保存。", childPath, "error");
          else visit(child, childPath);
        });
        break;
      case "image":
        result.statistics.images++;
        if (typeof node.alt !== "string" || !node.alt.trim()) issue("image-alt", "图片缺少替代文本，请重新插入并填写描述。", path, "error");
        if (typeof node.alt === "string" && node.alt.length > 500) issue("image-alt-long", "图片替代文本超过 500 字符。", path, "error");
        break;
      default:
        issue("unsupported-node", "此处包含尚不支持的内容块；不会静默忽略后替换或恢复。", path, "error");
    }
  };
  if (!draft.title.trim()) issue("title-empty", "尚未填写作品标题。", null, "error");
  if (draft.title.length > 200) issue("title-long", "标题超过 200 字符。", null, "error");
  if (draft.summary.length > 2000) issue("summary-long", "摘要超过 2000 字符。", null, "error");
  const children = draft.editorState?.root.children ?? [];
  result.statistics.blocks = children.length;
  if (children.length > 200) issue("blocks-limit", "正文超过 200 个内容块，服务端将拒绝保存。", null, "error");
  children.slice(0, 201).forEach((node, index) => visit(node, [index]));
  if (!result.blocks.some(block => block.text.trim())) issue("body-empty", "文字正文为空，尚不能保存或发布。", null, "error");
  const seenHeadings = new Set<string>();
  let previousLevel = 1;
  for (const heading of result.outline) {
    if (heading.level > previousLevel + 1) issue("heading-gap", "标题层级有跳级，可调整级别使结构更清楚。", heading.path);
    const key = heading.title.normalize("NFKC").replace(/\s+/gu, " ").toLocaleLowerCase();
    if (seenHeadings.has(key)) issue("heading-duplicate", "此标题与前文重复，可核对是否需要区分。", heading.path);
    seenHeadings.add(key);
    previousLevel = heading.level;
  }
  const text = result.blocks.filter(block => block.kind !== "code").map(block => block.text).join("\n");
  result.statistics.characters = Array.from(text.replace(/\s/gu, "")).length;
  result.statistics.words = (text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? []).length;
  const han = (text.match(/\p{Script=Han}/gu) ?? []).length;
  const otherWords = (text.replace(/\p{Script=Han}/gu, " ").match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? []).length;
  result.statistics.minutes = text.trim() ? Math.max(1, Math.ceil(han / 400 + otherWords / 220)) : 0;
  if (children.length > 200 || textSize > WRITING_TEXT_LIMIT || visited > WRITING_NODE_LIMIT) result.limited = true;
  return result;
}

export type WritingSectionStatistics = WritingOutlineItem & { startBlock: number; endBlock: number; characters: number; words: number; minutes: number; images: number };

/** Prefix sums make nested section lengths linear in text size, not heading-count × document-size. */
export function writingSectionStatistics(draft: WritingDraft, inspection: WritingInspection): WritingSectionStatistics[] {
  const nodes = draft.editorState?.root.children ?? [];
  if (inspection.limited || !nodes.length) return [];
  const totals = Array.from({ length: nodes.length }, () => ({ characters: 0, words: 0, han: 0, otherWords: 0, images: 0 }));
  for (const block of inspection.blocks) {
    if (block.kind === "code") continue;
    const total = totals[block.path[0]!];
    if (!total) continue;
    total.characters += Array.from(block.text.replace(/\s/gu, "")).length;
    total.words += (block.text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? []).length;
    total.han += (block.text.match(/\p{Script=Han}/gu) ?? []).length;
    total.otherWords += (block.text.replace(/\p{Script=Han}/gu, " ").match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? []).length;
  }
  nodes.forEach((node, index) => { if (node.type === "image") totals[index]!.images++; });
  const prefix = [{ characters: 0, words: 0, han: 0, otherWords: 0, images: 0 }];
  for (const total of totals) {
    const previous = prefix.at(-1)!;
    prefix.push({ characters: previous.characters + total.characters, words: previous.words + total.words,
      han: previous.han + total.han, otherWords: previous.otherWords + total.otherWords, images: previous.images + total.images });
  }
  const sections = inspection.outline.map(heading => ({ ...heading, startBlock: heading.path[0]!, endBlock: nodes.length, characters: 0, words: 0, minutes: 0, images: 0 }));
  const active: WritingSectionStatistics[] = [];
  const finish = (section: WritingSectionStatistics, end: number) => {
    const start = prefix[section.startBlock], tail = prefix[end];
    if (!start || !tail) return;
    section.endBlock = end;
    section.characters = tail.characters - start.characters;
    section.words = tail.words - start.words;
    section.images = tail.images - start.images;
    const minutes = (tail.han - start.han) / 400 + (tail.otherWords - start.otherWords) / 220;
    section.minutes = section.characters ? Math.max(1, Math.ceil(minutes)) : 0;
  };
  for (const section of sections) {
    while (active.length && active.at(-1)!.level >= section.level) finish(active.pop()!, section.startBlock);
    active.push(section);
  }
  while (active.length) finish(active.pop()!, nodes.length);
  return sections;
}
