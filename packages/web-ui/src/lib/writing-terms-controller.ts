import {
  COLLECTION_BYTE_LIMIT,
  collectionChecksum,
  openWritingCollection,
  type OpenedCollection,
} from "./writing-collection.ts";
import {
  readCollectionFile,
  readLocalFileBytes,
} from "./writing-collection-browser.ts";
import { analyzeWritingTerms } from "./writing-terms.ts";
import {
  DEFAULT_TERMS_POLICY,
  type TermsAnalysis,
  type TermsOptions,
  type TermsPolicy,
  type TermsRecipe,
} from "./writing-terms-model.ts";
import {
  parseTermsRecipe,
  TERMS_RECIPE_BYTES,
  validateTermsPolicy,
} from "./writing-terms-recipe.ts";
import { termsInventory } from "./writing-terms-index.ts";
import {
  resolveTermsRow,
  termsMarksKey,
  validateTermsMarks,
  type TermsMark,
  type TermsRow,
} from "./writing-terms-review.ts";
import {
  prepareTermsReport,
  type PreparedTermsReport,
} from "./writing-terms-report.ts";

export type TermsWorkbenchState = {
  input: {
    status: "idle" | "reading" | "checking" | "ready" | "failed";
    name: string;
    percent: number;
    source: "single" | "collection" | null;
    documents: { key: string; title: string; locale: string }[];
  };
  recipe: {
    status: "idle" | "reading" | "ready" | "invalid";
    text: string;
    name: string;
    percent: number;
  };
  policy: TermsPolicy;
  status: "idle" | "running" | "complete" | "cancelled" | "failed";
  progress: {
    stage: "source" | "catalog" | "scan";
    done: number;
    total: number;
  } | null;
  analysis: TermsAnalysis | null;
  marks: TermsMark[];
  report: PreparedTermsReport | null;
  reportConfirmed: boolean;
  error: string;
};
export type TermsWorkbenchOptions = {
  read?: (
    file: File,
    signal: AbortSignal,
    progress: (percent: number) => void,
  ) => Promise<string>;
  readRecipe?: (
    file: File,
    signal: AbortSignal,
    progress: (percent: number) => void,
  ) => Promise<string>;
  open?: typeof openWritingCollection;
  analyze?: typeof analyzeWritingTerms;
  pause?: () => Promise<void>;
  now?: () => Date;
};
const emptyInput = (): TermsWorkbenchState["input"] => ({
  status: "idle",
  name: "",
  percent: 0,
  source: null,
  documents: [],
});
const emptyRecipe = (): TermsWorkbenchState["recipe"] => ({
  status: "idle",
  text: "",
  name: "",
  percent: 0,
});
const emptyDerived = () => ({
  status: "idle" as const,
  progress: null,
  analysis: null,
  marks: [],
  report: null,
  reportConfirmed: false,
  error: "",
});
const emptyState = (): TermsWorkbenchState => ({
  ...emptyDerived(),
  input: emptyInput(),
  recipe: emptyRecipe(),
  policy: { ...DEFAULT_TERMS_POLICY },
});
const fileName = (name: string) =>
  [...name.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, "")]
    .slice(0, 240)
    .join("");
const percent = (value: number) =>
  Number.isFinite(value) ? Math.max(0, Math.min(100, Math.floor(value))) : 0;
const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "本机术语操作失败，没有修改或上传任何文稿。";
async function readRecipeFile(
  file: File,
  signal: AbortSignal,
  progress: (value: number) => void,
): Promise<string> {
  const bytes = await readLocalFileBytes(
    file,
    signal,
    progress,
    undefined,
    TERMS_RECIPE_BYTES,
  );
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("词表须为完整有效 UTF-8；未以替换字符修复词条。");
  } finally {
    bytes.fill(0);
  }
}

