import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import {
  createWritingBackup,
  parseWritingBackup,
} from "../packages/web-ui/src/lib/writing-backup.ts";
import type { WritingDraft } from "../packages/web-ui/src/lib/writing-session.ts";
import { test } from "./support/article-view-stack.ts";

const stamp = new Date("2026-11-12T00:00:00.000Z");
const roles = ["共同基线", "当前稿", "另一稿"] as const;
function draft(
  texts: string[],
  extra: Partial<WritingDraft> = {},
): WritingDraft {
  return {
    title: "PRIVATE_TITLE",
    summary: "PRIVATE_SUMMARY",
    locale: "zh-CN",
    workType: "other",
    editorState: {
      root: {
        type: "root",
        version: 1,
        children: texts.map((text) => ({
          type: "paragraph",
          version: 1,
          children: [{ type: "text", version: 1, text }],
        })),
      },
    },
    ...extra,
  };
}
const serialize = (value: WritingDraft, now = stamp) =>
  createWritingBackup(value, now);
async function start(page: Page) {
  await page.goto(
    "/write/merge?base=https%3A%2F%2Fprivate-merge.example.test%2FNEVER_READ.json",
  );
  await expect(page).toHaveURL(/\/write\/merge$/);
  await expect(
    page.getByRole("heading", { name: "本机三方文稿合并", exact: true }),
  ).toBeVisible();
}
async function load(
  page: Page,
  role: (typeof roles)[number],
  text: string | Buffer,
  name = "local.json",
) {
  await page.getByLabel(`${role}单篇文稿文件`, { exact: true }).setInputFiles({
    name,
    mimeType: "application/json",
    buffer: typeof text === "string" ? Buffer.from(text) : text,
  });
  await expect(
    page
      .getByRole("region", { name: `${role}来源`, exact: true })
      .getByRole("status"),
  ).toContainText("结构校验通过");
}
async function analyze(page: Page, values: WritingDraft[]) {
  for (const [index, role] of roles.entries())
    await load(page, role, serialize(values[index]!));
  await page
    .getByRole("checkbox", {
      name: "我已核对角色，确认共同基线是两份改稿的共同起点",
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "分析三份本机文稿", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "三方逐项审阅", exact: true }),
  ).toBeVisible();
}
async function prepare(page: Page) {
  await page
    .getByRole("button", { name: "校验并准备合并结果", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "已校验的三方合并结果", exact: true }),
  ).toBeVisible();
}
async function download(page: Page, label: string) {
  const event = page.waitForEvent("download");
  await page.getByRole("button", { name: label, exact: true }).click();
  const artifact = await event;
  return {
    name: artifact.suggestedFilename(),
    text: await readFile((await artifact.path())!, "utf8"),
  };
}

test("an anonymous offline merge preserves disjoint exact content and never requests embedded media or writes storage", async ({
  page,
  context,
}) => {
  const forbidden: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() !== "GET" ||
      new URL(request.url()).hostname === "private-merge.example.test"
    )
      forbidden.push(request.url());
  });
  await start(page);
  await page.evaluate(() => document.fonts.ready);
  await context.setOffline(true);
  const base = draft(["PRIVATE_ONE", "PRIVATE_TWO", "PRIVATE_THREE"]);
  base.editorState!.root.children.push({
    type: "image",
    version: 1,
    src: "https://private-merge.example.test/NEVER_FETCH.png",
    alt: "PRIVATE_ALT",
  });
  const current = structuredClone(base),
    incoming = structuredClone(base);
  current.title = "PRIVATE_CURRENT_TITLE";
  current.editorState!.root.children[0]!.children = [
    { type: "text", version: 1, text: "PRIVATE_CURRENT_ONE", format: 1 },
  ];
  incoming.summary = "PRIVATE_INCOMING_SUMMARY";
  incoming.editorState!.root.children[2]!.children = [
    { type: "text", version: 1, text: "PRIVATE_INCOMING_THREE" },
  ];
  await analyze(page, [base, current, incoming]);
  await prepare(page);
  await page
    .getByRole("checkbox", {
      name: "我已核对输出，理解下载文件含未加密的私密文稿",
      exact: true,
    })
    .check();
  const saved = await download(page, "下载新的合并文稿 JSON");
  const expected = structuredClone(current);
  expected.summary = incoming.summary;
  expected.editorState!.root.children[2] =
    incoming.editorState!.root.children[2]!;
  expect(parseWritingBackup(saved.text).draft).toEqual(expected);
  expect(saved.name).toMatch(/\.json$/);
  expect(forbidden).toEqual([]);
  expect(await page.locator("[contenteditable='true']").count()).toBe(0);
  expect(
    await page.evaluate(() =>
      JSON.stringify({
        local: { ...localStorage },
        session: { ...sessionStorage },
      }),
    ),
  ).not.toContain("PRIVATE_");
  expect(
    await page.evaluate(async () =>
      (await indexedDB.databases()).map((database) => database.name),
    ),
  ).not.toContain("no-wave-writing-recovery-v1");
});

