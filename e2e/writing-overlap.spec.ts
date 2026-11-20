import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import {
  createWritingBackup,
  parseWritingBackup,
} from "../packages/web-ui/src/lib/writing-backup.ts";
import { createWritingCollection } from "../packages/web-ui/src/lib/writing-collection.ts";
import type { WritingNode } from "../packages/web-ui/src/lib/writing-document.ts";
import type { WritingDraft } from "../packages/web-ui/src/lib/writing-session.ts";
import { test } from "./support/article-view-stack.ts";

const stamp = new Date("2026-11-12T00:00:00.000Z");
const body =
  "PRIVATE_BODY The river remembers every quiet morning beneath the willow trees in our valley.";
const paragraph = (text: string, format = 0): WritingNode => ({
  type: "paragraph",
  version: 1,
  children: [{ type: "text", version: 1, text, format }],
});
function draft(
  items: (string | WritingNode)[],
  title = "PRIVATE_TITLE",
): WritingDraft {
  return {
    title,
    summary: "PRIVATE_SUMMARY",
    locale: "en",
    workType: "essay",
    editorState: {
      root: {
        type: "root",
        version: 1,
        children: items.map((item) =>
          typeof item === "string" ? paragraph(item) : item,
        ),
      },
    },
  };
}
async function collection(documents: WritingDraft[]) {
  return (
    await createWritingCollection(
      documents.map((item, index) => ({
        group: String(index),
        backup: parseWritingBackup(createWritingBackup(item, stamp)),
      })),
      stamp,
    )
  ).text;
}
async function start(page: Page) {
  await page.goto(
    "/write/overlap?file=https%3A%2F%2Fprivate-overlap.example.test%2FNEVER_READ.json",
  );
  await expect(page).toHaveURL(/\/write\/overlap$/);
  await expect(
    page.getByRole("heading", { name: "本机文稿重复段落审阅", exact: true }),
  ).toBeVisible();
}
async function load(page: Page, text: string, name = "PRIVATE_FILE.json") {
  await page
    .getByLabel("段落审阅备份或集合文件", { exact: true })
    .setInputFiles({
      name,
      mimeType: "application/json",
      buffer: Buffer.from(text),
    });
  await expect(
    page
      .getByRole("region", { name: "段落审阅来源", exact: true })
      .getByRole("status"),
  ).toContainText("来源结构校验通过");
}
async function analyze(page: Page) {
  await page
    .getByRole("button", { name: "分析本机段落重复", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "本机重复候选审阅", exact: true }),
  ).toBeVisible();
}
async function download(page: Page) {
  const event = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "下载无正文段落报告", exact: true })
    .click();
  const artifact = await event;
  return {
    name: artifact.suggestedFilename(),
    text: await readFile((await artifact.path())!, "utf8"),
  };
}

