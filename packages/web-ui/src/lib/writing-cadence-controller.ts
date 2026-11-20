import {
  COLLECTION_BYTE_LIMIT,
  openWritingCollection,
  type OpenedCollection,
} from "./writing-collection.ts";
import { readCollectionFile } from "./writing-collection-browser.ts";
import { analyzeWritingCadence } from "./writing-cadence.ts";
import {
  explainCadenceStack,
  type CadenceStackExplanation,
} from "./writing-cadence-explain.ts";
import {
  DEFAULT_CADENCE_POLICY,
  type CadenceAnalysis,
  type CadencePolicy,
  type CadenceProgress,
} from "./writing-cadence-model.ts";
import { cadenceInventory } from "./writing-cadence-index.ts";
import {
  cadenceMarksKey,
  resolveCadenceRow,
  validateCadenceMarks,
  type CadenceMark,
} from "./writing-cadence-review.ts";
import {
  prepareCadenceReport,
  type PreparedCadenceReport,
} from "./writing-cadence-report.ts";
import {
  displayCadenceText,
  validateCadencePolicy,
} from "./writing-cadence-symbols.ts";

export type CadenceWorkbenchState = {
  input: {
    status: "idle" | "reading" | "checking" | "ready" | "failed";
    name: string;
    percent: number;
    source: "single" | "collection" | null;
    documents: { id: string; title: string; locale: string }[];
  };
  policy: CadencePolicy | null;
  status: "idle" | "running" | "complete" | "cancelled" | "failed";
  progress: CadenceProgress | null;
  analysis: CadenceAnalysis | null;
  explanation: {
    id: string;
    focus: "start" | "end";
    status: "running" | "complete" | "failed";
    value: CadenceStackExplanation | null;
    error: string;
  } | null;
  marks: CadenceMark[];
  report: PreparedCadenceReport | null;
  confirmed: boolean;
  error: string;
};
export type CadenceWorkbenchOptions = {
  read?: typeof readCollectionFile;
  open?: typeof openWritingCollection;
  analyze?: typeof analyzeWritingCadence;
  explain?: typeof explainCadenceStack;
  pause?: () => Promise<void>;
  now?: () => Date;
};
const inputState = (): CadenceWorkbenchState["input"] => ({
  status: "idle",
  name: "",
  percent: 0,
  source: null,
  documents: [],
});
const derived = () => ({
  status: "idle" as const,
  progress: null,
  analysis: null,
  explanation: null,
  marks: [],
  report: null,
  confirmed: false,
  error: "",
});
const initial = (): CadenceWorkbenchState => ({
  ...derived(),
  input: inputState(),
  policy: { ...DEFAULT_CADENCE_POLICY },
});
const safeError = (error: unknown) =>
  error instanceof Error ? error.message : "本机分析失败；没有改动或上传文稿。";

