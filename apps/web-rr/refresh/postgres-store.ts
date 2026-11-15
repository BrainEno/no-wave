import { createHash } from "node:crypto";
import postgres, { type Sql, type TransactionSql } from "postgres";
import { RefreshCoordinationError } from "./errors.ts";
import { BoundedRefreshGate } from "./work-gate.ts";
import { assertRefreshSchema } from "./schema-contract.ts";
import { RefreshDatabaseCircuit, type RefreshCircuitSnapshot } from "./database-circuit.ts";
import { REFRESH_NOTIFY_CHANNEL, RefreshChangeFeed, refreshWakeupPayload, type RefreshWatch } from "./change-feed.ts";
import { REFRESH_UNCERTAIN_RETENTION_MS, refreshClusterPolicy, type RefreshSettings } from "./settings.ts";

export type SharedRefreshRow = Readonly<{
  key: string; owner: string; state: "pending" | "resolved" | "uncertain";
  workDeadline: number; expiresAt: number; resultUntil: number | null; sealed: string | null;
}>;
export type RefreshStorageSnapshot = Readonly<{ entries: number; pending: number; resolved: number; uncertain: number; overdue: number; expired: number;
  oldestPendingAgeSeconds: number; oldestUncertainAgeSeconds: number; capturedAtSeconds: number }>;
export type RefreshStoreRuntimeSnapshot = Readonly<{ active: number; queued: number; circuit: RefreshCircuitSnapshot["state"]; failures: number;
  retryAfterMs: number; notificationKeys: number; notificationWaiters: number; notificationIgnored: number }>;
export type RefreshClaim = Readonly<{ owner: boolean; row: SharedRefreshRow; now: number }>;
export type RefreshStore = {
  verify(): Promise<void>;
  watch?(key: string): RefreshWatch;
  claim(key: string, owner: string, endpoint: string): Promise<RefreshClaim>;
  read(key: string): Promise<{ row: SharedRefreshRow | null; now: number }>;
  complete(input: { key: string; owner: string; sealed: string; resultUntil: number; uncertain: boolean }): Promise<boolean>;
  markUncertain(key: string, owner: string): Promise<void>;
  sweep(limit?: number): Promise<number>;
  close(): Promise<boolean>;
};

function milliseconds(value: unknown): number {
  const parsed = value instanceof Date ? value.getTime() : typeof value === "string" && !/^\d+$/.test(value) ? Date.parse(value) : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new RefreshCoordinationError("database");
  return parsed;
}
function storedRow(value: Record<string, unknown>): SharedRefreshRow {
  if (typeof value.generation_key !== "string" || !/^[a-f0-9]{64}$/.test(value.generation_key) ||
      typeof value.owner !== "string" || !/^[a-f0-9-]{36}$/.test(value.owner) ||
      !["pending", "resolved", "uncertain"].includes(String(value.state))) throw new RefreshCoordinationError("database");
  return { key: value.generation_key, owner: value.owner, state: value.state as SharedRefreshRow["state"],
    workDeadline: milliseconds(value.work_deadline), expiresAt: milliseconds(value.expires_at),
    resultUntil: value.result_until === null ? null : milliseconds(value.result_until),
    sealed: value.sealed_result === null ? null : String(value.sealed_result) };
}

/** PostgreSQL is only a Web coordination store, not another identity authority. */
export class PostgresRefreshStore implements RefreshStore {
  private readonly sql: Sql;
  private readonly gate: BoundedRefreshGate;
  private readonly circuit = new RefreshDatabaseCircuit();
  private readonly feed: RefreshChangeFeed;
  private readonly settings: RefreshSettings;
  private readonly fingerprint: string;
  private closing: Promise<boolean> | undefined;

  constructor(settings: RefreshSettings, fingerprint: string) {
    this.settings = settings;
    this.fingerprint = fingerprint;
    this.gate = new BoundedRefreshGate(settings.databaseConcurrency, settings.maxPending);
    this.sql = postgres(settings.databaseUrl, { max: settings.databaseConcurrency, prepare: false,
      connect_timeout: Math.max(1, Math.ceil(settings.driverTimeoutMs / 1000)), idle_timeout: 20,
      connection: { application_name: "no-wave-web-refresh", statement_timeout: settings.driverTimeoutMs,
        lock_timeout: settings.driverTimeoutMs, idle_in_transaction_session_timeout: settings.driverTimeoutMs * 2 },
      onnotice: () => {},
    });
    this.feed = new RefreshChangeFeed({ namespace: settings.namespace, maxKeys: settings.maxPending, timeoutMs: settings.driverTimeoutMs,
      listen: (channel, notify, connected) => this.sql.listen(channel, notify, connected) });
  }

