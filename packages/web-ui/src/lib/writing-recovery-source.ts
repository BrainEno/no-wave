import {
  parseRetryAfterSeconds,
  readLimitedStream,
  resolveUpstreamTimeoutMs,
  UpstreamCancelledError,
  UpstreamTimeoutError,
  withUpstreamDeadline,
} from "@bot-thk/web-http";
import {
  CatalogueDocumentReader,
  CatalogueReadError,
} from "./authoring-catalogue-open.ts";
import { parseWritingBackup, validateWritingState } from "./writing-backup.ts";
import {
  compareWritingDrafts,
  type WritingComparison,
} from "./writing-compare.ts";
import { articleBlocksToLexicalEditorState } from "./lexical-article-state.ts";
import {
  parseRecoveryEntry,
  recoveryTime,
  WritingRecoveryFault,
  type RecoveryEntry,
} from "./writing-recovery-model.ts";
import { isNotificationActor } from "./notification-transport.ts";
import { writingDraftKey, type WritingDraft } from "./writing-session.ts";

export type RecoverySourceReview = {
  id: string;
  witness: string;
  kind: "available" | "missing" | "unlinked";
  relation: "same" | "advanced" | "rewound" | "unknown";
  serverRevision: string | null;
  serverStatus: "draft" | "published" | null;
  equivalent: boolean;
  comparison: WritingComparison | null;
  checkedAt: number;
};
export type RecoverySourceOptions = {
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  now?: () => number;
};
const SOURCE_BYTES = 2 * 1024 * 1024;

/** Explicit read-only source comparison. Reuses the catalogue's exact actor,
 * language, metadata and revision parser, and the shared HTTP budget/byte
 * boundary. A matching body is not an idempotency receipt or permission to save. */
export class WritingRecoverySourceReader {
  private reader: CatalogueDocumentReader;
  private version = 0;
  private retryAt = 0;
  private now: () => number;
  private fetcher: NonNullable<RecoverySourceOptions["fetchImpl"]>;
  private timeoutMs: number;
  constructor(options: RecoverySourceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.fetcher = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = resolveUpstreamTimeoutMs(options.timeoutMs ?? 8000);
    this.reader = new CatalogueDocumentReader((url, init) =>
      this.fetchBounded(url, init),
    );
  }
  cancel(): void {
    this.version++;
    this.reader.cancel();
  }
  private clock(): number {
    const at = this.now();
    if (!recoveryTime(at)) throw new WritingRecoveryFault("clock");
    return at;
  }
  private async fetchBounded(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    return withUpstreamDeadline(
      this.timeoutMs,
      async (signal, checkpoint) => {
        const response = await this.fetcher(url, {
          ...init,
          method: "GET",
          redirect: "error",
          signal,
        });
        // An uncooperative fetch may finish after a cancelled read. Never leak
        // that response body or allow it to bypass the caller's absolute budget.
        if (signal.aborted) {
          void response.body?.cancel().catch(() => {});
          checkpoint();
        }
        if (response.status === 429) {
          void response.body?.cancel().catch(() => {});
          const seconds =
            parseRetryAfterSeconds(
              response.headers.get("retry-after"),
              this.clock(),
            ) ?? 1;
          this.retryAt = this.clock() + seconds * 1000;
          throw new CatalogueReadError(
            "limited",
            `来源核对请求受限，请等待 ${seconds} 秒后手动重试。`,
            this.retryAt,
          );
        }
        const length = response.headers.get("content-length");
        if (
          !/^application\/json(?:\s*;|$)/i.test(
            response.headers.get("content-type") ?? "",
          ) ||
          !response.body ||
          (length !== null &&
            (!/^\d+$/.test(length) || Number(length) > SOURCE_BYTES))
        ) {
          void response.body?.cancel().catch(() => {});
          throw new WritingRecoveryFault("invalid");
        }
        const stream = response.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>(),
          { signal },
        );
        const body = await readLimitedStream(stream, SOURCE_BYTES);
        checkpoint();
        if (!body.ok) throw new WritingRecoveryFault("invalid");
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(body.bytes);
        } catch {
          throw new WritingRecoveryFault("invalid");
        }
        // The catalogue parser sees only the bounded UTF-8 response; no cookie,
        // content encoding or unrelated upstream header is copied into it.
        return new Response(text, {
          status: response.status,
          headers: { "content-type": "application/json" },
        });
      },
      init.signal ?? undefined,
    );
  }
  async read(
    input: RecoveryEntry,
    actor: string,
    stillCurrent: () => boolean,
  ): Promise<RecoverySourceReview | null> {
    this.cancel();
    const version = this.version;
    const current = () => version === this.version && stillCurrent();
    if (!current()) return null;
    const entry = parseRecoveryEntry(input);
    if (!isNotificationActor(actor) || actor !== entry.actor)
      throw new WritingRecoveryFault("identity");
    const at = this.clock();
    const result: RecoverySourceReview = {
      id: entry.id,
      witness: JSON.stringify(entry),
      kind: "unlinked",
      relation: "unknown",
      serverRevision: null,
      serverStatus: null,
      equivalent: false,
      comparison: null,
      checkedAt: at,
    };
    if (entry.base.articleId === null) return result;
    if (at < this.retryAt)
      throw new CatalogueReadError(
        "limited",
        "来源核对仍在请求等待期，请稍后手动重试。",
        this.retryAt,
      );
    try {
      const article = await this.reader.read(
        { id: entry.base.articleId, locale: entry.base.locale, actor },
        current,
      );
      if (!article || !current()) return null;
      const cached = parseWritingBackup(entry.backup).draft;
      let server: WritingDraft;
      try {
        server = {
          title: article.title,
          summary: article.summary,
          locale: article.locale,
          workType: article.workType,
          editorState: validateWritingState(
            articleBlocksToLexicalEditorState(article.contentBlocks),
          ),
        };
        // Apply all existing manuscript metadata/size checks as well, without
        // persisting this server body or importing it into live Lexical.
        const serialized = JSON.stringify({
          format: "no-wave-writing-backup",
          version: 1,
          createdAt: new Date(at).toISOString(),
          draft: server,
        });
        server = parseWritingBackup(serialized).draft;
      } catch {
        throw new WritingRecoveryFault("invalid");
      }
      const comparison = compareWritingDrafts(cached, server);
      if (comparison.limited) throw new WritingRecoveryFault("invalid");
      let relation: RecoverySourceReview["relation"] = "unknown";
      if (entry.base.revision !== null) {
        const base = BigInt(entry.base.revision),
          remote = BigInt(article.revision);
        relation =
          remote === base ? "same" : remote > base ? "advanced" : "rewound";
      }
      if (!current()) return null;
      return {
        ...result,
        kind: "available",
        relation,
        serverRevision: article.revision,
        serverStatus: article.status,
        equivalent: writingDraftKey(cached) === writingDraftKey(server),
        comparison,
        checkedAt: this.clock(),
      };
    } catch (error) {
      if (!current() || error instanceof UpstreamCancelledError) return null;
      if (error instanceof CatalogueReadError && error.kind === "missing")
        return { ...result, kind: "missing", checkedAt: this.clock() };
      if (error instanceof UpstreamTimeoutError)
        throw new WritingRecoveryFault("timeout");
      if (
        error instanceof WritingRecoveryFault ||
        error instanceof CatalogueReadError
      )
        throw error;
      throw new WritingRecoveryFault("unavailable");
    }
  }
}
