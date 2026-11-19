import {
  MonitorFault, type MonitorConfig, type MonitorState,
} from "../application/operational-monitor.ts";
import { parseMonitorState } from "../application/operational-monitor-state.ts";
import { reconfigureMonitor } from "../application/operational-monitor-configure.ts";
import { parseMonitorConfig } from "./monitor-config.ts";
import {
  PrivateOperationFault, openPrivateOperationJournal, readPrivateOperationFile, readPrivateOperationSnapshot,
} from "./private-operation-file.ts";

export const MONITOR_STATE_MAX_BYTES = 4 * 1024 * 1024;
function monitorFailure(error: unknown): never {
  if (error instanceof MonitorFault) throw error;
  if (error instanceof PrivateOperationFault && error.code !== "artifact_conflict") throw new MonitorFault(error.code);
  throw new MonitorFault("state_io");
}
export function readMonitorConfigFile(path: string): MonitorConfig {
  try {
    const bytes = readPrivateOperationFile(path, { maximum: 65_536, privateFile: false })!;
    return parseMonitorConfig(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch { throw new MonitorFault("config_invalid"); }
}
export function readMonitorJournal(value: string, config: MonitorConfig): MonitorState | null {
  try {
    const snapshot = readPrivateOperationSnapshot(value, MONITOR_STATE_MAX_BYTES);
    return snapshot === null ? null : parseMonitorState(snapshot.value, config);
  } catch (error) { return monitorFailure(error); }
}

/** Monitor semantics remain here; the private POSIX transaction is shared with
 * offline alert handoff rather than copied into another independent journal. */
export function openMonitorJournal(value: string, config: MonitorConfig) {
  try {
    const journal = openPrivateOperationJournal(value, {
      maximum: MONITOR_STATE_MAX_BYTES,
      parse: value => parseMonitorState(value, config),
      revision: state => state.revision,
    });
    let activeConfig = config;
    function persist(value: unknown, nextConfig: MonitorConfig): void {
      try {
        const next = parseMonitorState(value, nextConfig), current = journal.state;
        const identical = current !== null && JSON.stringify(current) === JSON.stringify(next);
        if (!identical && (next.lastEvaluatedAt === null || (current?.lastEvaluatedAt !== null &&
            current?.lastEvaluatedAt !== undefined && next.lastEvaluatedAt < current.lastEvaluatedAt)))
          throw new MonitorFault("state_invalid");
        journal.commit(next, value => parseMonitorState(value, nextConfig));
        activeConfig = nextConfig;
      } catch (error) { monitorFailure(error); }
    }
    return Object.freeze({
      get state() { return journal.state; },
      commit(value: unknown) { persist(value, activeConfig); },
      reconfigure(nextConfig: MonitorConfig, now: number) {
        if (journal.state === null) throw new MonitorFault("state_missing");
        const result = reconfigureMonitor(activeConfig, nextConfig, journal.state, now);
        persist(result.state, nextConfig);
        return result;
      },
      close() { try { journal.close(); } catch (error) { monitorFailure(error); } },
    });
  } catch (error) { return monitorFailure(error); }
}