  private async transaction<Value>(work: (tx: TransactionSql) => Promise<Value>): Promise<Value> {
    return this.circuit.run(async () => {
      try {
        return await this.gate.run(async () => await this.sql.begin(async tx => {
          // A database/role default of asynchronous commit must never acknowledge
          // ownership before its WAL is durable, then spend a one-time token.
          await tx`SET LOCAL synchronous_commit = 'on'`;
          return work(tx);
        }) as Value, this.settings.driverTimeoutMs);
      } catch (error) {
        if (error instanceof RefreshCoordinationError) throw error;
        throw new RefreshCoordinationError("database");
      }
    });
  }

  private async assertPolicy(tx: TransactionSql): Promise<void> {
    const [policy] = await tx`SELECT key_fingerprint, policy FROM web_refresh_coordinator_policy WHERE namespace = ${this.settings.namespace}`;
    if (!policy || policy.key_fingerprint !== this.fingerprint || policy.policy !== refreshClusterPolicy(this.settings)) {
      throw new RefreshCoordinationError("policy");
    }
  }

  /** Explicit operator command only. Normal startup never performs DDL. */
  async migrate(): Promise<void> {
    await this.transaction(async tx => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('no-wave/shared-refresh/schema/v1'))`;
      await tx`CREATE TABLE IF NOT EXISTS web_refresh_coordinator_policy (
        namespace text PRIMARY KEY CHECK (namespace ~ '^[a-z][a-z0-9_-]{0,47}$'),
        key_fingerprint text NOT NULL CHECK (key_fingerprint ~ '^[a-f0-9]{64}$'),
        policy text NOT NULL CHECK (octet_length(policy) <= 1024),
        upstream_fingerprint text CHECK (upstream_fingerprint ~ '^[a-f0-9]{64}$')
      )`;
      await tx`CREATE TABLE IF NOT EXISTS web_refresh_coordination (
        namespace text NOT NULL REFERENCES web_refresh_coordinator_policy(namespace),
        generation_key text NOT NULL CHECK (generation_key ~ '^[a-f0-9]{64}$'),
        owner uuid NOT NULL,
        state text NOT NULL CHECK (state IN ('pending', 'resolved', 'uncertain')),
        work_deadline timestamptz NOT NULL,
        expires_at timestamptz NOT NULL,
        result_until timestamptz,
        sealed_result text CHECK (octet_length(sealed_result) <= 22000),
        PRIMARY KEY (namespace, generation_key),
        CHECK ((result_until IS NULL) = (sealed_result IS NULL)),
        CHECK (state <> 'resolved' OR sealed_result IS NOT NULL),
        CHECK (state <> 'pending' OR sealed_result IS NULL),
        CHECK (result_until IS NULL OR result_until <= expires_at)
      )`;
      await tx`CREATE INDEX IF NOT EXISTS web_refresh_coordination_expiry ON web_refresh_coordination(namespace, expires_at)`;
      await tx`INSERT INTO web_refresh_coordinator_policy(namespace, key_fingerprint, policy)
        VALUES (${this.settings.namespace}, ${this.fingerprint}, ${refreshClusterPolicy(this.settings)}) ON CONFLICT DO NOTHING`;
      await this.assertPolicy(tx);
      await assertRefreshSchema(tx);
    });
  }

  async verify(): Promise<void> {
    await this.transaction(async tx => {
      await this.assertPolicy(tx);
      await assertRefreshSchema(tx);
      await tx`SELECT generation_key FROM web_refresh_coordination WHERE namespace = ${this.settings.namespace} LIMIT 1`;
    });
    await this.feed.start();
  }

  watch(key: string): RefreshWatch { return this.feed.watch(key); }

  async claim(key: string, owner: string, endpoint: string): Promise<RefreshClaim> {
    let address: URL;
    try { address = new URL(endpoint); } catch { throw new RefreshCoordinationError("policy"); }
    if (typeof endpoint !== "string" || endpoint.length > 2048 || !["http:", "https:"].includes(address.protocol) ||
        address.username || address.password || address.search || address.hash || address.toString() !== endpoint ||
        !address.pathname.endsWith("/api/v1/auth/refresh")) throw new RefreshCoordinationError("policy");
    const upstreamFingerprint = createHash("sha256").update("no-wave/shared-refresh/upstream/v1\0").update(endpoint).digest("hex");
    if (!/^[a-f0-9]{64}$/.test(key) || !/^[a-f0-9-]{36}$/.test(owner)) throw new RefreshCoordinationError("invalid-result");
    return this.transaction(async tx => {
      // The transaction lock protects BOTH the row claim and namespace capacity.
      // It is released before HTTP; a committed marker owns that uncertain gap.
      await tx`SELECT pg_advisory_xact_lock(hashtext('no-wave/shared-refresh/claim/v1'), hashtext(${this.settings.namespace}))`;
      await this.assertPolicy(tx);
      // The first actual, canonical BFF endpoint binds the namespace. Replicas
      // using two DNS/base-path aliases must fail closed rather than create two
      // generation hashes for the same one-time credential and revoke a family.
      const bound = await tx`UPDATE web_refresh_coordinator_policy SET upstream_fingerprint = ${upstreamFingerprint}
        WHERE namespace = ${this.settings.namespace} AND (upstream_fingerprint IS NULL OR upstream_fingerprint = ${upstreamFingerprint}) RETURNING namespace`;
      if (bound.length !== 1) throw new RefreshCoordinationError("policy");
      const [clock] = await tx`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms`;
      const now = milliseconds(clock.now_ms);
      const [existing] = await tx`SELECT * FROM web_refresh_coordination WHERE namespace = ${this.settings.namespace} AND generation_key = ${key}`;
      if (existing && milliseconds(existing.expires_at) > now) return { owner: false, row: storedRow(existing), now };
      if (existing) await tx`DELETE FROM web_refresh_coordination WHERE namespace = ${this.settings.namespace} AND generation_key = ${key}`;
      const [capacity] = await tx`SELECT count(*)::integer AS entries FROM web_refresh_coordination WHERE namespace = ${this.settings.namespace}`;
      if (Number(capacity.entries) >= this.settings.maxEntries) throw new RefreshCoordinationError("capacity");
      const workDeadline = now + this.settings.rotationTimeoutMs;
      const expiresAt = now + REFRESH_UNCERTAIN_RETENTION_MS;
      const [created] = await tx`INSERT INTO web_refresh_coordination(namespace, generation_key, owner, state, work_deadline, expires_at)
        VALUES (${this.settings.namespace}, ${key}, ${owner}, 'pending', ${new Date(workDeadline)}, ${new Date(expiresAt)}) RETURNING *`;
      return { owner: true, row: storedRow(created), now };
    });
  }

  async read(key: string): Promise<{ row: SharedRefreshRow | null; now: number }> {
    return this.transaction(async tx => {
      const [clock] = await tx`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms`;
      const [row] = await tx`SELECT * FROM web_refresh_coordination WHERE namespace = ${this.settings.namespace} AND generation_key = ${key}`;
      return { row: row ? storedRow(row) : null, now: milliseconds(clock.now_ms) };
    });
  }

  async complete(input: { key: string; owner: string; sealed: string; resultUntil: number; uncertain: boolean }): Promise<boolean> {
    return this.transaction(async tx => {
      const rows = await tx`UPDATE web_refresh_coordination SET state = ${input.uncertain ? "uncertain" : "resolved"},
        sealed_result = ${input.sealed}, result_until = ${new Date(input.resultUntil)},
        expires_at = CASE WHEN ${input.uncertain} THEN expires_at ELSE ${new Date(input.resultUntil)} END
        WHERE namespace = ${this.settings.namespace} AND generation_key = ${input.key} AND owner = ${input.owner}::uuid
          AND state = 'pending' AND work_deadline > clock_timestamp() RETURNING generation_key`;
      if (rows.length === 1) await tx`SELECT pg_notify(${REFRESH_NOTIFY_CHANNEL}, ${refreshWakeupPayload(this.settings.namespace, input.key)})`;
      return rows.length === 1;
    });
  }

  async markUncertain(key: string, owner: string): Promise<void> {
    await this.transaction(async tx => {
      const rows = await tx`UPDATE web_refresh_coordination SET state = 'uncertain'
        WHERE namespace = ${this.settings.namespace} AND generation_key = ${key} AND owner = ${owner}::uuid AND state = 'pending' RETURNING generation_key`;
      if (rows.length) await tx`SELECT pg_notify(${REFRESH_NOTIFY_CHANNEL}, ${refreshWakeupPayload(this.settings.namespace, key)})`;
    });
  }

  async inspect(): Promise<RefreshStorageSnapshot> {
    return this.transaction(async tx => {
      await this.assertPolicy(tx);
      await assertRefreshSchema(tx);
      const [row] = await tx`SELECT count(*)::integer AS entries,
        count(*) FILTER (WHERE state = 'pending')::integer AS pending,
        count(*) FILTER (WHERE state = 'resolved')::integer AS resolved,
        count(*) FILTER (WHERE state = 'uncertain')::integer AS uncertain,
        count(*) FILTER (WHERE state = 'pending' AND work_deadline <= clock_timestamp())::integer AS overdue,
        count(*) FILTER (WHERE expires_at <= clock_timestamp())::integer AS expired,
        GREATEST(0, COALESCE(extract(epoch FROM clock_timestamp() - min(work_deadline) FILTER (WHERE state = 'pending')) + ${this.settings.rotationTimeoutMs / 1000}, 0))::double precision AS pending_age,
        GREATEST(0, COALESCE(extract(epoch FROM clock_timestamp() - min(work_deadline) FILTER (WHERE state = 'uncertain')) + ${this.settings.rotationTimeoutMs / 1000}, 0))::double precision AS uncertain_age,
        extract(epoch FROM clock_timestamp())::double precision AS captured_at
        FROM web_refresh_coordination WHERE namespace = ${this.settings.namespace}`;
      const nonnegative = (value: unknown): number => {
        const number = Number(value);
        if (!Number.isFinite(number) || number < 0) throw new RefreshCoordinationError("database");
        return number;
      };
      const counts = [row.entries, row.pending, row.resolved, row.uncertain, row.overdue, row.expired].map(nonnegative);
      if (counts.some(value => !Number.isSafeInteger(value))) throw new RefreshCoordinationError("database");
      if (counts[0] !== counts[1]! + counts[2]! + counts[3]! || counts[4]! > counts[1]! || counts[5]! > counts[0]!) throw new RefreshCoordinationError("database");
      return { entries: counts[0]!, pending: counts[1]!, resolved: counts[2]!, uncertain: counts[3]!, overdue: counts[4]!, expired: counts[5]!,
        oldestPendingAgeSeconds: nonnegative(row.pending_age), oldestUncertainAgeSeconds: nonnegative(row.uncertain_age), capturedAtSeconds: nonnegative(row.captured_at) };
    });
  }

  async sweep(limit = 256): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1024) throw new RangeError("Invalid shared refresh sweep limit.");
    return this.transaction(async tx => {
      const removed = await tx`DELETE FROM web_refresh_coordination WHERE (namespace, generation_key) IN (
        SELECT namespace, generation_key FROM web_refresh_coordination
        WHERE namespace = ${this.settings.namespace} AND expires_at <= clock_timestamp()
        ORDER BY expires_at, generation_key LIMIT ${limit} FOR UPDATE SKIP LOCKED
      ) RETURNING generation_key`;
      return removed.length;
    });
  }

  snapshot(): RefreshStoreRuntimeSnapshot {
    const gate = this.gate.snapshot(), circuit = this.circuit.snapshot(), feed = this.feed.snapshot();
    return { active: gate.active, queued: gate.queued, circuit: circuit.state, failures: circuit.failures, retryAfterMs: circuit.retryAfterMs,
      notificationKeys: feed.keys, notificationWaiters: feed.waiters, notificationIgnored: feed.ignored };
  }

  close(): Promise<boolean> {
    if (this.closing) return this.closing;
    this.feed.close();
    this.circuit.close();
    this.gate.close();
    this.closing = (async () => {
      const drained = await this.gate.drain(this.settings.driverTimeoutMs);
      try { await this.sql.end({ timeout: 1 }); return drained; } catch { return false; }
    })();
    return this.closing;
  }
}
