import {
  MAX_WRITING_BACKUP_BYTES,
  writingDownloadName,
  type WritingBackup,
} from "./writing-backup.ts";
import { readCollectionFile } from "./writing-collection-browser.ts";
import type { CollectionArtifact } from "./writing-collection-index.ts";
import {
  analyzeWritingMerge,
  assertWritingMergeActive,
  MERGE_ROLES,
  parseWritingMergeSource,
  prepareWritingMerge,
  validateWritingMergeDecisions,
  writingMergeDecisionsKey,
  type PreparedWritingMerge,
  type WritingMergeAnalysis,
  type WritingMergeChoice,
  type WritingMergeDecision,
  type WritingMergeRole,
  type WritingMergeSources,
} from "./writing-merge.ts";
import {
  createWritingMergePlan,
  MERGE_PLAN_BYTE_LIMIT,
  previewWritingMergePlan,
  type WritingMergePlanPreview,
} from "./writing-merge-plan.ts";

type Slot = {
  status: "idle" | "reading" | "checking" | "ready" | "failed";
  name: string;
  percent: number;
  backup: WritingBackup | null;
  error: string;
};
export type WritingMergeState = {
  slots: Record<WritingMergeRole, Slot>;
  baselineConfirmed: boolean;
  analysisStatus: "idle" | "running" | "complete" | "cancelled";
  analysis: WritingMergeAnalysis | null;
  decisions: WritingMergeDecision[];
  preparing: boolean;
  prepared: PreparedWritingMerge | null;
  planLoading: boolean;
  planPreparing: boolean;
  planPreview: WritingMergePlanPreview | null;
  planArtifact: CollectionArtifact | null;
  error: string;
};
type Options = {
  read?: (
    file: File,
    signal: AbortSignal,
    progress: (percent: number) => void,
  ) => Promise<string>;
  open?: (text: string, signal: AbortSignal) => Promise<WritingBackup>;
  pause?: () => Promise<void>;
  now?: () => Date;
};
const emptySlot = (): Slot => ({
  status: "idle",
  name: "",
  percent: 0,
  backup: null,
  error: "",
});

/** Owns only explicitly selected local data; no API client, account authority or persistent storage. */
export class WritingMergeWorkbench {
  private state: WritingMergeState = {
    slots: { base: emptySlot(), current: emptySlot(), incoming: emptySlot() },
    baselineConfirmed: false,
    analysisStatus: "idle",
    analysis: null,
    decisions: [],
    preparing: false,
    prepared: null,
    planLoading: false,
    planPreparing: false,
    planPreview: null,
    planArtifact: null,
    error: "",
  };
  private listeners = new Set<() => void>();
  private reads: Record<WritingMergeRole, AbortController | null> = {
    base: null,
    current: null,
    incoming: null,
  };
  private analysisAbort: AbortController | null = null;
  private prepareAbort: AbortController | null = null;
  private planReadAbort: AbortController | null = null;
  private planExportAbort: AbortController | null = null;
  private sourceVersion = 0;
  private decisionVersion = 0;
  private previewRevision = -1;
  private options: Required<Options>;

  constructor(options: Options = {}) {
    this.options = {
      read: options.read ?? readCollectionFile,
      open:
        options.open ??
        (async (text, signal) => {
          assertWritingMergeActive(signal);
          return parseWritingMergeSource(text);
        }),
      pause:
        options.pause ??
        (() => new Promise((resolve) => setTimeout(resolve, 0))),
      now: options.now ?? (() => new Date()),
    };
  }

