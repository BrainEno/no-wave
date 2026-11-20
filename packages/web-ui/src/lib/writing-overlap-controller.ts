import {
  COLLECTION_BYTE_LIMIT,
  openWritingCollection,
  type OpenedCollection,
} from "./writing-collection.ts";
import { readCollectionFile } from "./writing-collection-browser.ts";
import { analyzeWritingOverlap } from "./writing-overlap.ts";
import {
  DEFAULT_OVERLAP_POLICY,
  overlapFindings,
  validateOverlapPolicy,
  type OverlapAnalysis,
  type OverlapPolicy,
  type OverlapProgress,
} from "./writing-overlap-model.ts";
import {
  overlapMarksKey,
  resolveOverlapPair,
  validateOverlapMarks,
  type OverlapMark,
} from "./writing-overlap-review.ts";
import {
  prepareOverlapReport,
  type PreparedOverlapReport,
} from "./writing-overlap-report.ts";

import {
  explainWritingOverlap,
  type OverlapEvidence,
} from "./writing-overlap-evidence.ts";

export type OverlapWorkbenchState = {
  input: {
    status: "idle" | "reading" | "checking" | "ready" | "failed";
    name: string;
    percent: number;
    source: "single" | "collection" | null;
    documents: { key: string; title: string; locale: string }[];
  };
  policy: OverlapPolicy;
  status: "idle" | "running" | "complete" | "cancelled" | "failed";
  progress: OverlapProgress | null;
  analysis: OverlapAnalysis | null;
  evidence: {
    finding: string;
    left: string;
    right: string;
    status: "running" | "complete" | "failed";
    value: OverlapEvidence | null;
    error: string;
  } | null;
  marks: OverlapMark[];
  report: PreparedOverlapReport | null;
  reportConfirmed: boolean;
  error: string;
};
export type OverlapWorkbenchOptions = {
  read?: (
    file: File,
    signal: AbortSignal,
    progress: (percent: number) => void,
  ) => Promise<string>;
  open?: (text: string, signal: AbortSignal) => Promise<OpenedCollection>;
  analyze?: typeof analyzeWritingOverlap;
  explain?: typeof explainWritingOverlap;
  pause?: () => Promise<void>;
  now?: () => Date;
};
const emptyInput = (): OverlapWorkbenchState["input"] => ({
  status: "idle",
  name: "",
  percent: 0,
  source: null,
  documents: [],
});
const emptyDerived = () => ({
  status: "idle" as const,
  progress: null,
  analysis: null,
  evidence: null,
  marks: [],
  report: null,
  reportConfirmed: false,
  error: "",
});
const emptyState = (): OverlapWorkbenchState => ({
  ...emptyDerived(),
  input: emptyInput(),
  policy: { ...DEFAULT_OVERLAP_POLICY },
});