test("anonymous offline overlap review preserves every occurrence, hides no global marks in a filtered report and never requests embedded media", async ({
  page,
  context,
}) => {
  const forbidden: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() !== "GET" ||
      new URL(request.url()).hostname === "private-overlap.example.test"
    )
      forbidden.push(request.url());
  });
  await start(page);
  const text = await collection([
    draft([
      body,
      paragraph(body, 1),
      {
        type: "image",
        version: 1,
        src: "https://private-overlap.example.test/NEVER_FETCH.png",
        alt: "PRIVATE_ALT",
      },
    ]),
    draft([
      body,
      body.replace("morning", "evening"),
      {
        type: "code",
        version: 1,
        children: [{ type: "text", version: 1, text: body }],
      },
    ]),
  ]);
  await page.evaluate(() => document.fonts.ready);
  await context.setOffline(true);
  await load(page, text);
  await analyze(page);
  const list = page.getByRole("list", {
    name: "重复段落候选清单",
    exact: true,
  });
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(list).toContainText("当前范围内 2 个位置配对");
  await page
    .getByRole("button", { name: "只读核对 e:f1", exact: true })
    .click();
  await expect(page.locator(".nw-overlap-detail")).toBeFocused();
  await expect(
    page
      .getByRole("region", { name: "左侧原始文字", exact: true })
      .locator("pre"),
  ).toHaveText(body);
  await expect(
    page.getByLabel("左侧原始段落位置", { exact: true }).locator("option"),
  ).toHaveCount(3);
  await expect(
    page.getByLabel("右侧原始段落位置", { exact: true }).locator("option"),
  ).toHaveCount(1);
  await page
    .getByRole("button", { name: "关闭原文核对并返回条目", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "只读核对 e:f1", exact: true }),
  ).toBeFocused();
  await page
    .getByLabel("标记 e:f1", { exact: true })
    .selectOption("intentional");
  await page.getByLabel("重复候选类型", { exact: true }).selectOption("near");
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await page
    .getByRole("button", { name: "准备当前无正文报告", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "下载无正文段落报告", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("checkbox", {
      name: "我已核对报告范围，理解无正文报告仍含私密元数据",
      exact: true,
    })
    .check();
  const saved = await download(page),
    report = JSON.parse(saved.text);
  expect(saved.name).toBe(
    "no-wave-overlap-report-" + report.createdAt.slice(0, 10) + ".json",
  );
  expect(report.review).toEqual({
    findings: 2,
    unreviewed: 1,
    intentional: 1,
    followUp: 0,
  });
  expect(report.findings[0]).toMatchObject({
    kind: "exact",
    verdict: "intentional",
    richVariants: 2,
  });
  expect(report.families[0].occurrences).toHaveLength(3);
  expect(saved.text).not.toMatch(
    /PRIVATE|river|morning|evening|title|summary|filename|https:|children|normalized|structure|authorId|revision|token|password/,
  );
  await page
    .getByLabel("标记 n:f1:f2", { exact: true })
    .selectOption("follow-up");
  await expect(
    page.getByRole("button", { name: "下载无正文段落报告", exact: true }),
  ).toHaveCount(0);
  expect(
    await page
      .locator(
        "[contenteditable='true'], a[href*='private-overlap.example.test'], img[src*='private-overlap.example.test']",
      )
      .count(),
  ).toBe(0);
  expect(forbidden).toEqual([]);
  expect(
    await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    ),
  ).not.toContain("PRIVATE");
  expect(
    await page.evaluate(async () =>
      (await indexedDB.databases()).map((database) => database.name),
    ),
  ).not.toContain("no-wave-writing-recovery-v1");
});

