import {
  assertChangeMatchesEnvelope,
  isMigrationSessionActive,
  MigrationJournalError,
  type MigrationChange,
  type MigrationProvider,
  type MigrationSessionStatus,
} from "./provider-migration-journal.ts";

export type MigrationReplaySession = {
  sessionId: string;
  sourceProvider: MigrationProvider;
  targetProvider: MigrationProvider;
  schemaVersion: string;
  status: MigrationSessionStatus;
  nextSequence: number;
};

type JournalPort = {
  getSession(sessionId: string): Promise<MigrationReplaySession> | MigrationReplaySession;
  createSession(input: { sessionId: string; sourceProvider: MigrationProvider; targetProvider: MigrationProvider; schemaVersion: string }): Promise<unknown> | unknown;
  transitionSession(input: { sessionId: string; expectedStatus: MigrationSessionStatus; nextStatus: MigrationSessionStatus }): Promise<boolean> | boolean;
  getCheckpoint(sessionId: string): Promise<number> | number;
  readChangeBatch(input: { sessionId: string; afterSequence: number; limit?: number }): Promise<MigrationChange[]> | MigrationChange[];
};

export type MigrationReplayTarget = JournalPort & {
  readonly provider: MigrationProvider;
  applyTransaction(changes: readonly MigrationChange[]): Promise<void>;
};

export type ReplayNextBatchResult = {
  sessionId: string;
  startingSequence: number;
  lastSequence: number;
  appliedChanges: number;
  transactions: number;
  remainingAtRead: number;
};

function isSourceReplayable(status: MigrationSessionStatus): boolean {
  return isMigrationSessionActive(status) || status === "stopped";
}

function assertCompatibleSession(source: MigrationReplaySession, target: MigrationReplaySession, targetProvider: MigrationProvider): void {
  if (source.targetProvider !== targetProvider || target.targetProvider !== targetProvider ||
      source.sourceProvider !== target.sourceProvider || source.schemaVersion !== target.schemaVersion) {
    throw new MigrationJournalError("REPLAY_SESSION_MISMATCH", "Source and target migration session settings do not match the replay target.");
  }
  if (!isSourceReplayable(source.status)) throw new MigrationJournalError("SOURCE_SESSION_NOT_REPLAYABLE", "The source session is not in a replayable state.");
  if (!isMigrationSessionActive(target.status)) throw new MigrationJournalError("TARGET_SESSION_NOT_ACTIVE", "The target replay session is not active.");
}

/** Create/activate the matching migration session on the target without altering business data. */
export async function prepareMigrationReplayTarget(input: {
  sourceJournal: JournalPort;
  targetJournal: JournalPort;
  sessionId: string;
  targetProvider: MigrationProvider;
}): Promise<MigrationReplaySession> {
  const source = await input.sourceJournal.getSession(input.sessionId);
  if (source.targetProvider !== input.targetProvider || source.sourceProvider === input.targetProvider) {
    throw new MigrationJournalError("REPLAY_PROVIDER_MISMATCH", "The requested replay target does not match the source session.");
  }
  if (!isSourceReplayable(source.status)) {
    throw new MigrationJournalError("SOURCE_SESSION_NOT_REPLAYABLE", "The source session is not in a replayable state.");
  }
  await input.targetJournal.createSession({
    sessionId: source.sessionId,
    sourceProvider: source.sourceProvider,
    targetProvider: source.targetProvider,
    schemaVersion: source.schemaVersion,
  });
  let target = await input.targetJournal.getSession(input.sessionId);
  if (target.status === "prepared") {
    await input.targetJournal.transitionSession({
      sessionId: input.sessionId,
      expectedStatus: "prepared",
      nextStatus: "recording",
    });
    target = await input.targetJournal.getSession(input.sessionId);
  }
  assertCompatibleSession(source, target, input.targetProvider);
  return target;
}

function groupTransactions(changes: readonly MigrationChange[]): MigrationChange[][] {
  const groups: MigrationChange[][] = [];
  const closed = new Set<string>();
  for (const change of changes) {
    assertChangeMatchesEnvelope(change);
    const current = groups[groups.length - 1];
    if (current?.[0]?.transactionId === change.transactionId) {
      current.push(change);
      continue;
    }
    if (closed.has(change.transactionId)) {
      throw new MigrationJournalError("NON_CONTIGUOUS_TRANSACTION", "A source transaction's journal records are not contiguous.");
    }
    if (current) closed.add(current[0].transactionId);
    groups.push([change]);
  }
  return groups;
}

/**
 * Replay the next ordered batch. Every source transaction envelope is applied
 * and checkpointed atomically by the target adapter; a failed envelope leaves
 * both its business rows and checkpoint unchanged and can be retried.
 */
export async function replayNextMigrationBatch(input: {
  sourceJournal: JournalPort;
  target: MigrationReplayTarget;
  sessionId: string;
  limit?: number;
}): Promise<ReplayNextBatchResult> {
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new MigrationJournalError("INVALID_INPUT", "Replay limit must be between 1 and 1000.");
  }
  const source = await input.sourceJournal.getSession(input.sessionId);
  const targetSession = await input.target.getSession(input.sessionId);
  assertCompatibleSession(source, targetSession, input.target.provider);

  const startingSequence = await input.target.getCheckpoint(input.sessionId);
  const sourceLastSequence = source.nextSequence - 1;
  if (!Number.isSafeInteger(sourceLastSequence) || sourceLastSequence < 0) {
    throw new MigrationJournalError("INVALID_SOURCE_SEQUENCE", "The source migration journal has an invalid sequence allocator.");
  }
  if (startingSequence > sourceLastSequence) {
    throw new MigrationJournalError("TARGET_CHECKPOINT_AHEAD", "The target checkpoint is ahead of the source journal.");
  }
  if (startingSequence === sourceLastSequence) {
    return { sessionId: input.sessionId, startingSequence, lastSequence: startingSequence, appliedChanges: 0, transactions: 0, remainingAtRead: 0 };
  }

  const changes = await input.sourceJournal.readChangeBatch({ sessionId: input.sessionId, afterSequence: startingSequence, limit });
  if (changes.length === 0) {
    throw new MigrationJournalError("SOURCE_SEQUENCE_GAP", "The source sequence allocator indicates changes that cannot be read.");
  }
  let expected = startingSequence + 1;
  for (const change of changes) {
    if (change.sessionId !== input.sessionId || change.sequence !== expected) {
      throw new MigrationJournalError("SOURCE_SEQUENCE_GAP", "The source batch contains a missing or unexpected sequence.");
    }
    expected += 1;
  }

  const groups = groupTransactions(changes);
  let appliedChanges = 0;
  let lastSequence = startingSequence;
  for (const group of groups) {
    await input.target.applyTransaction(group);
    appliedChanges += group.length;
    lastSequence = group[group.length - 1].sequence;
  }

  const checkpoint = await input.target.getCheckpoint(input.sessionId);
  if (checkpoint !== lastSequence) {
    throw new MigrationJournalError("TARGET_CHECKPOINT_MISMATCH", "The target did not commit the expected replay checkpoint.");
  }
  return {
    sessionId: input.sessionId,
    startingSequence,
    lastSequence,
    appliedChanges,
    transactions: groups.length,
    remainingAtRead: Math.max(0, sourceLastSequence - lastSequence),
  };
}
