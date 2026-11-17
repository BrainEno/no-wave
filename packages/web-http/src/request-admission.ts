import { AUTHORING_NOTION_IMPORT_MAX_BYTES } from "./authoring.ts";

export type IncomingRequestInfo = { method: string; path: string; contentLength: string | null; transferEncoding: string | null };
export type RequestRefusalReason = "request-capacity" | "body-capacity" | "body-limit" | "framing" | "closing";
export type RequestCompletion = "completed" | "aborted" | "failed";
export type RequestAdmissionDecision = { ok: true; release(outcome: RequestCompletion): void } |
  { ok: false; status: 400 | 413 | 503; reason: RequestRefusalReason };
export type RequestAdmissionSettings = { concurrency?: number; bodyBudgetBytes?: number; maxBodyBytes?: number };
type RequestLaneState = { active: number; reservedBytes: number; peakActive: number; peakBytes: number };
const REFUSALS: readonly RequestRefusalReason[] = ["request-capacity", "body-capacity", "body-limit", "framing", "closing"];
const SESSION_CONCURRENCY = 8;
const SESSION_BODY_BYTES = 4096;

function isSessionRequest(info: IncomingRequestInfo): boolean {
  const path = info.path.split("?")[0];
  return info.method === "GET" && path === "/api/authoring/session" || info.method === "POST" &&
    /^\/api\/auth\/(?:login|register|refresh|logout|forgot-password|reset-password|verify-email)$/.test(path!);
}
function emptyLane(): RequestLaneState {
  return { active: 0, reservedBytes: 0, peakActive: 0, peakBytes: 0 };
}
function boundedCounter(value: number): number { return Math.min(Number.MAX_SAFE_INTEGER, value + 1); }

/**
 * Intake capacity is held for the entire HTTP exchange. Limiting only fetches
 * is too late: many concurrent 8 MiB uploads could already be buffered while
 * waiting to acquire their upstream slot. No visitor identity is inferred here.
 */
export class WebRequestAdmission {
  private readonly concurrency: number;
  private readonly bodyBudgetBytes: number;
  private readonly maxBodyBytes: number;
  private readonly ordinary = emptyLane();
  private readonly session = emptyLane();
  private readonly refusals: Record<RequestRefusalReason, number> = { "request-capacity": 0, "body-capacity": 0, "body-limit": 0, framing: 0, closing: 0 };
  private readonly completions: Record<RequestCompletion, number> = { completed: 0, aborted: 0, failed: 0 };
  private draining = false;

  constructor(options: RequestAdmissionSettings = {}) {
    this.concurrency = options.concurrency ?? 56;
    this.bodyBudgetBytes = options.bodyBudgetBytes ?? 64 * 1024 * 1024;
    this.maxBodyBytes = options.maxBodyBytes ?? AUTHORING_NOTION_IMPORT_MAX_BYTES;
    if (!Number.isSafeInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 256 ||
        !Number.isSafeInteger(this.maxBodyBytes) || this.maxBodyBytes < 1 || this.maxBodyBytes > AUTHORING_NOTION_IMPORT_MAX_BYTES ||
        !Number.isSafeInteger(this.bodyBudgetBytes) || this.bodyBudgetBytes < this.maxBodyBytes || this.bodyBudgetBytes > 128 * 1024 * 1024) {
      throw new RangeError("Invalid Web request admission settings.");
    }
  }

  private refuse(reason: RequestRefusalReason, status: 400 | 413 | 503): RequestAdmissionDecision {
    this.refusals[reason] = boundedCounter(this.refusals[reason]);
    return { ok: false, status, reason };
  }

