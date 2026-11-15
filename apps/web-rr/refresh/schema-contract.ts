import type { TransactionSql } from "postgres";
import { RefreshCoordinationError } from "./errors.ts";

const columns: Readonly<Record<string, Readonly<Record<string, readonly [string, boolean]>>>> = {
  web_refresh_coordinator_policy: { namespace: ["text", true], key_fingerprint: ["text", true], policy: ["text", true], upstream_fingerprint: ["text", false] },
  web_refresh_coordination: { namespace: ["text", true], generation_key: ["text", true], owner: ["uuid", true], state: ["text", true],
    work_deadline: ["timestamp with time zone", true], expires_at: ["timestamp with time zone", true],
    result_until: ["timestamp with time zone", false], sealed_result: ["text", false] },
};

/** Reject filtered/incompatible coordination tables rather than losing fences. */
export async function assertRefreshSchema(tx: TransactionSql): Promise<void> {
  const [transaction] = await tx`SELECT current_setting('transaction_read_only') AS read_only`;
  if (transaction.read_only !== "off") throw new RefreshCoordinationError("policy");
  for (const [table, expected] of Object.entries(columns)) {
    const [relation] = await tx`SELECT c.oid, c.relkind, c.relpersistence, c.relrowsecurity, c.relforcerowsecurity, n.nspname,
      has_table_privilege(c.oid, 'SELECT') AS can_read,
      has_table_privilege(c.oid, 'INSERT') AS can_insert,
      has_table_privilege(c.oid, 'UPDATE') AS can_update,
      has_table_privilege(c.oid, 'DELETE') AS can_delete,
      CASE WHEN c.relname = 'web_refresh_coordinator_policy' THEN has_column_privilege(c.oid, 'upstream_fingerprint', 'UPDATE') ELSE true END AS can_bind_upstream
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = to_regclass(${table})`;
    if (!relation || relation.relkind !== "r" || relation.relpersistence !== "p" || relation.relrowsecurity || relation.relforcerowsecurity ||
        String(relation.nspname).startsWith("pg_") || !relation.can_read || !relation.can_bind_upstream ||
        (table === "web_refresh_coordination" && (!relation.can_insert || !relation.can_update || !relation.can_delete))) {
      throw new RefreshCoordinationError("policy");
    }
    const [hooks] = await tx`SELECT
      (SELECT count(*) FROM pg_trigger WHERE tgrelid = ${relation.oid}::oid AND NOT tgisinternal AND tgenabled <> 'D') +
      (SELECT count(*) FROM pg_rewrite WHERE ev_class = ${relation.oid}::oid AND ev_enabled <> 'D') AS count`;
    if (Number(hooks.count) !== 0) throw new RefreshCoordinationError("policy");
    const attributes = await tx`SELECT attname, format_type(atttypid, atttypmod) AS type, attnotnull FROM pg_attribute
      WHERE attrelid = ${relation.oid}::oid AND attnum > 0 AND NOT attisdropped`;
    if (attributes.length !== Object.keys(expected).length) throw new RefreshCoordinationError("policy");
    for (const attribute of attributes) {
      const definition = expected[String(attribute.attname)];
      if (!definition || definition[0] !== attribute.type || definition[1] !== attribute.attnotnull) throw new RefreshCoordinationError("policy");
    }
    const primary = await tx`SELECT a.attname FROM pg_constraint c
      CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, position)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      WHERE c.conrelid = ${relation.oid}::oid AND c.contype = 'p' AND c.convalidated AND NOT c.condeferrable ORDER BY k.position`;
    const required = table === "web_refresh_coordination" ? ["namespace", "generation_key"] : ["namespace"];
    if (JSON.stringify(primary.map(row => row.attname)) !== JSON.stringify(required)) throw new RefreshCoordinationError("policy");
    const [invalid] = await tx`SELECT count(*)::integer AS count FROM pg_index WHERE indrelid = ${relation.oid}::oid AND (NOT indisvalid OR NOT indisready)`;
    if (Number(invalid.count) !== 0) throw new RefreshCoordinationError("policy");
  }
}
