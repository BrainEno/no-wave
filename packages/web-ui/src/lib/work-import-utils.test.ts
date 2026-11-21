import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeWorkType,
  normalizeLocale,
  parseUserDataInput,
  applyBatchPatch,
  extractParagraphs,
  parseTextOrMarkdown,
  parseHtmlContent,
  validateImportItem,
  type ParsedImportItem,
} from "./work-import-utils.ts";

test("normalizeWorkType correctly maps various genre strings", () => {
  assert.equal(normalizeWorkType("小说"), "novel");
  assert.equal(normalizeWorkType("短篇小说"), "short_story");
  assert.equal(normalizeWorkType("诗歌"), "poetry");
  assert.equal(normalizeWorkType("散文"), "essay");
  assert.equal(normalizeWorkType("随笔"), "essay");
  assert.equal(normalizeWorkType("评论"), "criticism");
  assert.equal(normalizeWorkType("非虚构"), "nonfiction");
  assert.equal(normalizeWorkType("unknown_genre"), "essay");
});

test("normalizeLocale correctly maps various language strings", () => {
  assert.equal(normalizeLocale("zh-CN"), "zh-CN");
  assert.equal(normalizeLocale("中文"), "zh-CN");
  assert.equal(normalizeLocale("en"), "en");
  assert.equal(normalizeLocale("English"), "en");
  assert.equal(normalizeLocale("zh-TW"), "zh-TW");
});

test("parseUserDataInput parses JSON arrays with various field aliases", () => {
  const jsonInput = JSON.stringify([
    {
      标题: "百年孤独阅读笔记",
      正文: "第一段正文。\n\n第二段正文。",
      作者: "马尔克斯读者",
      体裁: "随笔",
    },
    {
      title: "Silent Spring Reflection",
      content: "Chapter 1 notes.\n\nChapter 2 notes.",
      locale: "en",
      workType: "nonfiction",
    },
  ]);

  const items = parseUserDataInput(jsonInput, "默认作者");
  assert.equal(items.length, 2);

  assert.equal(items[0].title, "百年孤独阅读笔记");
  assert.equal(items[0].author, "马尔克斯读者");
  assert.equal(items[0].workType, "essay");
  assert.equal(items[0].locale, "zh-CN");
  assert.equal(items[0].validationErrors.length, 0);

  assert.equal(items[1].title, "Silent Spring Reflection");
  assert.equal(items[1].author, "默认作者");
  assert.equal(items[1].locale, "en");
  assert.equal(items[1].workType, "nonfiction");
});

test("parseUserDataInput parses CSV strings", () => {
  const csvInput = `标题,作者,体裁,正文
关于文学的断想,卡尔维诺,随笔,经典作品是那些你经常听人家说我正在重读的作品。
寒夜,巴金,小说,昏暗的街灯下。`;

  const items = parseUserDataInput(csvInput);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "关于文学的断想");
  assert.equal(items[0].author, "卡尔维诺");
  assert.equal(items[0].workType, "essay");
  assert.equal(items[1].title, "寒夜");
  assert.equal(items[1].author, "巴金");
  assert.equal(items[1].workType, "novel");
});

test("applyBatchPatch fills missing fields in bulk", () => {
  const rawItems: ParsedImportItem[] = [
    {
      id: "1",
      title: "作品一",
      content: "正文内容一",
      author: "",
      summary: "",
      workType: "essay",
      locale: "zh-CN",
      publish: false,
      validationErrors: ["缺少作者"],
    },
    {
      id: "2",
      title: "作品二",
      content: "正文内容二",
      author: "已有作者",
      summary: "",
      workType: "essay",
      locale: "zh-CN",
      publish: false,
      validationErrors: [],
    },
  ];

  const patched = applyBatchPatch(rawItems, {
    author: "补充作者名",
    workType: "poetry",
    fillSummaryFromContent: true,
  });

  assert.equal(patched[0].author, "补充作者名");
  assert.equal(patched[0].workType, "poetry");
  assert.equal(patched[0].summary, "正文内容一");
  assert.equal(patched[0].validationErrors.length, 0);

  assert.equal(patched[1].author, "补充作者名");
  assert.equal(patched[1].workType, "poetry");
  assert.equal(patched[1].summary, "正文内容二");
});

test("parseTextOrMarkdown extracts title and paragraphs", () => {
  const text = `# 标题测试\n\n这是第一段正文。\n\n这是第二段正文。`;
  const parsed = parseTextOrMarkdown(text);
  assert.equal(parsed.title, "标题测试");
  assert.equal(extractParagraphs(parsed.content).length, 2);
});

test("parseHtmlContent extracts title and paragraphs safely without DOMParser", () => {
  const html = `<!DOCTYPE html><html><head><title>网页测试标题</title></head><body><h1>网页测试标题</h1><p>第一段内容。</p><p>第二段内容。</p></body></html>`;
  const parsed = parseHtmlContent(html);
  assert.equal(parsed.title, "网页测试标题");
  assert.equal(extractParagraphs(parsed.content).length, 2);
});