  acquire(info: IncomingRequestInfo): RequestAdmissionDecision {
    if (this.draining) return this.refuse("closing", 503);
    const method = info.method.toUpperCase();
    const declared = info.contentLength;
    const transfer = info.transferEncoding;
    if (declared !== null && !/^\d+$/.test(declared) || transfer !== null && transfer.toLowerCase() !== "chunked" || declared !== null && transfer !== null) {
      return this.refuse("framing", 400);
    }
    const length = declared === null ? 0 : Number(declared);
    const hasBody = transfer !== null || length > 0;
    if ((method === "GET" || method === "HEAD") && hasBody) return this.refuse("framing", 400);
    if (length > this.maxBodyBytes) return this.refuse("body-limit", 413);
    const sessionRequest = isSessionRequest({ ...info, method });
    const state = sessionRequest ? this.session : this.ordinary;
    const slots = sessionRequest ? SESSION_CONCURRENCY : this.concurrency;
    if (state.active >= slots) return this.refuse("request-capacity", 503);
    // Session handlers read at most 4 KiB (or ignore a body). This reservation
    // does not replace their method/Origin/body checks or widen that contract.
    const ceiling = sessionRequest ? SESSION_BODY_BYTES : this.maxBodyBytes;
    const reservation = transfer !== null ? ceiling : Math.min(length, ceiling);
    const capacity = sessionRequest ? SESSION_CONCURRENCY * SESSION_BODY_BYTES : this.bodyBudgetBytes;
    if (reservation > capacity - state.reservedBytes) return this.refuse("body-capacity", 503);
    state.active++;
    state.reservedBytes += reservation;
    state.peakActive = Math.max(state.peakActive, state.active);
    state.peakBytes = Math.max(state.peakBytes, state.reservedBytes);
    let returned = false;
    return { ok: true, release: outcome => {
      if (returned) return;
      returned = true;
      state.active--;
      state.reservedBytes -= reservation;
      const completion = outcome === "completed" || outcome === "aborted" ? outcome : "failed";
      this.completions[completion] = boundedCounter(this.completions[completion]);
    } };
  }

  stop(): void { this.draining = true; }

  snapshot() {
    return {
      ordinary: { ...this.ordinary, concurrency: this.concurrency, bodyBudgetBytes: this.bodyBudgetBytes },
      session: { ...this.session, concurrency: SESSION_CONCURRENCY, bodyBudgetBytes: SESSION_CONCURRENCY * SESSION_BODY_BYTES },
      ...this.completions, refusals: { ...this.refusals }, draining: this.draining,
    };
  }

  /** Counters describe pressure, never a request path, upload name, address or body. */
  metrics(): string {
    const current = this.snapshot();
    const output: string[] = [];
    const descriptors = [
      ["active", "active", "Accepted HTTP exchanges still owning capacity."],
      ["body_reserved_bytes", "reservedBytes", "Conservative incoming body reservations until exchange completion."],
      ["peak_active", "peakActive", "Highest concurrent accepted HTTP exchanges."],
      ["peak_body_bytes", "peakBytes", "Highest simultaneous reserved incoming body bytes."],
      ["concurrency", "concurrency", "Maximum accepted HTTP exchanges for this lane."],
      ["body_budget_bytes", "bodyBudgetBytes", "Maximum incoming body reservations for this lane."],
    ] as const;
    for (const [metric, field, help] of descriptors) {
      output.push(`# HELP web_intake_${metric} ${help}`, `# TYPE web_intake_${metric} gauge`);
      for (const lane of ["ordinary", "session"] as const) output.push(`web_intake_${metric}{lane="${lane}"} ${current[lane][field]}`);
    }
    output.push("# HELP web_intake_refused_total Refused HTTP exchanges before application execution.", "# TYPE web_intake_refused_total counter");
    for (const reason of REFUSALS) output.push(`web_intake_refused_total{reason="${reason}"} ${current.refusals[reason]}`);
    output.push("# HELP web_intake_finished_total Accepted exchanges by observed completion.", "# TYPE web_intake_finished_total counter");
    for (const outcome of ["completed", "aborted", "failed"] as const) output.push(`web_intake_finished_total{outcome="${outcome}"} ${current[outcome]}`);
    output.push("# HELP web_intake_draining Whether new application exchanges are refused.", "# TYPE web_intake_draining gauge", `web_intake_draining ${current.draining ? 1 : 0}`);
    return output.join("\n") + "\n";
  }
}
