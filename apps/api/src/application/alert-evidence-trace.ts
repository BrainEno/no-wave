import { handoffHash } from "./alert-handoff-protocol.ts";
import { analyzeAlertEvidence } from "./alert-evidence-review.ts";
import {
  buildEvidenceTraceContext,
  describeEvidenceTraceFact,
  type EvidenceTraceFact,
} from "./alert-evidence-context.ts";
import {
  pageEvidenceTrace,
  parseEvidenceTraceQuery,
  traceQueryFingerprint,
  type EvidenceTraceQuery,
} from "./alert-evidence-query.ts";
import {
  EvidenceFindings,
  evidenceOptions,
  type AlertEvidenceTrust,
  type EvidenceFinding,
  type EvidenceInput,
  type EvidenceOptions,
} from "./alert-evidence.ts";

type EventEntry = ReturnType<typeof describeEvidenceTraceFact>;
type FindingEntry = {
  kind: "finding";
  rowId: string;
  finding: EvidenceFinding;
};
type TraceEntry = EventEntry | FindingEntry;
function sequenceSelected(
  sequence: number | null,
  query: EvidenceTraceQuery,
): boolean {
  if (
    query.fromSequence !== null &&
    (sequence === null || sequence < query.fromSequence)
  )
    return false;
  if (
    query.throughSequence !== null &&
    (sequence === null || sequence > query.throughSequence)
  )
    return false;
  return true;
}
function eventSelected(
  fact: EvidenceTraceFact,
  query: EvidenceTraceQuery,
): boolean {
  if (query.streamId !== null && fact.batch.streamId !== query.streamId)
    return false;
  if (query.batchId !== null && fact.batch.id !== query.batchId) return false;
  if (query.eventId !== null && fact.event.id !== query.eventId) return false;
  if (query.targetId !== null && fact.event.targetId !== query.targetId)
    return false;
  if (query.rule !== null && fact.event.rule !== query.rule) return false;
  if (query.transition !== null && fact.event.transition !== query.transition)
    return false;
  if (query.fromAt !== null && fact.event.at < query.fromAt) return false;
  if (query.throughAt !== null && fact.event.at > query.throughAt) return false;
  return sequenceSelected(fact.batch.sequence, query);
}
function findingSelected(
  finding: EvidenceFinding,
  query: EvidenceTraceQuery,
): boolean {
  if (query.streamId !== null && finding.streamId !== query.streamId)
    return false;
  if (query.batchId !== null && finding.batchId !== query.batchId) return false;
  if (query.eventId !== null && finding.eventId !== query.eventId) return false;
  if (query.code !== null && finding.code !== query.code) return false;
  if (query.severity !== null && finding.severity !== query.severity)
    return false;
  return sequenceSelected(finding.sequence, query);
}

/** Related issues are selected from the full internal findings, not the
 * bounded global display sample. A replayed event ID is namespaced by source. */
function pageRelatedFindings(
  facts: readonly EvidenceTraceFact[],
  context: ReturnType<typeof buildEvidenceTraceContext>,
  allFindings: readonly EvidenceFinding[],
) {
  const batches = new Set(facts.map((fact) => fact.batch.id));
  const events = new Set(
    facts.map((fact) => `${fact.batch.streamId}:${fact.event.id}`),
  );
  const streams = new Set(facts.map((fact) => fact.batch.streamId));
  const receipts = new Set(
    facts.flatMap((fact) =>
      (context.receiptClaims.get(fact.batch.id) ?? []).map(
        (claim) => claim.receiptId,
      ),
    ),
  );
  const selected = new EvidenceFindings();
  for (const finding of allFindings) {
    const directBatch =
      finding.batchId !== null && batches.has(finding.batchId);
    const directEvent =
      finding.eventId !== null &&
      events.has(`${finding.streamId}:${finding.eventId}`);
    const relatedArtifact =
      finding.relatedId !== null &&
      (batches.has(finding.relatedId) || receipts.has(finding.relatedId));
    const sourceWide =
      finding.batchId === null &&
      finding.eventId === null &&
      (finding.streamId === null || streams.has(finding.streamId));
    if (directBatch || directEvent || relatedArtifact || sourceWide)
      selected.add(finding.code, finding.severity, finding);
  }
  return { totals: selected.summary(), findings: selected.list() };
}

/** Filtered navigation is not an assertion that excluded facts do not exist.
 * Every call authenticates all artifacts and preserves the unfiltered review's
 * exit code, including when a filter deliberately selects no rows. */
export function traceAlertEvidence(
  trust: AlertEvidenceTrust,
  inputs: readonly EvidenceInput[],
  queryValue: unknown,
  options: EvidenceOptions,
) {
  const normalized = evidenceOptions(options);
  const query = parseEvidenceTraceQuery(queryValue, trust, normalized.now);
  const analysis = analyzeAlertEvidence(trust, inputs, options);
  const allFindings = analysis.findings.all();
  const fingerprint = traceQueryFingerprint(query, normalized.maxAgeMs);
  let entries: TraceEntry[],
    matched: number,
    continuation: string | null,
    pageId: string;
  let related: ReturnType<typeof pageRelatedFindings> | null = null;
  if (query.view === "events") {
    const context = buildEvidenceTraceContext(trust, analysis.evidence);
    const facts = context.facts.filter((fact) => eventSelected(fact, query));
    const page = pageEvidenceTrace(
      facts,
      analysis.evidence.evidenceId,
      fingerprint,
      query,
    );
    const eventEntries = page.selected.map((fact) =>
      describeEvidenceTraceFact(context, fact),
    );
    entries = eventEntries;
    matched = page.matched;
    continuation = page.continuation;
    pageId = page.pageId;
    related = pageRelatedFindings(page.selected, context, allFindings);
  } else {
    const rows: FindingEntry[] = [];
    for (const finding of allFindings) {
      if (!findingSelected(finding, query)) continue;
      rows.push({
        kind: "finding",
        rowId: handoffHash(["no-wave-alert-evidence-finding-v1", finding]),
        finding,
      });
    }
    const page = pageEvidenceTrace(
      rows,
      analysis.evidence.evidenceId,
      fingerprint,
      query,
    );
    entries = page.selected;
    matched = page.matched;
    continuation = page.continuation;
    pageId = page.pageId;
  }
  const { after: _, ...selection } = query;
  return {
    version: 1,
    event: "alert_evidence_trace",
    evidence: "signed_history_only",
    assessment: "filtered_navigation_not_service_progress",
    scope: "provided_artifacts_only",
    tailFinality: "not_proven",
    cursorAuthentication: "not_an_authorization_token",
    evidenceId: analysis.evidence.evidenceId,
    queryFingerprint: fingerprint,
    pageId,
    selection,
    matched,
    entries,
    continuation,
    relatedFindings: related,
    globalReview: analysis.report,
    exitCode: analysis.report.exitCode,
  };
}