/** Exactly one explicit local input and one analysis generation; none of this state is persisted. */
export class WritingCadenceWorkbench {
  private state = initial();
  private source: OpenedCollection | null = null;
  private reading: AbortController | null = null;
  private operation: AbortController | null = null;
  private explaining: AbortController | null = null;
  private reportWitness: CadenceAnalysis | null = null;
  private listeners = new Set<() => void>();
  private readonly options: Required<CadenceWorkbenchOptions>;
  constructor(options: CadenceWorkbenchOptions = {}) {
    this.options = {
      read: options.read ?? readCollectionFile,
      open: options.open ?? openWritingCollection,
      analyze: options.analyze ?? analyzeWritingCadence,
      explain: options.explain ?? explainCadenceStack,
      pause:
        options.pause ??
        (() => new Promise((resolve) => setTimeout(resolve, 0))),
      now: options.now ?? (() => new Date()),
    };
    this.publish({});
  }
  getSnapshot = (): CadenceWorkbenchState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(patch: Partial<CadenceWorkbenchState>): void {
    const state = { ...this.state, ...patch };
    for (const document of state.input.documents) Object.freeze(document);
    for (const mark of state.marks) Object.freeze(mark);
    Object.freeze(state.input.documents);
    Object.freeze(state.input);
    Object.freeze(state.marks);
    if (state.policy) Object.freeze(state.policy);
    if (state.progress) Object.freeze(state.progress);
    if (state.explanation) Object.freeze(state.explanation);
    this.state = Object.freeze(state);
    for (const listener of this.listeners) listener();
  }
  private invalidate(): void {
    this.operation?.abort();
    this.operation = null;
    this.explaining?.abort();
    this.explaining = null;
    this.reportWitness = null;
  }
  private fail(error: unknown): false {
    this.publish({ error: safeError(error) });
    return false;
  }
  clear(): void {
    this.reading?.abort();
    this.reading = null;
    this.invalidate();
    this.source = null;
    this.publish(initial());
  }
  cancel(): void {
    this.reading?.abort();
    this.reading = null;
    this.invalidate();
    this.publish({
      ...derived(),
      status: "cancelled",
      input: this.source ? this.state.input : inputState(),
    });
  }
  setPolicy(value: unknown): boolean {
    this.invalidate();
    try {
      this.publish({ ...derived(), policy: validateCadencePolicy(value) });
      return true;
    } catch (error) {
      this.publish({ ...derived(), policy: null, error: safeError(error) });
      return false;
    }
  }
  async load(file: File): Promise<void> {
    this.reading?.abort();
    this.invalidate();
    this.source = null;
    const token = new AbortController();
    this.reading = token;
    const current = () => this.reading === token && !token.signal.aborted;
    if (
      !Number.isSafeInteger(file.size) ||
      file.size < 1 ||
      file.size > COLLECTION_BYTE_LIMIT
    ) {
      this.reading = null;
      this.publish({
        ...derived(),
        input: { ...inputState(), status: "failed" },
        error: "来源须大于0且不超过16 MiB，未读取文件。",
      });
      return;
    }
    this.publish({
      ...derived(),
      input: {
        ...inputState(),
        status: "reading",
        name: displayCadenceText([...file.name].slice(0, 200).join("")),
      },
    });
    try {
      if (!current()) return;
      const text = await this.options.read(file, token.signal, (value) => {
        if (current())
          this.publish({
            input: {
              ...this.state.input,
              percent: Number.isFinite(value)
                ? Math.max(0, Math.min(100, Math.floor(value)))
                : 0,
            },
          });
      });
      if (!current()) return;
      this.publish({
        input: { ...this.state.input, status: "checking", percent: 100 },
      });
      if (!current()) return;
      const source = await this.options.open(text, token.signal);
      if (!current()) return;
      this.source = source;
      this.publish({
        input: {
          ...this.state.input,
          status: "ready",
          source: source.source,
          documents: source.prepared.collection.entries.map((entry) => ({
            id: entry.key,
            title: displayCadenceText(entry.backup.draft.title),
            locale: entry.backup.draft.locale,
          })),
        },
      });
    } catch (error) {
      if (current()) {
        this.source = null;
        this.publish({
          ...derived(),
          input: { ...inputState(), status: "failed" },
          error: safeError(error),
        });
      }
    } finally {
      if (this.reading === token) this.reading = null;
    }
  }
  async analyze(): Promise<void> {
    this.invalidate();
    const source = this.source,
      policy = this.state.policy;
    if (!source || !policy || this.state.input.status !== "ready") {
      this.publish({
        ...derived(),
        error: "请先明确校验本机来源并填写有效条件。",
      });
      return;
    }
    const token = new AbortController();
    this.operation = token;
    const current = () =>
      this.operation === token &&
      !token.signal.aborted &&
      this.source === source &&
      this.state.policy === policy;
    this.publish({ ...derived(), status: "running" });
    try {
      if (!current()) return;
      const result = await this.options.analyze(source, policy, token.signal, {
        pause: this.options.pause,
        progress: (value) => {
          if (current()) this.publish({ progress: { ...value } });
        },
      });
      if (!current()) return;
      cadenceInventory(result);
      if (
        result.sourceKey !== source.prepared.collection.digest ||
        JSON.stringify(result.policy) !== JSON.stringify(policy)
      )
        throw new Error("分析来源或条件与本轮不一致，未接纳旧结果。");
      this.publish({ status: "complete", progress: null, analysis: result });
    } catch (error) {
      if (current())
        this.publish({
          ...derived(),
          status: "failed",
          error: safeError(error),
        });
    } finally {
      if (this.operation === token) this.operation = null;
    }
  }
  clearExplanation(): void {
    this.explaining?.abort();
    this.explaining = null;
    if (this.state.explanation) this.publish({ explanation: null });
  }
  async explain(id: string, focus: "start" | "end" = "start"): Promise<void> {
    this.clearExplanation();
    const analysis = this.state.analysis;
    try {
      if (!analysis) throw new Error("请先完成当前分析，再明确选择解释位置。");
      resolveCadenceRow(analysis, id);
      if (focus !== "start" && focus !== "end")
        throw new Error("栈解释焦点无效。");
    } catch (error) {
      this.fail(error);
      return;
    }
    const token = new AbortController();
    this.explaining = token;
    const current = () =>
      this.explaining === token &&
      !token.signal.aborted &&
      this.state.analysis === analysis;
    this.publish({
      explanation: { id, focus, status: "running", value: null, error: "" },
      error: "",
    });
    try {
      if (!current()) return;
      const value = await this.options.explain(
        analysis,
        id,
        focus,
        token.signal,
        { pause: this.options.pause },
      );
      if (!current()) return;
      if (
        value.sourceKey !== analysis.sourceKey ||
        value.id !== id ||
        value.focus !== focus ||
        value.unit !== resolveCadenceRow(analysis, id).unit
      )
        throw new Error("栈解释来源或位置与当前请求不一致。");
      this.publish({
        explanation: { id, focus, status: "complete", value, error: "" },
      });
    } catch (error) {
      if (current())
        this.publish({
          explanation: {
            id,
            focus,
            status: "failed",
            value: null,
            error: safeError(error),
          },
        });
    } finally {
      if (this.explaining === token) this.explaining = null;
    }
  }
  mark(
    ids: readonly string[],
    state: CadenceMark["state"] | "unreviewed",
    witness = this.state.analysis,
  ): boolean {
    try {
      const analysis = this.state.analysis;
      if (
        !analysis ||
        witness !== analysis ||
        !Array.isArray(ids) ||
        !ids.length ||
        new Set(ids).size !== ids.length ||
        !["intentional", "follow-up", "unreviewed"].includes(state)
      )
        throw new Error("标记编号、来源或状态已失效，整批未接纳。");
      for (const id of ids) resolveCadenceRow(analysis, id);
      const replacing = new Set(ids),
        next = this.state.marks.filter((mark) => !replacing.has(mark.id));
      if (state !== "unreviewed")
        next.push(...ids.map((id) => ({ id, state })));
      const marks = validateCadenceMarks(analysis, next);
      this.reportWitness = null;
      this.publish({ marks, report: null, confirmed: false, error: "" });
      return true;
    } catch (error) {
      return this.fail(error);
    }
  }
  prepareReport(): boolean {
    try {
      const analysis = this.state.analysis;
      if (!analysis) throw new Error("请先完成本轮分析，未准备部分报告。");
      const report = prepareCadenceReport(
        analysis,
        this.state.marks,
        this.options.now(),
      );
      if (analysis !== this.state.analysis)
        throw new Error("来源已变化，未发布旧报告。");
      this.reportWitness = analysis;
      this.publish({ report, confirmed: false, error: "" });
      return true;
    } catch (error) {
      this.reportWitness = null;
      this.publish({ report: null, confirmed: false });
      return this.fail(error);
    }
  }
  confirmReport(value: boolean): boolean {
    if (
      typeof value !== "boolean" ||
      !this.state.report ||
      this.reportWitness !== this.state.analysis
    )
      return this.fail(new Error("报告已变化，请重新准备并核对。"));
    this.publish({ confirmed: value, error: "" });
    return true;
  }
  permitsReport(report: PreparedCadenceReport | null): boolean {
    return (
      report !== null &&
      report === this.state.report &&
      this.state.confirmed &&
      this.state.analysis !== null &&
      this.state.analysis === this.reportWitness &&
      report.sourceKey === this.state.analysis.sourceKey &&
      report.marksKey === cadenceMarksKey(this.state.analysis, this.state.marks)
    );
  }
  reportDownload(report: PreparedCadenceReport | null): PreparedCadenceReport {
    if (!this.permitsReport(report))
      throw new Error("请准备、核对并明确确认当前报告，旧输出无效。");
    return report!;
  }
}
