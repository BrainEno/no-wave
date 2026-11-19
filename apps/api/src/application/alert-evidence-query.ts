import {
  handoffFields,
  handoffHash,
  handoffJson,
  HANDOFF_HASH,
  HANDOFF_UUID,
} from "./alert-handoff-protocol.ts";
import {
  monitorFields,
  MONITOR_RULES,
  type MonitorRuleId,
} from "./operational-monitor.ts";
import {
  AlertEvidenceFault,
  EVIDENCE_FINDING_CODES,
  type AlertEvidenceTrust,
  type EvidenceFinding,
  type EvidenceFindingCode,
} from "./alert-evidence.ts";

export type EvidenceTraceQuery = {
  view: "events" | "findings";
  streamId: string | null;
  targetId: string | null;
  batchId: string | null;
  eventId: string | null;
  rule: MonitorRuleId | null;
  transition: "firing" | "reminder" | "resolved" | null;
  fromAt: number | null;
  throughAt: number | null;
  fromSequence: number | null;
  throughSequence: number | null;
  code: EvidenceFindingCode | null;
  severity: EvidenceFinding["severity"] | null;
  limit: number;
  after: string | null;
};
function rangeNumber(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw new AlertEvidenceFault("arguments_invalid");
  return value;
}

/** Selectors narrow a navigation view only. They never narrow authentication,
 * resource admission, the global review, or the command's attention exit code. */
export function parseEvidenceTraceQuery(
  value: unknown,
  trust: AlertEvidenceTrust,
  now: number,
): EvidenceTraceQuery {
  try {
    const row = monitorFields(
      value,
      [
        "view",
        "streamId",
        "targetId",
        "batchId",
        "eventId",
        "rule",
        "transition",
        "fromAt",
        "throughAt",
        "fromSequence",
        "throughSequence",
        "code",
        "severity",
        "limit",
        "after",
      ],
      "config_invalid",
    );
    const view = row.view ?? "events";
    if (view !== "events" && view !== "findings")
      throw new AlertEvidenceFault("arguments_invalid");
    const streamId = row.streamId ?? null,
      targetId = row.targetId ?? null;
    const batchId = row.batchId ?? null,
      eventId = row.eventId ?? null;
    for (const id of [batchId, eventId]) {
      if (id !== null && (typeof id !== "string" || !HANDOFF_HASH.test(id)))
        throw new AlertEvidenceFault("arguments_invalid");
    }
    const rule = row.rule ?? null,
      transition = row.transition ?? null;
    const code = row.code ?? null,
      severity = row.severity ?? null;
    if (
      streamId !== null &&
      (typeof streamId !== "string" ||
        !HANDOFF_UUID.test(streamId) ||
        !trust.byStream.has(streamId))
    )
      throw new AlertEvidenceFault("arguments_invalid");
    if (
      targetId !== null &&
      (typeof targetId !== "string" || !/^[a-z][a-z0-9-]{0,47}$/.test(targetId))
    )
      throw new AlertEvidenceFault("arguments_invalid");
    if (
      rule !== null &&
      (typeof rule !== "string" ||
        !(MONITOR_RULES as readonly string[]).includes(rule))
    )
      throw new AlertEvidenceFault("arguments_invalid");
    if (
      transition !== null &&
      (typeof transition !== "string" ||
        !["firing", "reminder", "resolved"].includes(transition))
    )
      throw new AlertEvidenceFault("arguments_invalid");
    if (
      code !== null &&
      (typeof code !== "string" ||
        !(EVIDENCE_FINDING_CODES as readonly string[]).includes(code))
    )
      throw new AlertEvidenceFault("arguments_invalid");
    if (
      severity !== null &&
      (typeof severity !== "string" ||
        !["gap", "conflict", "warning"].includes(severity))
    )
      throw new AlertEvidenceFault("arguments_invalid");
    const fromAt = rangeNumber(row.fromAt, 0, now),
      throughAt = rangeNumber(row.throughAt, 0, now);
    const fromSequence = rangeNumber(
      row.fromSequence,
      1,
      Number.MAX_SAFE_INTEGER,
    );
    const throughSequence = rangeNumber(
      row.throughSequence,
      1,
      Number.MAX_SAFE_INTEGER,
    );
    if (
      (fromAt !== null && throughAt !== null && fromAt > throughAt) ||
      (fromSequence !== null &&
        throughSequence !== null &&
        fromSequence > throughSequence)
    )
      throw new AlertEvidenceFault("arguments_invalid");
    if (
      (view === "findings" &&
        (targetId !== null ||
          rule !== null ||
          transition !== null ||
          fromAt !== null ||
          throughAt !== null)) ||
      (view === "events" && (code !== null || severity !== null))
    )
      throw new AlertEvidenceFault("arguments_invalid");
    const limit = rangeNumber(row.limit, 1, 128) ?? 100;
    const after = row.after ?? null;
    if (
      after !== null &&
      (typeof after !== "string" || after.length < 1 || after.length > 2048)
    )
      throw new AlertEvidenceFault("cursor_invalid");
    return {
      view,
      streamId,
      targetId,
      batchId: batchId as string | null,
      eventId: eventId as string | null,
      rule: rule as MonitorRuleId | null,
      transition: transition as EvidenceTraceQuery["transition"],
      fromAt,
      throughAt,
      fromSequence,
      throughSequence,
      code: code as EvidenceFindingCode | null,
      severity: severity as EvidenceTraceQuery["severity"],
      limit,
      after,
    };
  } catch (error) {
    if (error instanceof AlertEvidenceFault) throw error;
    throw new AlertEvidenceFault("arguments_invalid");
  }
}
export function traceQueryFingerprint(
  query: EvidenceTraceQuery,
  maxAgeMs: number,
): string {
  const { after: _, ...selection } = query;
  return handoffHash(["no-wave-alert-evidence-query-v1", maxAgeMs, selection]);
}