  getSnapshot = (): WritingMergeState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(patch: Partial<WritingMergeState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private updateSlot(role: WritingMergeRole, patch: Partial<Slot>): void {
    this.publish({
      slots: {
        ...this.state.slots,
        [role]: { ...this.state.slots[role], ...patch },
      },
    });
  }

  private invalidatePlan(): Partial<WritingMergeState> {
    this.planReadAbort?.abort();
    this.planReadAbort = null;
    this.planExportAbort?.abort();
    this.planExportAbort = null;
    this.previewRevision = -1;
    return {
      planLoading: false,
      planPreparing: false,
      planPreview: null,
      planArtifact: null,
    };
  }

  private invalidateDecisions(): Partial<WritingMergeState> {
    this.decisionVersion++;
    this.prepareAbort?.abort();
    this.prepareAbort = null;
    return { ...this.invalidatePlan(), preparing: false, prepared: null };
  }

  private invalidateAnalysis(): Partial<WritingMergeState> {
    this.analysisAbort?.abort();
    this.analysisAbort = null;
    return {
      ...this.invalidateDecisions(),
      analysis: null,
      analysisStatus: "idle",
      decisions: [],
    };
  }

  clear(role?: WritingMergeRole): void {
    if (role && !MERGE_ROLES.includes(role)) return;
    this.sourceVersion++;
    const slots = { ...this.state.slots };
    for (const target of role ? [role] : MERGE_ROLES) {
      this.reads[target]?.abort();
      this.reads[target] = null;
      slots[target] = emptySlot();
    }
    this.publish({
      ...this.invalidateAnalysis(),
      slots,
      baselineConfirmed: false,
      error: "",
    });
  }

  async load(role: WritingMergeRole, file: File): Promise<void> {
    if (!MERGE_ROLES.includes(role)) return;
    this.clear(role);
    if (
      !Number.isSafeInteger(file.size) ||
      file.size < 1 ||
      file.size > MAX_WRITING_BACKUP_BYTES
    ) {
      this.updateSlot(role, {
        status: "failed",
        error: "来源文件须大于 0 且不超过 2 MiB，未启动读取。",
      });
      return;
    }
    const abort = new AbortController();
    this.reads[role] = abort;
    const current = () => this.reads[role] === abort && !abort.signal.aborted;
    const name = file.name.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 240);
    this.updateSlot(role, { status: "reading", name, error: "" });
    try {
      const text = await this.options.read(file, abort.signal, (percent) => {
        if (current())
          this.updateSlot(role, {
            percent: Number.isFinite(percent)
              ? Math.max(0, Math.min(100, Math.floor(percent)))
              : 0,
          });
      });
      if (!current()) return;
      this.updateSlot(role, { status: "checking", percent: 100 });
      const backup = await this.options.open(text, abort.signal);
      if (!current()) return;
      // Another role may have finished while this read/parse was suspended.
      this.sourceVersion++;
      this.publish({
        ...this.invalidateAnalysis(),
        baselineConfirmed: false,
        error: "",
      });
      this.updateSlot(role, { status: "ready", backup, error: "" });
    } catch (error) {
      if (current())
        this.updateSlot(role, {
          status: "failed",
          backup: null,
          error: error instanceof Error ? error.message : "本机来源读取失败。",
        });
    } finally {
      if (this.reads[role] === abort) this.reads[role] = null;
    }
  }

  private inputs(): WritingMergeSources {
    const sources = {} as WritingMergeSources;
    for (const role of MERGE_ROLES) {
      const slot = this.state.slots[role];
      if (slot.status !== "ready" || !slot.backup)
        throw new Error("请先读取并校验三份来源，再确认共同基线。");
      sources[role] = slot.backup;
    }
    return sources;
  }

  confirmBaseline(confirmed: boolean): void {
    try {
      if (confirmed) this.inputs();
      this.publish({
        ...this.invalidateAnalysis(),
        baselineConfirmed: confirmed,
        error: "",
      });
    } catch (error) {
      this.publish({
        error: error instanceof Error ? error.message : "无法确认共同基线。",
      });
    }
  }

  cancelAnalysis(): void {
    this.publish({
      ...this.invalidateAnalysis(),
      analysisStatus: "cancelled",
      error: "",
    });
  }

