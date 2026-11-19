import type { MonitorEvent } from "./operational-monitor.ts";
import type { EvidenceStreamHistory } from "./alert-evidence-history.ts";
import { EvidenceFindings, evidenceBatchScope } from "./alert-evidence.ts";

type ObservedEpisode = {
  fingerprint: string;
  event: MonitorEvent;
  batchId: string;
  originProven: boolean;
};

/** A gap, fork or configuration boundary breaks episode inference. In
 * particular, a later resolved event cannot silently close an earlier firing
 * across a missing range, even when both carry the same firingSince value. */
export function reviewEvidenceEpisodes(
  history: EvidenceStreamHistory,
  findings: EvidenceFindings,
) {
  let observedStarts = 0,
    observedResolutions = 0,
    unprovenOrigins = 0;
  let unprovenResolutions = 0,
    openBeforeBoundary = 0;
  let current = new Map<string, ObservedEpisode>();
  const seen = new Set<string>();
  for (let index = 0; index < history.segments.length; index++) {
    if (index > 0) {
      for (const episode of current.values())
        if (episode.event.transition !== "resolved") openBeforeBoundary++;
    }
    current = new Map();
    const segment = history.segments[index]!;
    for (const batch of segment.batches) {
      for (const event of batch.events) {
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        const key = `${batch.monitorFingerprint}:${event.targetId}:${event.rule}`;
        const prior = current.get(key);
        const scope = {
          ...evidenceBatchScope(batch),
          relatedId: prior?.batchId ?? null,
          eventId: event.id,
        };
        let originProven = prior?.originProven ?? false;
        if (event.transition === "firing") {
          observedStarts++;
          originProven = true;
          if (prior && prior.event.transition !== "resolved") {
            findings.add("episode_start_while_open", "conflict", scope);
            originProven = false;
          } else if (prior && event.firingSince <= prior.event.at) {
            findings.add("episode_overlaps_resolution", "conflict", scope);
            originProven = false;
          }
        } else if (!prior) {
          unprovenOrigins++;
          findings.add("episode_origin_unproven", "gap", scope);
          originProven = false;
        } else if (prior.event.transition === "resolved") {
          findings.add("episode_after_resolution", "conflict", scope);
          originProven = false;
        } else if (event.firingSince !== prior.event.firingSince) {
          findings.add("episode_origin_changed", "conflict", scope);
          originProven = false;
        }
        if (event.transition === "resolved") {
          if (originProven) observedResolutions++;
          else unprovenResolutions++;
        }
        current.set(key, {
          fingerprint: batch.monitorFingerprint,
          event,
          batchId: batch.id,
          originProven,
        });
      }
    }
  }
  const segmentTip = history.segments.at(-1)?.batches.at(-1)?.sequence ?? null;
  const tailAmbiguous =
    history.lastSequence === null || segmentTip !== history.lastSequence;
  const open = [...current.values()].filter(
    (episode) => episode.event.transition !== "resolved",
  );
  open.sort((a, b) => {
    if (a.event.at !== b.event.at) return a.event.at - b.event.at;
    return a.event.id < b.event.id ? -1 : a.event.id > b.event.id ? 1 : 0;
  });
  const originsAtTail = open.filter((episode) => episode.originProven).length;
  return {
    observedStarts,
    observedResolutions,
    unprovenOrigins,
    unprovenResolutions,
    openBeforeBoundary,
    tailAmbiguous,
    openAtTail: tailAmbiguous ? null : open.length,
    provenOriginsAtTail: tailAmbiguous ? null : originsAtTail,
    openTailSampleTruncated: open.length > 16,
    openTailSamples: tailAmbiguous
      ? []
      : open.slice(0, 16).map((episode) => ({
          monitorFingerprint: episode.fingerprint,
          targetId: episode.event.targetId,
          rule: episode.event.rule,
          batchId: episode.batchId,
          eventId: episode.event.id,
          lastEventAt: episode.event.at,
          firingSince: episode.event.firingSince,
          originProven: episode.originProven,
        })),
  };
}