/** Owns two explicit local inputs. No ambient files, persistence, requests, editor writes or automatic exports. */
export class WritingTermsWorkbench {
  private state = emptyState();
  private opened: OpenedCollection | null = null;
  private recipeValue: TermsRecipe | null = null;
  private sourceRead: AbortController | null = null;
  private recipeRead: AbortController | null = null;
  private operation: AbortController | null = null;
  private reportAnalysis: TermsAnalysis | null = null;
  private listeners = new Set<() => void>();
  private options: Required<TermsWorkbenchOptions>;
  constructor(options: TermsWorkbenchOptions = {}) {
    this.options = {
      read: options.read ?? readCollectionFile,
      readRecipe: options.readRecipe ?? readRecipeFile,
      open: options.open ?? openWritingCollection,
      analyze: options.analyze ?? analyzeWritingTerms,
      pause:
        options.pause ??
        (() => new Promise((resolve) => setTimeout(resolve, 0))),
      now: options.now ?? (() => new Date()),
    };
    this.publish({});
  }
  getSnapshot = (): TermsWorkbenchState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(patch: Partial<TermsWorkbenchState>): void {
    const next = { ...this.state, ...patch };
    for (const mark of next.marks) Object.freeze(mark);
    for (const document of next.input.documents) Object.freeze(document);
    Object.freeze(next.marks);
    Object.freeze(next.input.documents);
    Object.freeze(next.input);
    Object.freeze(next.recipe);
    Object.freeze(next.policy);
    if (next.progress) Object.freeze(next.progress);
    this.state = Object.freeze(next);
    for (const listener of this.listeners) listener();
  }
  private abortAnalysis(): void {
    this.operation?.abort();
    this.operation = null;
    this.reportAnalysis = null;
  }
  private fail(error: unknown): false {
    this.publish({ error: message(error) });
    return false;
  }
  clear(): void {
    this.sourceRead?.abort();
    this.sourceRead = null;
    this.recipeRead?.abort();
    this.recipeRead = null;
    this.abortAnalysis();
    this.opened = null;
    this.recipeValue = null;
    this.publish(emptyState());
  }
  cancel(): void {
    this.sourceRead?.abort();
    this.sourceRead = null;
    this.recipeRead?.abort();
    this.recipeRead = null;
    this.abortAnalysis();
    this.publish({
      ...emptyDerived(),
      status: "cancelled",
      input: this.opened ? this.state.input : emptyInput(),
      recipe:
        this.state.recipe.status === "reading"
          ? emptyRecipe()
          : this.state.recipe,
    });
  }
  async load(file: File): Promise<void> {
    this.sourceRead?.abort();
    this.abortAnalysis();
    this.opened = null;
    const abort = new AbortController();
    this.sourceRead = abort;
    const current = () => this.sourceRead === abort && !abort.signal.aborted;
    if (
      !Number.isSafeInteger(file.size) ||
      file.size < 1 ||
      file.size > COLLECTION_BYTE_LIMIT
    ) {
      this.sourceRead = null;
      this.publish({
        ...emptyDerived(),
        input: { ...emptyInput(), status: "failed" },
        error: "来源文件须大于 0 且不超过 16 MiB，未读取文件。",
      });
      return;
    }
    this.publish({
      ...emptyDerived(),
      input: { ...emptyInput(), status: "reading", name: fileName(file.name) },
    });
    try {
      if (!current()) return;
      const text = await this.options.read(file, abort.signal, (value) => {
        if (current())
          this.publish({
            input: { ...this.state.input, percent: percent(value) },
          });
      });
      if (!current()) return;
      this.publish({
        input: { ...this.state.input, status: "checking", percent: 100 },
      });
      if (!current()) return;
      const opened = await this.options.open(text, abort.signal);
      if (!current()) return;
      this.opened = opened;
      this.publish({
        input: {
          ...this.state.input,
          status: "ready",
          source: opened.source,
          documents: opened.prepared.collection.entries.map((entry) => ({
            key: entry.key,
            title: entry.backup.draft.title,
            locale: entry.backup.draft.locale,
          })),
        },
      });
    } catch (error) {
      if (current()) {
        this.opened = null;
        this.publish({
          input: { ...emptyInput(), status: "failed" },
          error: message(error),
        });
      }
    } finally {
      if (this.sourceRead === abort) this.sourceRead = null;
    }
  }
  async loadRecipe(file: File): Promise<void> {
    this.recipeRead?.abort();
    this.abortAnalysis();
    this.recipeValue = null;
    const abort = new AbortController();
    this.recipeRead = abort;
    const current = () => this.recipeRead === abort && !abort.signal.aborted;
    if (
      !Number.isSafeInteger(file.size) ||
      file.size < 1 ||
      file.size > TERMS_RECIPE_BYTES
    ) {
      this.recipeRead = null;
      this.publish({
        ...emptyDerived(),
        recipe: { ...emptyRecipe(), status: "invalid" },
        error: "词表文件须大于 0 且不超过 128 KiB，未读取文件。",
      });
      return;
    }
    this.publish({
      ...emptyDerived(),
      recipe: {
        ...emptyRecipe(),
        status: "reading",
        name: fileName(file.name),
      },
    });
    try {
      if (!current()) return;
      const text = await this.options.readRecipe(
        file,
        abort.signal,
        (value) => {
          if (current())
            this.publish({
              recipe: { ...this.state.recipe, percent: percent(value) },
            });
        },
      );
      if (!current()) return;
      const recipe = parseTermsRecipe(text);
      this.recipeValue = recipe;
      this.publish({
        recipe: { ...this.state.recipe, status: "ready", text, percent: 100 },
        error: "",
      });
    } catch (error) {
      if (current()) {
        this.recipeValue = null;
        this.publish({
          recipe: { ...emptyRecipe(), status: "invalid" },
          error: message(error),
        });
      }
    } finally {
      if (this.recipeRead === abort) this.recipeRead = null;
    }
  }
  setRecipeText(text: string): boolean {
    this.recipeRead?.abort();
    this.recipeRead = null;
    this.abortAnalysis();
    this.recipeValue = null;
    let bounded = "";
    try {
      if (
        typeof text !== "string" ||
        text.length > TERMS_RECIPE_BYTES ||
        new TextEncoder().encode(text).byteLength > TERMS_RECIPE_BYTES
      )
        throw new Error("词表草稿超过 128 KiB，已清除旧分析且未保留超限输入。");
      bounded = text;
      const recipe = parseTermsRecipe(text);
      this.recipeValue = recipe;
      this.publish({
        ...emptyDerived(),
        recipe: { ...emptyRecipe(), status: "ready", text },
      });
      return true;
    } catch (error) {
      this.publish({
        ...emptyDerived(),
        recipe: {
          ...emptyRecipe(),
          status: text ? "invalid" : "idle",
          text: bounded,
        },
        error: text ? message(error) : "",
      });
      return false;
    }
  }
  setPolicy(raw: TermsPolicy): boolean {
    try {
      const policy = validateTermsPolicy(raw);
      if (JSON.stringify(policy) === JSON.stringify(this.state.policy))
        return true;
      this.abortAnalysis();
      this.publish({ ...emptyDerived(), policy });
      return true;
    } catch (error) {
      this.abortAnalysis();
      this.publish({ ...emptyDerived(), error: message(error) });
      return false;
    }
  }
  async analyze(): Promise<void> {
    this.abortAnalysis();
    const source = this.opened,
      recipe = this.recipeValue,
      policy = this.state.policy;
    if (
      !source ||
      !recipe ||
      this.state.input.status !== "ready" ||
      this.state.recipe.status !== "ready"
    ) {
      this.publish({
        ...emptyDerived(),
        error: "请先明确选择完整校验的来源，并输入或导入有效词表。",
      });
      return;
    }
    const abort = new AbortController();
    this.operation = abort;
    const current = () =>
      this.operation === abort &&
      !abort.signal.aborted &&
      this.opened === source &&
      this.recipeValue === recipe &&
      this.state.policy === policy;
    this.publish({ ...emptyDerived(), status: "running" });
    const progress: NonNullable<TermsOptions["progress"]> = (
      stage,
      done,
      total,
    ) => {
      if (current()) this.publish({ progress: { stage, done, total } });
    };
    try {
      if (!current()) return;
      const result = await this.options.analyze(
        source,
        recipe,
        policy,
        abort.signal,
        { pause: this.options.pause, progress },
      );
      if (!current()) return;
      const recipeKey = await collectionChecksum(recipe, abort.signal);
      if (!current()) return;
      if (
        result.sourceKey !== source.prepared.collection.digest ||
        result.recipeKey !== recipeKey ||
        JSON.stringify(result.recipe) !== JSON.stringify(recipe) ||
        JSON.stringify(result.policy) !== JSON.stringify(policy)
      )
        throw new Error("分析与当前来源、词表或条件不符，未接纳旧结果。");
      termsInventory(result);
      this.publish({ analysis: result, status: "complete", progress: null });
    } catch (error) {
      if (current())
        this.publish({
          ...emptyDerived(),
          status: "failed",
          error: message(error),
        });
    } finally {
      if (this.operation === abort) this.operation = null;
    }
  }
  private requireAnalysis(expected: TermsAnalysis | null): TermsAnalysis {
    const analysis = this.state.analysis;
    if (
      !analysis ||
      analysis !== expected ||
      this.state.status !== "complete" ||
      this.state.input.status !== "ready" ||
      this.state.recipe.status !== "ready" ||
      analysis.sourceKey !== this.opened?.prepared.collection.digest ||
      JSON.stringify(analysis.recipe) !== JSON.stringify(this.recipeValue) ||
      JSON.stringify(analysis.policy) !== JSON.stringify(this.state.policy)
    )
      throw new Error("术语分析已经变化，请重新分析当前来源、词表和条件。");
    return analysis;
  }
  setMarks(expected: TermsAnalysis | null, raw: readonly TermsMark[]): boolean {
    try {
      const analysis = this.requireAnalysis(expected),
        marks = validateTermsMarks(analysis, raw);
      if (
        termsMarksKey(analysis, marks) ===
        termsMarksKey(analysis, this.state.marks)
      )
        return true;
      this.reportAnalysis = null;
      this.publish({ marks, report: null, reportConfirmed: false, error: "" });
      return true;
    } catch (error) {
      return this.fail(error);
    }
  }
  mark(
    expected: TermsAnalysis | null,
    id: string,
    verdict: TermsMark["verdict"] | null,
  ): boolean {
    try {
      const analysis = this.requireAnalysis(expected);
      if (!termsInventory(analysis).matches.has(id))
        throw new Error("术语命中已经失效，没有标记其他位置。");
      const marks = this.state.marks.filter((mark) => mark.match !== id);
      if (verdict !== null) marks.push({ match: id, verdict });
      return this.setMarks(analysis, marks);
    } catch (error) {
      return this.fail(error);
    }
  }
  row(row: TermsRow): TermsRow {
    return resolveTermsRow(this.requireAnalysis(row.witness), row);
  }
  prepareReport(expected: TermsAnalysis | null): void {
    try {
      const analysis = this.requireAnalysis(expected),
        report = prepareTermsReport(
          analysis,
          this.state.marks,
          this.options.now(),
        );
      this.reportAnalysis = analysis;
      this.publish({ report, reportConfirmed: false, error: "" });
    } catch (error) {
      this.fail(error);
    }
  }
  confirmReport(expected: PreparedTermsReport | null, value: boolean): boolean {
    try {
      if (
        !expected ||
        expected !== this.state.report ||
        this.reportAnalysis !== this.state.analysis ||
        typeof value !== "boolean"
      )
        throw new Error("报告预览已变化，请重新准备并核对。");
      this.requireAnalysis(this.reportAnalysis);
      this.publish({ reportConfirmed: value, error: "" });
      return true;
    } catch (error) {
      return this.fail(error);
    }
  }
  permitsReport(expected: PreparedTermsReport | null): boolean {
    try {
      const analysis = this.requireAnalysis(this.reportAnalysis);
      return (
        !!expected &&
        expected === this.state.report &&
        this.state.reportConfirmed &&
        expected.sourceKey === analysis.sourceKey &&
        expected.recipeKey === analysis.recipeKey &&
        expected.marksKey === termsMarksKey(analysis, this.state.marks)
      );
    } catch {
      return false;
    }
  }
  reportDownload(expected: PreparedTermsReport | null) {
    if (!this.permitsReport(expected))
      throw new Error("术语报告或确认已失效，没有下载旧结果。");
    return expected!.artifact;
  }
}
