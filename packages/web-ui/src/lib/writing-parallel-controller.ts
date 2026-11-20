import {
  COLLECTION_BYTE_LIMIT,
  openWritingCollection,
  type OpenedCollection,
} from "./writing-collection.ts";
import { readCollectionFile } from "./writing-collection-browser.ts";
import { analyzeWritingParallel } from "./writing-parallel.ts";
import {
  explainParallelAlignment,
  type ParallelAlignmentExplanation,
} from "./writing-parallel-explain.ts";
import {
  DEFAULT_PARALLEL_POLICY,
  type ParallelAnalysis,
  type ParallelPolicy,
} from "./writing-parallel-model.ts";
import {
  createParallelReportArtifact,
  type PreparedParallelReport,
} from "./writing-parallel-report.ts";
import {
  validateParallelMarks,
  type ParallelReviewMark,
} from "./writing-parallel-review.ts";

export type ParallelWorkbenchState = {
  phase: "empty" | "analyzing" | "ready" | "error";
  input: {
    status: "idle" | "reading" | "checking" | "ready" | "failed";
    name: string;
    percent: number;
    documents: { id: string; title: string; locale: string }[];
    error: string | null;
  };
  collection: OpenedCollection | null;
  policy: ParallelPolicy;
  analysis: ParallelAnalysis | null;
  explanation: {
    id: string;
    status: "running" | "ready" | "failed";
    value: ParallelAlignmentExplanation | null;
    error: string;
  } | null;
  marks: Record<string, ParallelReviewMark>;
  report: PreparedParallelReport | null;
  confirmed: boolean;
  error: string | null;
  witness: string;
};

export type ParallelWorkbenchOptions = {
  read?: typeof readCollectionFile;
  open?: typeof openWritingCollection;
  analyze?: typeof analyzeWritingParallel;
  explain?: typeof explainParallelAlignment;
  pause?: () => Promise<void>;
  now?: () => Date;
};

const defaultInput = (): ParallelWorkbenchState["input"] => ({
  status: "idle",
  name: "",
  percent: 0,
  documents: [],
  error: null,
});

const initialState = (): ParallelWorkbenchState => ({
  phase: "empty",
  input: defaultInput(),
  collection: null,
  policy: { ...DEFAULT_PARALLEL_POLICY },
  analysis: null,
  explanation: null,
  marks: {},
  report: null,
  confirmed: false,
  error: null,
  witness: "empty",
});

export class WritingParallelWorkbench {
  private state: ParallelWorkbenchState = initialState();
  private readonly listeners = new Set<() => void>();
  private activeFence = 0;
  private abortController: AbortController | null = null;
  private readingController: AbortController | null = null;
  private readonly options: Required<ParallelWorkbenchOptions>;

  constructor(options: ParallelWorkbenchOptions = {}) {
    this.options = {
      read: options.read ?? readCollectionFile,
      open: options.open ?? openWritingCollection,
      analyze: options.analyze ?? analyzeWritingParallel,
      explain: options.explain ?? explainParallelAlignment,
      pause:
        options.pause ??
        (() => new Promise((resolve) => setTimeout(resolve, 0))),
      now: options.now ?? (() => new Date()),
    };
  }

  public getSnapshot = (): ParallelWorkbenchState => {
    return this.state;
  };