test("normalization is opt-in and editing even an invalid numeric condition immediately revokes candidates, marks and report confirmation", async ({
  page,
}) => {
  await start(page);
  await load(
    page,
    await collection([
      draft([
        "Ｒｉｖｅｒ　ＷＯＲＤＳ　ｂｅｎｅａｔｈ　ｔｈｅ　ｗｉｌｌｏｗ　ｔｒｅｅｓ",
      ]),
      draft(["river words beneath the willow trees"]),
    ]),
  );
  await analyze(page);
  await expect(
    page.getByRole("heading", { name: "同文字组 e:f1", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("文字比较模式", { exact: true }).selectOption("folded");
  await expect(
    page.getByRole("region", { name: "本机重复候选审阅", exact: true }),
  ).toHaveCount(0);
  await analyze(page);
  await expect(
    page.getByRole("heading", { name: "同文字组 e:f1", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "准备当前无正文报告", exact: true })
    .click();
  await page
    .getByRole("checkbox", {
      name: "我已核对报告范围，理解无正文报告仍含私密元数据",
      exact: true,
    })
    .check();
  await page.getByLabel("最短段落字符数", { exact: true }).fill("0");
  await expect(
    page.getByRole("button", { name: "下载无正文段落报告", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "分析本机段落重复", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "本机重复候选审阅", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("最短段落字符数", { exact: true }).fill("8");
  await analyze(page);
  await expect(
    page.getByRole("status").filter({ hasText: "已标记 0 项" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "下载无正文段落报告", exact: true }),
  ).toHaveCount(0);
  await load(page, createWritingBackup(draft([body, body]), stamp));
  await page
    .getByLabel("文稿配对范围", { exact: true })
    .selectOption("within-document");
  await analyze(page);
  await expect(
    page.getByRole("list", { name: "重复段落候选清单", exact: true }),
  ).toContainText("当前范围内 1 个位置配对");
});

test("corrupt checksums, ambiguous JSON, invalid UTF-8 and oversize input discard old content atomically before any new source is adopted", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const NativeReader = window.FileReader;
    window.FileReader = class extends NativeReader {
      readAsArrayBuffer(file: Blob) {
        document.documentElement.dataset.overlapReads = String(
          Number(document.documentElement.dataset.overlapReads ?? 0) + 1,
        );
        super.readAsArrayBuffer(file);
      }
    };
  });
  await start(page);
  const text = await collection([draft([body]), draft([body])]);
  await load(page, text);
  await analyze(page);
  const input = page.getByLabel("段落审阅备份或集合文件", { exact: true });
  const upload = (buffer: Buffer) =>
    input.setInputFiles({
      name: "bad.json",
      mimeType: "application/json",
      buffer,
    });
  await upload(Buffer.from(text.replace("PRIVATE_TITLE", "TAMPERED_TITLE")));
  await expect(page.getByRole("alert")).toContainText("摘要不匹配");
  await expect(
    page.getByRole("region", { name: "本机重复候选审阅", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("list", { name: "段落审阅文稿编号", exact: true }),
  ).toHaveCount(0);
  await upload(
    Buffer.from(text.replace('"version":1', '"version":2,"\\u0076ersion":1')),
  );
  await expect(page.getByRole("alert")).toContainText("重复或歧义");
  await upload(Buffer.from([0xc3, 0x28]));
  await expect(page.getByRole("alert")).toContainText("UTF-8");
  const reads = await page.locator("html").getAttribute("data-overlap-reads");
  await upload(Buffer.alloc(16 * 1024 * 1024 + 1, 32));
  await expect(page.getByRole("alert")).toContainText("未读取文件");
  expect(await page.locator("html").getAttribute("data-overlap-reads")).toBe(
    reads,
  );
  await expect(input).toHaveValue("");
});

test("late native digests cannot replace a new file, page-transition clearing is synchronous, and actual back navigation never auto-reads a previous file", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const native = crypto.subtle.digest.bind(crypto.subtle);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state = window as unknown as {
      holdOverlapDigest: boolean;
      releaseOverlapDigest(): void;
    };
    state.holdOverlapDigest = true;
    state.releaseOverlapDigest = release;
    crypto.subtle.digest = async (...args) => {
      if (state.holdOverlapDigest) {
        state.holdOverlapDigest = false;
        document.documentElement.dataset.overlapDigestHeld = "yes";
        await gate;
        const result = await native(...args);
        document.documentElement.dataset.overlapDigestFinished = "yes";
        return result;
      }
      return native(...args);
    };
  });
  await start(page);
  const input = page.getByLabel("段落审阅备份或集合文件", { exact: true });
  await input.setInputFiles({
    name: "OLD_PRIVATE.json",
    mimeType: "application/json",
    buffer: Buffer.from(await collection([draft([body], "OLD_PRIVATE")])),
  });
  await expect(page.locator("html")).toHaveAttribute(
    "data-overlap-digest-held",
    "yes",
  );
  const current = await collection([draft([body, body], "NEW_PRIVATE")]);
  await load(page, current, "NEW_PRIVATE.json");
  await page.evaluate(() =>
    (
      window as unknown as { releaseOverlapDigest(): void }
    ).releaseOverlapDigest(),
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-overlap-digest-finished",
    "yes",
  );
  await expect(
    page.getByRole("list", { name: "段落审阅文稿编号", exact: true }),
  ).toContainText("NEW_PRIVATE");
  await expect(page.locator("main")).not.toContainText("OLD_PRIVATE");
  await page
    .getByLabel("文稿配对范围", { exact: true })
    .selectOption("within-document");
  await analyze(page);
  await page
    .getByRole("button", { name: "只读核对 e:f1", exact: true })
    .click();
  const immediate = await page.evaluate(() => {
    window.dispatchEvent(
      new PageTransitionEvent("pagehide", { persisted: true }),
    );
    return document.querySelector("main")!.textContent;
  });
  expect(immediate).not.toMatch(/PRIVATE|river|\.json/);
  await page.evaluate(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    ),
  );
  await expect(input).toHaveValue("");
  await load(page, current);
  await page.getByRole("link", { name: "本机集合工具", exact: true }).click();
  await expect(page).toHaveURL(/\/write\/collections$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/write\/overlap$/);
  await expect(
    page.getByRole("list", { name: "段落审阅文稿编号", exact: true }),
  ).toHaveCount(0);
  await expect(input).toHaveValue("");
});

test("stopping an analysis held in native digest work never revives old candidates or a report, and only a new explicit run can complete", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const native = crypto.subtle.digest.bind(crypto.subtle);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state = window as unknown as {
      holdOverlapAnalysis: boolean;
      releaseOverlapAnalysis(): void;
    };
    state.holdOverlapAnalysis = false;
    state.releaseOverlapAnalysis = release;
    crypto.subtle.digest = async (...args) => {
      if (state.holdOverlapAnalysis) {
        state.holdOverlapAnalysis = false;
        document.documentElement.dataset.overlapAnalysisHeld = "yes";
        await gate;
        const result = await native(...args);
        document.documentElement.dataset.overlapAnalysisFinished = "yes";
        return result;
      }
      return native(...args);
    };
  });
  await start(page);
  await load(page, await collection([draft([body]), draft([body])]));
  await page.evaluate(() => {
    (
      window as unknown as { holdOverlapAnalysis: boolean }
    ).holdOverlapAnalysis = true;
  });
  await page
    .getByRole("button", { name: "分析本机段落重复", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-overlap-analysis-held",
    "yes",
  );
  await page.getByRole("button", { name: "停止段落分析", exact: true }).click();
  await page.evaluate(() =>
    (
      window as unknown as { releaseOverlapAnalysis(): void }
    ).releaseOverlapAnalysis(),
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-overlap-analysis-finished",
    "yes",
  );
  await expect(
    page.getByRole("region", { name: "本机重复候选审阅", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "准备当前无正文报告", exact: true }),
  ).toHaveCount(0);
  await analyze(page);
  await expect(
    page.getByRole("heading", { name: "同文字组 e:f1", exact: true }),
  ).toBeVisible();
});