  async analyze(): Promise<void> {
    const abort = new AbortController();
    const version = this.sourceVersion;
    let started = false;
    const current = () =>
      this.analysisAbort === abort &&
      !abort.signal.aborted &&
      this.sourceVersion === version;
    try {
      const inputs = this.inputs();
      if (!this.state.baselineConfirmed)
        throw new Error("请先明确确认这三份文件的共同基线与角色。");
      const invalidated = this.invalidateAnalysis();
      this.analysisAbort = abort;
      started = true;
      this.publish({ ...invalidated, analysisStatus: "running", error: "" });
      const analysis = await analyzeWritingMerge(
        inputs,
        abort.signal,
        this.options.pause,
      );
      if (!current()) return;
      this.publish({ analysis, analysisStatus: "complete", error: "" });
    } catch (error) {
      if (!started || current())
        this.publish({
          analysisStatus: "idle",
          error: error instanceof Error ? error.message : "本机三方分析失败。",
        });
    } finally {
      if (this.analysisAbort === abort) this.analysisAbort = null;
    }
  }

  private liveAnalysis(
    expected?: WritingMergeAnalysis | null,
  ): WritingMergeAnalysis {
    const analysis = this.state.analysis;
    if (
      !analysis ||
      this.state.analysisStatus !== "complete" ||
      !this.state.baselineConfirmed ||
      (expected !== undefined && expected !== analysis)
    ) {
      throw new Error("合并分析已过期或变化，请重新确认并准备三份来源。");
    }
    return analysis;
  }

  choose(
    unit: string,
    choice: WritingMergeChoice | null,
    expected: WritingMergeAnalysis | null,
  ): void {
    try {
      const analysis = this.liveAnalysis(expected);
      if (!analysis.units.some((item) => item.id === unit))
        throw new Error("合并条目已经变化。");
      const remaining = this.state.decisions.filter(
        (item) => item.unit !== unit,
      );
      const decisions = validateWritingMergeDecisions(
        analysis,
        choice === null ? remaining : [...remaining, { unit, choice }],
      );
      this.publish({ ...this.invalidateDecisions(), decisions, error: "" });
    } catch (error) {
      this.publish({
        error: error instanceof Error ? error.message : "人工取舍无效。",
      });
    }
  }

  resetDecisions(expected: WritingMergeAnalysis | null): void {
    try {
      this.liveAnalysis(expected);
      this.publish({ ...this.invalidateDecisions(), decisions: [], error: "" });
    } catch (error) {
      this.publish({
        error: error instanceof Error ? error.message : "无法清空人工取舍。",
      });
    }
  }

  cancelPreparation(): void {
    this.prepareAbort?.abort();
    this.prepareAbort = null;
    this.publish({ preparing: false, prepared: null });
  }

  async prepare(): Promise<void> {
    this.cancelPreparation();
    const abort = new AbortController();
    const revision = this.decisionVersion;
    this.prepareAbort = abort;
    const current = () =>
      this.prepareAbort === abort &&
      !abort.signal.aborted &&
      revision === this.decisionVersion;
    try {
      const analysis = this.liveAnalysis();
      const decisions = structuredClone(this.state.decisions);
      this.publish({ preparing: true, error: "" });
      await this.options.pause();
      assertWritingMergeActive(abort.signal);
      const prepared = await prepareWritingMerge(
        analysis,
        decisions,
        this.options.now(),
        abort.signal,
      );
      if (!current() || this.state.analysis !== analysis) return;
      if (
        prepared.decisionsKey !==
        writingMergeDecisionsKey(analysis, this.state.decisions)
      )
        throw new Error("取舍已经变化，旧结果未被采用。");
      this.publish({ preparing: false, prepared, error: "" });
    } catch (error) {
      if (current())
        this.publish({
          preparing: false,
          prepared: null,
          error:
            error instanceof Error
              ? error.message
              : "合并结果校验失败，没有截断或部分生成文稿。",
        });
    } finally {
      if (this.prepareAbort === abort) this.prepareAbort = null;
    }
  }