  public subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  public clear(): void {
    this.activeFence++;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.readingController) {
      this.readingController.abort();
      this.readingController = null;
    }
    this.state = initialState();
    this.emit();
  }

  public async setPolicy(policy: ParallelPolicy): Promise<void> {
    this.state = {
      ...this.state,
      policy,
      report: null,
    };
    this.emit();

    if (this.state.collection) {
      await this.runAnalysis(this.state.collection, policy);
    }
  }

  public setMark(
    alignmentId: string,
    mark: ParallelReviewMark | null,
    _note?: string,
  ): void {
    const nextMarks = { ...this.state.marks };
    if (mark === null) {
      delete nextMarks[alignmentId];
    } else {
      nextMarks[alignmentId] = mark;
    }
    this.state = {
      ...this.state,
      marks: nextMarks,
      report: null,
    };
    this.emit();
  }

  public setConfirmed(confirmed: boolean): void {
    this.state = {
      ...this.state,
      confirmed,
    };
    this.emit();
  }

  public async load(file: File): Promise<void> {
    this.clear();
    const readingFence = ++this.activeFence;
    const readingToken = new AbortController();
    this.readingController = readingToken;

    if (
      !Number.isSafeInteger(file.size) ||
      file.size < 1 ||
      file.size > COLLECTION_BYTE_LIMIT
    ) {
      this.state = {
        ...this.state,
        input: {
          ...defaultInput(),
          status: "failed",
          error: "来源须大于0且不超过16 MiB，未读取文件。",
        },
      };
      this.emit();
      return;
    }

    this.state = {
      ...this.state,
      input: {
        ...defaultInput(),
        status: "reading",
        name: file.name,
      },
    };
    this.emit();

    try {
      const text = await this.options.read(
        file,
        readingToken.signal,
        (percent) => {
          if (this.activeFence === readingFence) {
            this.state = {
              ...this.state,
              input: {
                ...this.state.input,
                percent: Math.round(percent),
              },
            };
            this.emit();
          }
        },
      );

      if (this.activeFence !== readingFence) return;
      this.state = {
        ...this.state,
        input: {
          ...this.state.input,
          status: "checking",
        },
      };
      this.emit();

      const opened = await this.options.open(text, readingToken.signal);
      if (this.activeFence !== readingFence) return;

      const docs = opened.prepared.collection.entries.map((e) => ({
        id: e.key,
        title: e.backup.draft.title || "",
        locale: e.backup.draft.locale,
      }));

      this.state = {
        ...this.state,
        input: {
          status: "ready",
          name: file.name,
          percent: 100,
          documents: docs,
          error: null,
        },
      };
      this.emit();

      await this.loadCollection(opened);
    } catch (err: unknown) {
      if (this.activeFence !== readingFence) return;
      this.state = {
        ...this.state,
        phase: "error",
        input: {
          ...defaultInput(),
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        },
        error: err instanceof Error ? err.message : String(err),
      };
      this.emit();
    }
  }

  public async loadCollection(collection: OpenedCollection): Promise<void> {
    const docs = collection.prepared.collection.entries.map((e) => ({
      id: e.key,
      title: e.backup.draft.title || "",
      locale: e.backup.draft.locale,
    }));

    this.state = {
      ...this.state,
      collection,
      input: {
        status: "ready",
        name: this.state.input.name || "Opened Collection",
        percent: 100,
        documents: docs,
        error: null,
      },
      analysis: null,
      marks: {},
      report: null,
      error: null,
      phase: "analyzing",
      witness: `loading:${collection.prepared.collection.digest}`,
    };
    this.emit();

    await this.runAnalysis(collection, this.state.policy);
  }

  private async runAnalysis(
    collection: OpenedCollection,
    policy: ParallelPolicy,
  ): Promise<void> {
    const currentFence = ++this.activeFence;
    if (this.abortController) {
      this.abortController.abort();
    }
    const controller = new AbortController();
    this.abortController = controller;

    try {
      const analysis = await this.options.analyze(
        collection,
        policy,
        controller.signal,
        { pause: this.options.pause },
      );
      if (this.activeFence !== currentFence) {
        // Discard stale result
        return;
      }
      this.state = {
        ...this.state,
        phase: "ready",
        analysis,
        error: null,
        witness: analysis.witness,
      };
      this.emit();
    } catch (err: unknown) {
      if (this.activeFence !== currentFence) return;
      this.state = {
        ...this.state,
        phase: "error",
        error: err instanceof Error ? err.message : String(err),
      };
      this.emit();
    }
  }

  public async explain(
    pairId: string,
    alignmentIndex: number | string,
  ): Promise<void> {
    if (!this.state.analysis) return;
    const targetPair = this.state.analysis.pairs.find((p) => p.id === pairId);
    if (!targetPair) return;

    let alignmentId = "";
    if (typeof alignmentIndex === "number") {
      alignmentId = targetPair.alignments[alignmentIndex]?.id ?? "";
    } else {
      alignmentId = alignmentIndex;
    }
    if (!alignmentId) return;

    this.state = {
      ...this.state,
      explanation: {
        id: alignmentId,
        status: "running",
        value: null,
        error: "",
      },
    };
    this.emit();

    const currentAnalysis = this.state.analysis;
    if (!currentAnalysis) return;

    try {
      const explanation = this.options.explain(
        currentAnalysis,
        alignmentId,
      );
      this.state = {
        ...this.state,
        explanation: {
          id: alignmentId,
          status: "ready",
          value: explanation,
          error: "",
        },
      };
      this.emit();
    } catch (err: unknown) {
      this.state = {
        ...this.state,
        explanation: {
          id: alignmentId,
          status: "failed",
          value: null,
          error: err instanceof Error ? err.message : String(err),
        },
      };
      this.emit();
    }
  }

  public clearExplanation(): void {
    this.state = {
      ...this.state,
      explanation: null,
    };
    this.emit();
  }

  public prepareReport(): PreparedParallelReport | null {
    if (!this.state.analysis) return null;
    try {
      validateParallelMarks(this.state.analysis, this.state.marks);
      const report = createParallelReportArtifact(
        this.state.analysis,
        this.state.marks,
        this.options.now(),
      );
      this.state = { ...this.state, report };
      this.emit();
      return report;
    } catch (err: unknown) {
      this.state = {
        ...this.state,
        error: err instanceof Error ? err.message : String(err),
      };
      this.emit();
      return null;
    }
  }

  public permitsReport(report: PreparedParallelReport | null): boolean {
    return (
      report !== null &&
      this.state.confirmed &&
      this.state.analysis !== null &&
      report.witness === this.state.analysis.witness
    );
  }

  public reportDownload(
    report: PreparedParallelReport | null,
  ): PreparedParallelReport {
    if (!this.permitsReport(report)) {
      throw new Error("请准备、核对并明确确认当前报告，旧输出无效。");
    }
    return report!;
  }
}