test("mobile plain-text/JSON paging escapes hostile-looking content, exposes long-unit exclusions and remains keyboard- and axe-accessible", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await start(page);
  const text =
    '<img src=x onerror="alert(1)">' +
    "静静的河流🦊 ".repeat(650) +
    "PRIVATE_END";
  await load(
    page,
    await collection([
      draft([text], "<script>PRIVATE_TITLE</script>"),
      draft([text]),
    ]),
    "<script>PRIVATE_FILE</script>.json",
  );
  await analyze(page);
  await expect(
    page.getByRole("region", { name: "段落分析覆盖与限制", exact: true }),
  ).toContainText("超长文字组仅参加同文字分组");
  await page
    .getByRole("button", { name: "只读核对 e:f1", exact: true })
    .click();
  const left = page.getByRole("region", { name: "左侧原始文字", exact: true });
  expect((await left.locator("pre").textContent())!.length).toBeLessThanOrEqual(
    2048,
  );
  await expect(left.locator("pre")).not.toContainText("PRIVATE_END");
  await page
    .getByLabel("定位左侧原始文字字符偏移", { exact: true })
    .fill(String(text.length - 30));
  await page
    .getByRole("button", { name: "定位左侧原始文字", exact: true })
    .click();
  await expect(left.locator("pre")).toContainText("PRIVATE_END");
  await expect(left).toBeFocused();
  await page
    .getByText("只读查看这两处的富文本节点 JSON", { exact: true })
    .click();
  expect(
    await page
      .getByRole("region", { name: "重复候选原文核对", exact: true })
      .locator("img,script,a")
      .count(),
  ).toBe(0);
  expect(dialogs).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("optional fragment explanations expose multiplicity at 100-percent set similarity, reach every occurrence, remain inert and never enter the report", async ({
  page,
}) => {
  await start(page);
  const left = "abcde".repeat(7),
    right = "abcde".repeat(11);
  await load(page, await collection([draft([left]), draft([right])]));
  await analyze(page);
  await page
    .getByRole("button", { name: "只读核对 n:f1:f2", exact: true })
    .click();
  const evidence = page.getByRole("region", {
    name: "所选候选的片段解释",
    exact: true,
  });
  const terms = evidence.getByRole("list", {
    name: "解释片段清单",
    exact: true,
  });
  await expect(terms).toHaveCount(0);
  await evidence
    .getByRole("button", { name: "按需解释这对候选", exact: true })
    .click();
  await expect(evidence).toContainText("Jaccard 100.00%");
  await expect(evidence).toContainText("诊断比例 60.78%");
  await evidence.getByLabel("解释片段字面筛选", { exact: true }).fill("abcde");
  await expect(terms.getByRole("listitem")).toHaveCount(1);
  const trigger = evidence.getByRole("button", {
    name: "查看片段 g1 的每处位置",
    exact: true,
  });
  await trigger.click();
  const positions = page.getByRole("region", {
    name: "所选解释片段位置",
    exact: true,
  });
  await expect(positions).toBeFocused();
  const context = positions.getByRole("region", {
    name: "左侧片段上下文",
    exact: true,
  });
  await context
    .getByRole("button", { name: "最后一处左侧片段", exact: true })
    .click();
  await expect(context).toContainText("左侧第 7 / 7 处");
  await context.getByLabel("定位左侧片段出现序号", { exact: true }).fill("0");
  await context
    .getByRole("button", { name: "定位左侧片段出现位置", exact: true })
    .click();
  await expect(context.getByRole("alert")).toContainText("未跳到其他片段");
  await context.getByLabel("定位左侧片段出现序号", { exact: true }).fill("2");
  await context
    .getByRole("button", { name: "定位左侧片段出现位置", exact: true })
    .click();
  await expect(context).toContainText("分析文字代码点 [5, 10)");
  await positions
    .getByRole("button", { name: "关闭片段位置并返回触发处", exact: true })
    .click();
  await expect(trigger).toBeFocused();
  await evidence
    .getByText("按共享片段覆盖查看分析文字", { exact: true })
    .click();
  const coverage = evidence.getByRole("region", {
    name: "左侧分析文字覆盖",
    exact: true,
  });
  await expect(coverage.locator("pre")).toHaveText(left);
  await expect(coverage.locator("mark")).toHaveCount(1);
  await expect(evidence.locator("img,script,a")).toHaveCount(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page
    .getByRole("button", { name: "准备当前无正文报告", exact: true })
    .click();
  await page
    .getByRole("checkbox", {
      name: "我已核对报告范围，理解无正文报告仍含私密元数据",
      exact: true,
    })
    .check();
  const report = await download(page);
  expect(report.text).not.toMatch(
    /abcde|PRIVATE|evidence|anchors|terms|normalized|countBasisPoints/,
  );
  await page
    .getByRole("button", { name: "关闭原文核对并返回条目", exact: true })
    .click();
  await page
    .getByRole("button", { name: "只读核对 n:f1:f2", exact: true })
    .click();
  await expect(terms).toHaveCount(0);
  await evidence
    .getByRole("button", { name: "按需解释这对候选", exact: true })
    .click();
  await expect(terms).toBeVisible();
  await evidence
    .getByRole("button", { name: "停止并清除片段解释", exact: true })
    .click();
  await expect(terms).toHaveCount(0);
  await evidence
    .getByRole("button", { name: "按需解释这对候选", exact: true })
    .click();
  await expect(terms).toBeVisible();
  const cleared = await page.evaluate(() => {
    window.dispatchEvent(
      new PageTransitionEvent("pagehide", { persisted: true }),
    );
    return document.querySelector("main")!.textContent;
  });
  expect(cleared).not.toMatch(/PRIVATE|abcde|\.json/);
  await expect(evidence).toHaveCount(0);
});

test("document-pair overview restricts both list and occurrence pickers while hidden marks and report totals remain global", async ({
  page,
}) => {
  await start(page);
  await load(
    page,
    await collection([
      draft([body, paragraph(body, 1)]),
      draft([body.replace("morning", "evening")]),
      draft([body]),
    ]),
  );
  await analyze(page);
  const overview = page.getByRole("region", {
    name: "已列候选的文稿对概览",
    exact: true,
  });
  await expect(overview).toContainText("全局已列候选涉及 5 个位置配对");
  await overview.getByText("按文稿对查看已列候选", { exact: true }).click();
  await expect(
    overview
      .getByRole("list", { name: "文稿对候选概览", exact: true })
      .getByRole("listitem"),
  ).toHaveCount(3);
  await overview
    .getByRole("button", { name: "只显示文稿对 d2 / d3", exact: true })
    .click();
  const list = page.getByRole("list", {
    name: "重复段落候选清单",
    exact: true,
  });
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(list).toContainText("近似候选 n:f1:f2");
  await page
    .getByRole("button", { name: "只读核对 n:f1:f2", exact: true })
    .click();
  const left = page.getByLabel("左侧原始段落位置", { exact: true }),
    right = page.getByLabel("右侧原始段落位置", { exact: true });
  await expect(left.locator("option")).toHaveCount(1);
  await expect(right.locator("option")).toHaveCount(1);
  await expect(left.locator("option")).toContainText("d3");
  await expect(right.locator("option")).toContainText("d2");
  await page
    .getByLabel("标记 n:f1:f2", { exact: true })
    .selectOption("intentional");
  await expect(
    overview.getByRole("list", { name: "文稿对候选概览", exact: true }),
  ).toContainText("有意重复 1 项");
  await page
    .getByRole("button", { name: "准备当前无正文报告", exact: true })
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "报告已准备：2 项，尚未核对 1 项" }),
  ).toBeVisible();
  await overview
    .getByRole("button", { name: "取消文稿对限定", exact: true })
    .click();
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(page.getByLabel("标记 n:f1:f2", { exact: true })).toHaveValue(
    "intentional",
  );
  await overview.getByLabel("概览涉及文稿", { exact: true }).selectOption("d3");
  await expect(
    overview
      .getByRole("list", { name: "文稿对候选概览", exact: true })
      .getByRole("listitem"),
  ).toHaveCount(2);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