/** Owns one explicit local file. No requests, account authority, storage, editor writes or queued work. */
export class WritingOverlapWorkbench {
  private state = emptyState();
  private opened: OpenedCollection | null = null;
  private reading: AbortController | null = null;
  private operation: AbortController | null = null;
  private explaining: AbortController | null = null;
  private reportAnalysis: OverlapAnalysis | null = null;
  private listeners = new Set<() => void>();
  private options: Required<OverlapWorkbenchOptions>;
  constructor(options: OverlapWorkbenchOptions = {}) {
    this.options = {
      read: options.read ?? readCollectionFile,
      open: options.open ?? openWritingCollection,
      analyze: options.analyze ?? analyzeWritingOverlap,
      explain: options.explain ?? explainWritingOverlap,
      pause:
        options.pause ??
        (() => new Promise((resolve) => setTimeout(resolve, 0))),
      now: options.now ?? (() => new Date()),
    };
  }
  getSnapshot = (): OverlapWorkbenchState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(patch: Partial<OverlapWorkbenchState>): void {
    const next = { ...this.state, ...patch };
    for (const mark of next.marks) Object.freeze(mark);
    for (const document of next.input.documents) Object.freeze(document);
    Object.freeze(next.marks);
    Object.freeze(next.input.documents);
    Object.freeze(next.input);
    Object.freeze(next.policy);
    if (next.progress) Object.freeze(next.progress);
    if (next.evidence) Object.freeze(next.evidence);
    this.state = Object.freeze(next);
    for (const listener of this.listeners) listener();
  }
  private fail(error: unknown): false {
    this.publish({
      error:
        error instanceof Error
          ? error.message
          : "本机段落操作失败，没有修改文稿。",
    });
    return false;
  }
  private abortAnalysis(): void {
    this.operation?.abort();
    this.operation = null;
    this.explaining?.abort();
    this.explaining = null;
    this.reportAnalysis = null;
  }
  clear(): void {
    this.reading?.abort();
    this.reading = null;
    this.abortAnalysis();
    this.opened = null;
    this.publish(emptyState());
  }
  cancel(): void {
    this.reading?.abort();
    this.reading = null;
    this.abortAnalysis();
    this.publish({
      ...emptyDerived(),
      status: "cancelled",
      input: this.opened ? this.state.input : emptyInput(),
    });
  }
  async load(file: File): Promise<void> {
    this.reading?.abort();
    this.abortAnalysis();
    this.opened = null;
    const abort = new AbortController();
    this.reading = abort;
    const current = () => this.reading === abort && !abort.signal.aborted;
    if (
      !Number.isSafeInteger(file.size) ||
      file.size < 1 ||
      file.size > COLLECTION_BYTE_LIMIT
    ) {
      this.publish({
        ...emptyDerived(),
        input: { ...emptyInput(), status: "failed" },
        error: "文件须大于 0 且不超过 16 MiB，未读取文件。",
      });
      if (this.reading === abort) this.reading = null;
      return;
    }
    const name = Array.from(
      file.name.replace(
        /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu,
        "",
      ),
    )
      .slice(0, 240)
      .join("");
    this.publish({
      ...emptyDerived(),
      input: { ...emptyInput(), status: "reading", name },
    });
    try {
      if (!current()) return;
      const text = await this.options.read(file, abort.signal, (value) => {
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
          error:
            error instanceof Error
              ? error.message
              : "文件校验失败，未接纳任何文稿。",
        });
      }
    } finally {
      if (this.reading === abort) this.reading = null;
    }
  }
  setPolicy(raw: OverlapPolicy): boolean {
    try {
      const policy = validateOverlapPolicy(raw);
      if (JSON.stringify(policy) === JSON.stringify(this.state.policy))
        return true;
      this.abortAnalysis();
      this.publish({ ...emptyDerived(), policy });
      return true;
    } catch (error) {
      return this.fail(error);
    }
  }
  async analyze(): Promise<void> {
    this.abortAnalysis();
    const source = this.opened,
      policy = { ...this.state.policy };
    if (!source || this.state.input.status !== "ready") {
      this.publish({
        ...emptyDerived(),
        error: "请先明确选择并完整校验一份本机备份或集合。",
      });
      return;
    }
    const abort = new AbortController();
    this.operation = abort;
    const current = () =>
      this.operation === abort &&
      !abort.signal.aborted &&
      this.opened === source;
    this.publish({ ...emptyDerived(), status: "running" });
    try {
      if (!current()) return;
      const result = await this.options.analyze(source, policy, abort.signal, {
        pause: this.options.pause,
        progress: (progress) => {
          if (current()) this.publish({ progress: { ...progress } });
        },
      });
      if (!current()) return;
      if (
        result.sourceKey !== source.prepared.collection.digest ||
        JSON.stringify(result.policy) !== JSON.stringify(policy)
      )
        throw new Error("计算结果与当前来源或条件不符，未接纳旧分析。");
      this.publish({ analysis: result, status: "complete", progress: null });
    } catch (error) {
      if (current())
        this.publish({
          ...emptyDerived(),
          status: "failed",
          error:
            error instanceof Error
              ? error.message
              : "段落分析失败，未保留部分结果。",
        });
    } finally {
      if (this.operation === abort) this.operation = null;
    }
  }
  private requireAnalysis(expected: OverlapAnalysis | null): OverlapAnalysis {
    const analysis = this.state.analysis;
    if (
      !analysis ||
      analysis !== expected ||
      this.state.status !== "complete" ||
      this.state.input.status !== "ready" ||
      analysis.sourceKey !== this.opened?.prepared.collection.digest ||
      JSON.stringify(analysis.policy) !== JSON.stringify(this.state.policy)
    )
      throw new Error("段落审阅已经变化，请重新分析当前来源与条件。");
    return analysis;
  }
  setMarks(
    expected: OverlapAnalysis | null,
    raw: readonly OverlapMark[],
  ): boolean {
    try {
      const analysis = this.requireAnalysis(expected),
        marks = validateOverlapMarks(analysis, raw);
      if (
        overlapMarksKey(analysis, marks) ===
        overlapMarksKey(analysis, this.state.marks)
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
    expected: OverlapAnalysis | null,
    id: string,
    verdict: OverlapMark["verdict"] | null,
  ): boolean {
    try {
      const analysis = this.requireAnalysis(expected);
      if (!overlapFindings(analysis).some((item) => item.id === id))
        throw new Error("该审阅项目已经失效，未应用标记。");
      const marks = this.state.marks.filter((mark) => mark.finding !== id);
      if (verdict !== null) marks.push({ finding: id, verdict });
      return this.setMarks(analysis, marks);
    } catch (error) {
      return this.fail(error);
    }
  }
  pair(
    expected: OverlapAnalysis | null,
    id: string,
    left: string,
    right: string,
  ) {
    return resolveOverlapPair(this.requireAnalysis(expected), id, left, right);
  }
  cancelEvidence(
    expected: OverlapAnalysis | null,
    finding: string,
    left: string,
    right: string,
  ): void {
    const evidence = this.state.evidence;
    if (
      this.state.analysis !== expected ||
      !evidence ||
      evidence.finding !== finding ||
      evidence.left !== left ||
      evidence.right !== right
    )
      return;
    this.explaining?.abort();
    this.explaining = null;
    this.publish({ evidence: null });
  }
  async explainPair(
    expected: OverlapAnalysis | null,
    finding: string,
    left: string,
    right: string,
  ): Promise<void> {
    let analysis: OverlapAnalysis;
    try {
      analysis = this.requireAnalysis(expected);
      resolveOverlapPair(analysis, finding, left, right);
    } catch (error) {
      this.fail(error);
      return;
    }
    this.explaining?.abort();
    const abort = new AbortController();
    this.explaining = abort;
    const current = () =>
      this.explaining === abort &&
      !abort.signal.aborted &&
      this.state.analysis === analysis;
    const pair = { finding, left, right };
    this.publish({
      evidence: { ...pair, status: "running", value: null, error: "" },
    });
    try {
      if (!current()) return;
      const value = await this.options.explain(
        analysis,
        finding,
        left,
        right,
        abort.signal,
        this.options.pause,
      );
      if (!current()) return;
      if (
        value.sourceKey !== analysis.sourceKey ||
        value.finding !== finding ||
        value.leftId !== left ||
        value.rightId !== right ||
        value.mode !== analysis.policy.mode
      ) {
        throw new Error("片段解释与当前来源、条件或位置不符，未展示旧片段。");
      }
      this.publish({
        evidence: { ...pair, status: "complete", value, error: "" },
      });
    } catch (error) {
      if (current())
        this.publish({
          evidence: {
            ...pair,
            status: "failed",
            value: null,
            error:
              error instanceof Error
                ? error.message
                : "片段解释失败，没有交付部分内容。",
          },
        });
    } finally {
      if (this.explaining === abort) this.explaining = null;
    }
  }
  prepareReport(expected: OverlapAnalysis | null): void {
    try {
      const analysis = this.requireAnalysis(expected);
      const report = prepareOverlapReport(
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
  confirmReport(
    expected: PreparedOverlapReport | null,
    value: boolean,
  ): boolean {
    try {
      if (
        !expected ||
        this.state.report !== expected ||
        this.reportAnalysis !== this.state.analysis ||
        typeof value !== "boolean"
      )
        throw new Error("报告预览已经变化，请重新准备并核对。");
      this.requireAnalysis(this.reportAnalysis);
      this.publish({ reportConfirmed: value, error: "" });
      return true;
    } catch (error) {
      return this.fail(error);
    }
  }
  permitsReport(expected: PreparedOverlapReport | null): boolean {
    try {
      const analysis = this.requireAnalysis(this.reportAnalysis);
      return (
        !!expected &&
        expected === this.state.report &&
        this.state.reportConfirmed &&
        expected.sourceKey === analysis.sourceKey &&
        expected.marksKey === overlapMarksKey(analysis, this.state.marks)
      );
    } catch {
      return false;
    }
  }
  reportDownload(expected: PreparedOverlapReport | null) {
    if (!this.permitsReport(expected))
      throw new Error("报告或下载确认已经失效，没有下载旧的审阅结果。");
    return expected!.artifact;
  }
}