/** This is intentionally unsigned navigation data, not an authority token.
 * Its supplied position must exist in a freshly authenticated, exactly bound
 * result set. Forging another existing position cannot suppress global checks. */
export function pageEvidenceTrace<T extends { rowId: string }>(
  rows: readonly T[],
  evidenceId: string,
  queryFingerprint: string,
  query: EvidenceTraceQuery,
) {
  const pageId = handoffHash([
    "no-wave-alert-evidence-page-v1",
    evidenceId,
    queryFingerprint,
    rows.map((row) => row.rowId),
  ]);
  let start = 0;
  if (query.after !== null) {
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(query.after))
        throw new AlertEvidenceFault("cursor_invalid");
      const bytes = Buffer.from(query.after, "base64url");
      if (bytes.toString("base64url") !== query.after)
        throw new AlertEvidenceFault("cursor_invalid");
      const row = handoffFields(
        handoffJson(bytes, "artifact_invalid"),
        ["version", "type", "view", "pageId", "rowId"],
        "artifact_invalid",
      );
      if (
        row.version !== 1 ||
        row.type !== "alert_evidence_navigation" ||
        (row.view !== "events" && row.view !== "findings") ||
        typeof row.pageId !== "string" ||
        !HANDOFF_HASH.test(row.pageId) ||
        typeof row.rowId !== "string" ||
        !HANDOFF_HASH.test(row.rowId)
      )
        throw new AlertEvidenceFault("cursor_invalid");
      if (row.pageId !== pageId || row.view !== query.view)
        throw new AlertEvidenceFault("page_stale");
      const index = rows.findIndex(
        (candidate) => candidate.rowId === row.rowId,
      );
      if (index < 0) throw new AlertEvidenceFault("cursor_invalid");
      start = index + 1;
    } catch (error) {
      if (error instanceof AlertEvidenceFault) throw error;
      throw new AlertEvidenceFault("cursor_invalid");
    }
  }
  const selected = rows.slice(start, start + query.limit);
  const last = selected.at(-1);
  const continuation =
    start + selected.length < rows.length && last
      ? Buffer.from(
          JSON.stringify({
            version: 1,
            type: "alert_evidence_navigation",
            view: query.view,
            pageId,
            rowId: last.rowId,
          }),
        ).toString("base64url")
      : null;
  return { selected, matched: rows.length, continuation, pageId };
}