test("a conflict blocks output, an explicit choice survives filtering, and changing it invalidates the prepared download", async ({
  page,
}) => {
  await start(page);
  await analyze(page, [draft(["基线"]), draft(["当前"]), draft(["另一"])]);
  const button = page.getByRole("button", {
    name: "校验并准备合并结果",
    exact: true,
  });
  await expect(button).toBeDisabled();
  const choice = page.getByRole("radio", {
    name: "另一稿 · 基线正文第 1–1 块",
    exact: true,
  });
  await choice.check();
  await page
    .getByRole("combobox", { name: "合并审阅筛选", exact: true })
    .selectOption("unresolved");
  await expect(
    page.getByText("这个筛选下没有条目；其他条目与人工选择仍然保留。", {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "合并审阅筛选", exact: true })
    .selectOption("manual");
  await expect(choice).toBeChecked();
  await prepare(page);
  await expect(
    page.getByRole("region", { name: "已校验的三方合并结果", exact: true }),
  ).toContainText("另一");
  await expect(
    page.getByRole("button", { name: "下载新的合并文稿 JSON", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("checkbox", {
      name: "我已核对输出，理解下载文件含未加密的私密文稿",
      exact: true,
    })
    .check();
  await page.getByText("核对未采用改动与来源完整对照", { exact: true }).click();
  const impact = page.getByRole("region", {
    name: "取舍影响核对",
    exact: true,
  });
  await expect(impact).toContainText(/当前稿有 1 项已改动候选未被采用/);
  await impact
    .getByText("当前稿未采用候选 · 基线正文第 1–1 块", { exact: true })
    .click();
  await expect(
    impact.getByRole("list", { name: "未采用候选核对清单", exact: true }),
  ).toContainText('"text": "当前"');
  await impact
    .getByRole("combobox", { name: "取舍影响筛选", exact: true })
    .selectOption("overrides");
  await expect(impact).toContainText(
    "此筛选下没有需核对的候选；这不证明文意没有遗漏。",
  );
  await expect(choice).toBeChecked();
  await expect(
    page.getByRole("button", { name: "下载新的合并文稿 JSON", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("radio", { name: "当前稿 · 基线正文第 1–1 块", exact: true })
    .check();
  await expect(
    page.getByRole("region", { name: "已校验的三方合并结果", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "清除另一稿文件", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "三方逐项审阅", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("checkbox", {
      name: "我已核对角色，确认共同基线是两份改稿的共同起点",
      exact: true,
    }),
  ).not.toBeChecked();
});

test("decision-plan download contains no manuscript and preview cannot apply or retain a stale result without confirmation", async ({
  page,
}) => {
  const values = [
    draft(["PRIVATE_BASE"]),
    draft(["PRIVATE_CURRENT"]),
    draft(["PRIVATE_INCOMING"]),
  ];
  await start(page);
  await analyze(page, values);
  await page
    .getByRole("radio", { name: "当前稿 · 基线正文第 1–1 块", exact: true })
    .check();
  await page
    .getByRole("button", { name: "准备人工取舍计划", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "下载人工取舍计划", exact: true }),
  ).toBeEnabled();
  const plan = await download(page, "下载人工取舍计划");
  expect(plan.text).not.toContain("PRIVATE_");
  await page
    .getByRole("radio", { name: "另一稿 · 基线正文第 1–1 块", exact: true })
    .check();
  await prepare(page);
  await page.getByLabel("预览人工取舍计划文件", { exact: true }).setInputFiles({
    name: "plan.json",
    mimeType: "application/json",
    buffer: Buffer.from(plan.text),
  });
  const preview = page.getByRole("region", {
    name: "合并决策计划待确认预览",
    exact: true,
  });
  await expect(preview).toBeVisible();
  await expect(
    page.getByRole("radio", {
      name: "另一稿 · 基线正文第 1–1 块",
      exact: true,
    }),
  ).toBeChecked();
  await expect(
    page.getByRole("region", { name: "已校验的三方合并结果", exact: true }),
  ).toBeVisible();
  await expect(
    preview.getByRole("button", { name: "确认替换人工取舍", exact: true }),
  ).toBeDisabled();
  await preview
    .getByRole("checkbox", {
      name: "我已核对全部变更，允许用此计划完整替换人工取舍",
      exact: true,
    })
    .check();
  await preview
    .getByRole("button", { name: "确认替换人工取舍", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "已校验的三方合并结果", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("radio", {
      name: "当前稿 · 基线正文第 1–1 块",
      exact: true,
    }),
  ).toBeChecked();
  await load(
    page,
    "共同基线",
    serialize(values[0]!, new Date("2026-11-12T01:00:00.000Z")),
  );
  await page
    .getByRole("checkbox", {
      name: "我已核对角色，确认共同基线是两份改稿的共同起点",
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "分析三份本机文稿", exact: true })
    .click();
  await page.getByLabel("预览人工取舍计划文件", { exact: true }).setInputFiles({
    name: "old-plan.json",
    mimeType: "application/json",
    buffer: Buffer.from(plan.text),
  });
  await expect(page.getByRole("alert")).toContainText("来源或角色已经变化");
  await expect(preview).toHaveCount(0);
});

test("invalid UTF-8, duplicate escaped keys and oversized local files fail without admitting partial sources", async ({
  page,
}) => {
  await start(page);
  const input = page.getByLabel("共同基线单篇文稿文件", { exact: true });
  await input.setInputFiles({
    name: "bad-utf8.json",
    mimeType: "application/json",
    buffer: Buffer.from([0x7b, 0xff, 0x7d]),
  });
  await expect(page.getByRole("alert")).toContainText("UTF-8");
  const duplicate = serialize(draft(["正文"])).replace(
    '"title": "PRIVATE_TITLE"',
    '"title": "HIDDEN", "ti\\u0074le": "PRIVATE_TITLE"',
  );
  await input.setInputFiles({
    name: "duplicate.json",
    mimeType: "application/json",
    buffer: Buffer.from(duplicate),
  });
  await expect(page.getByRole("alert")).toContainText("重复或歧义");
  await input.setInputFiles({
    name: "too-large.json",
    mimeType: "application/json",
    buffer: Buffer.alloc(2 * 1024 * 1024 + 1, 32),
  });
  await expect(page.getByRole("alert")).toContainText("未启动读取");
  await expect(
    page.getByRole("checkbox", {
      name: "我已核对角色，确认共同基线是两份改稿的共同起点",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    page
      .getByRole("region", { name: "共同基线来源", exact: true })
      .getByRole("heading", { name: "PRIVATE_TITLE", exact: true }),
  ).toHaveCount(0);
});

test("a late native FileReader from a replaced source cannot resurrect old content", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = FileReader.prototype.readAsArrayBuffer;
    FileReader.prototype.readAsArrayBuffer = function (blob) {
      if (blob instanceof File && blob.name === "slow.json") {
        setTimeout(() => {
          original.call(this, blob);
          Reflect.set(window, "mergeSlowReadFinished", true);
        }, 600);
      } else original.call(this, blob);
    };
  });
  await start(page);
  await page.getByLabel("共同基线单篇文稿文件", { exact: true }).setInputFiles({
    name: "slow.json",
    mimeType: "application/json",
    buffer: Buffer.from(serialize(draft(["PRIVATE_OLD"], { title: "旧标题" }))),
  });
  await load(
    page,
    "共同基线",
    serialize(draft(["PRIVATE_NEW"], { title: "新标题" })),
    "new.json",
  );
  await page.waitForFunction(
    () => Reflect.get(window, "mergeSlowReadFinished") === true,
  );
  const source = page.getByRole("region", {
    name: "共同基线来源",
    exact: true,
  });
  await expect(
    source.getByRole("heading", { name: "新标题", exact: true }),
  ).toBeVisible();
  await expect(source).not.toContainText("旧标题");
});

test("duplicate blocks stay one whole-body conflict and choosing the base never silently appends both branches", async ({
  page,
}) => {
  await start(page);
  await analyze(page, [
    draft(["重复", "重复", "尾"]),
    draft(["当前重复", "重复", "尾"]),
    draft(["重复", "另一重复", "尾"]),
  ]);
  await expect(
    page.getByText(
      "发现重复块或块顺序变化，无法安全确定对应关系。整个正文作为一个冲突处理；不会自行对齐或同时保留两份。",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "三方逐项审阅", exact: true })
      .locator("fieldset"),
  ).toHaveCount(1);
  await page
    .getByRole("radio", { name: "共同基线 · 基线正文第 1–3 块", exact: true })
    .check();
  await prepare(page);
  await page
    .getByRole("checkbox", {
      name: "我已核对输出，理解下载文件含未加密的私密文稿",
      exact: true,
    })
    .check();
  const output = parseWritingBackup(
    (await download(page, "下载新的合并文稿 JSON")).text,
  );
  expect(output.draft.editorState).toEqual(
    draft(["重复", "重复", "尾"]).editorState,
  );
});

test("pagination and conflict navigation retain explicit hidden choices and move keyboard focus to the requested conflict", async ({
  page,
}) => {
  const base = Array.from({ length: 39 }, (_, index) => `基线${index}`);
  await start(page);
  await analyze(page, [
    draft(base),
    draft(base.map((text, index) => (index % 2 ? text : `当前${index}`))),
    draft(base.map((text, index) => (index % 2 ? text : `另一${index}`))),
  ]);
  await page.getByRole("button", { name: "下一页审阅", exact: true }).click();
  await page
    .getByRole("radio", { name: "当前稿 · 基线正文第 39–39 块", exact: true })
    .check();
  await page
    .getByRole("button", { name: "下一个未解决冲突", exact: true })
    .click();
  await expect(page.locator('[data-merge-unit="body:0:1"]')).toBeFocused();
  await page
    .getByRole("radio", { name: "另一稿 · 基线正文第 1–1 块", exact: true })
    .check();
  await page
    .getByRole("combobox", { name: "合并审阅筛选", exact: true })
    .selectOption("manual");
  await expect(
    page.getByRole("radio", {
      name: "当前稿 · 基线正文第 39–39 块",
      exact: true,
    }),
  ).toBeChecked();
  await expect(
    page.getByRole("radio", {
      name: "另一稿 · 基线正文第 1–1 块",
      exact: true,
    }),
  ).toBeChecked();
});

test("the loaded mobile merge escapes hostile text, keeps the viewport and passes accessibility checks", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await start(page);
  const title = '<img src=x onerror="alert(1)">' + "长标题".repeat(40);
  const base = draft(["<script>NEVER_EXECUTE</script>"], { title });
  await analyze(page, [
    base,
    draft(["当前修改"], { title }),
    draft(["另一修改"], { title }),
  ]);
  const review = page.getByRole("region", {
    name: "三方逐项审阅",
    exact: true,
  });
  expect(await review.locator("img,script,iframe").count()).toBe(0);
  await page
    .getByRole("radio", { name: "另一稿 · 基线正文第 1–1 块", exact: true })
    .check();
  await prepare(page);
  await page.getByText("核对未采用改动与来源完整对照", { exact: true }).click();
  await page
    .getByText("当前稿未采用候选 · 基线正文第 1–1 块", { exact: true })
    .click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("pagehide and persisted pageshow erase source and result DOM; returning never rereads files", async ({
  page,
}) => {
  await start(page);
  await analyze(page, [
    draft(["PRIVATE_BASE"]),
    draft(["PRIVATE_CURRENT"]),
    draft(["PRIVATE_INCOMING"]),
  ]);
  await page
    .getByRole("radio", { name: "当前稿 · 基线正文第 1–1 块", exact: true })
    .check();
  await prepare(page);
  await page.evaluate(() => {
    window.dispatchEvent(
      new PageTransitionEvent("pagehide", { persisted: true }),
    );
  });
  await expect(
    page.getByRole("region", { name: "本机三方文稿合并工作台", exact: true }),
  ).not.toContainText("PRIVATE_");
  await page.evaluate(() => {
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    );
  });
  await expect(
    page.getByRole("region", { name: "三方逐项审阅", exact: true }),
  ).toHaveCount(0);
  await load(page, "共同基线", serialize(draft(["PRIVATE_AGAIN"])));
  await page.getByRole("link", { name: "本机集合工具", exact: true }).click();
  await expect(page).toHaveURL(/\/write\/collections$/);
  await page.goBack();
  await expect(
    page.getByRole("region", { name: "本机三方文稿合并工作台", exact: true }),
  ).not.toContainText("PRIVATE_");
});

test("literal structure diagnostics expose changed link targets without fetching them or treating equal prose as equal content", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).hostname === "private-merge.example.test")
      requests.push(request.url());
  });
  const base = draft(["相同文字"]);
  base.editorState!.root.children[0]!.children = [
    {
      type: "link",
      version: 1,
      url: "https://private-merge.example.test/before",
      children: [{ type: "text", version: 1, text: "相同文字" }],
    },
  ];
  const current = structuredClone(base),
    incoming = structuredClone(base);
  const links = current.editorState!.root.children[0]!.children as Record<
    string,
    unknown
  >[];
  links[0]!.url = "https://private-merge.example.test/after";
  incoming.editorState!.root.children[0]!.children = [
    { type: "text", version: 1, text: "相同文字", format: 1 },
  ];
  await start(page);
  await analyze(page, [base, current, incoming]);
  await page.getByText("当前稿相对基线的结构差异", { exact: true }).click();
  const paths = page.getByRole("list", {
    name: "当前稿结构差异路径",
    exact: true,
  });
  await expect(paths).toContainText("$/0/children/0/url");
  await expect(paths).toContainText("https://private-merge.example.test/after");
  await expect(paths.locator("a,img,script")).toHaveCount(0);
  await page
    .getByRole("radio", { name: "当前稿 · 基线正文第 1–1 块", exact: true })
    .check();
  await prepare(page);
  await expect(
    page.getByRole("region", { name: "已校验的三方合并结果", exact: true }),
  ).toContainText("相同文字");
  expect(requests).toEqual([]);
});

test("valid input files whose combination exceeds the block budget produce a visible error and no result", async ({
  page,
}) => {
  const base = Array.from({ length: 199 }, (_, index) => `独立${index}`);
  await start(page);
  await analyze(page, [
    draft(base),
    draft(["新开头", ...base]),
    draft([...base, "新结尾"]),
  ]);
  await page
    .getByRole("button", { name: "校验并准备合并结果", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("200");
  await expect(
    page.getByRole("region", { name: "已校验的三方合并结果", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "下载新的合并文稿 JSON", exact: true }),
  ).toHaveCount(0);
});