  resultDownload(expected: PreparedWritingMerge | null): CollectionArtifact {
    const analysis = this.liveAnalysis();
    const prepared = this.state.prepared;
    if (
      !prepared ||
      prepared !== expected ||
      this.state.preparing ||
      prepared.analysisKey !== analysis.key ||
      prepared.decisionsKey !==
        writingMergeDecisionsKey(analysis, this.state.decisions)
    ) {
      throw new Error("合并下载预检已过期，请重新准备当前取舍。");
    }
    return {
      text: prepared.text,
      name: writingDownloadName(
        `${prepared.backup.draft.title}-merged`,
        "json",
        new Date(prepared.backup.createdAt),
      ),
      mime: "application/json;charset=utf-8",
    };
  }

  cancelPlan(): void {
    this.publish({ ...this.invalidatePlan(), error: "" });
  }

  async loadPlan(file: File): Promise<void> {
    this.cancelPlan();
    const abort = new AbortController();
    this.planReadAbort = abort;
    const revision = this.decisionVersion;
    const current = () =>
      this.planReadAbort === abort &&
      !abort.signal.aborted &&
      revision === this.decisionVersion;
    try {
      const analysis = this.liveAnalysis();
      if (
        !Number.isSafeInteger(file.size) ||
        file.size < 1 ||
        file.size > MERGE_PLAN_BYTE_LIMIT
      )
        throw new Error("决策计划须大于 0 且不超过 64 KiB，未启动读取。");
      this.publish({ planLoading: true, error: "" });
      const text = await this.options.read(file, abort.signal, () => {});
      if (!current()) return;
      const planPreview = await previewWritingMergePlan(
        text,
        analysis,
        abort.signal,
      );
      if (!current() || this.state.analysis !== analysis) return;
      this.previewRevision = revision;
      this.publish({ planLoading: false, planPreview, error: "" });
    } catch (error) {
      if (current())
        this.publish({
          planLoading: false,
          planPreview: null,
          error:
            error instanceof Error
              ? error.message
              : "决策计划读取失败，原人工取舍未改变。",
        });
    } finally {
      if (this.planReadAbort === abort) this.planReadAbort = null;
    }
  }

  applyPlan(expected: WritingMergePlanPreview | null): void {
    const analysis = this.liveAnalysis();
    const preview = this.state.planPreview;
    if (
      !preview ||
      preview !== expected ||
      preview.analysisKey !== analysis.key ||
      this.previewRevision !== this.decisionVersion
    ) {
      throw new Error("决策计划预览已过期或变化，原人工取舍没有被更改。");
    }
    const decisions = validateWritingMergeDecisions(
      analysis,
      preview.decisions,
    );
    this.publish({ ...this.invalidateDecisions(), decisions, error: "" });
  }

  async preparePlan(): Promise<void> {
    this.planExportAbort?.abort();
    const abort = new AbortController();
    this.planExportAbort = abort;
    const revision = this.decisionVersion;
    const current = () =>
      this.planExportAbort === abort &&
      !abort.signal.aborted &&
      revision === this.decisionVersion;
    try {
      const analysis = this.liveAnalysis();
      const decisions = structuredClone(this.state.decisions);
      this.publish({ planPreparing: true, planArtifact: null, error: "" });
      await this.options.pause();
      assertWritingMergeActive(abort.signal);
      const prepared = await createWritingMergePlan(
        analysis,
        decisions,
        this.options.now(),
        abort.signal,
      );
      if (!current() || this.state.analysis !== analysis) return;
      const planArtifact: CollectionArtifact = {
        text: prepared.text,
        name: `no-wave-merge-plan-${prepared.plan.createdAt.slice(0, 10)}.json`,
        mime: "application/json;charset=utf-8",
      };
      this.publish({ planPreparing: false, planArtifact, error: "" });
    } catch (error) {
      if (current())
        this.publish({
          planPreparing: false,
          planArtifact: null,
          error: error instanceof Error ? error.message : "决策计划准备失败。",
        });
    } finally {
      if (this.planExportAbort === abort) this.planExportAbort = null;
    }
  }

  planDownload(expected: CollectionArtifact | null): CollectionArtifact {
    this.liveAnalysis();
    const artifact = this.state.planArtifact;
    if (!artifact || artifact !== expected || this.state.planPreparing)
      throw new Error("决策计划下载已过期，请重新准备当前取舍。");
    return artifact;
  }
}
