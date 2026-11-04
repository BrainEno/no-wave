/**
 * The one typed boundary between the PostgreSQL domain slices and postgres.js.
 *
 * `createPostgresClient` loads the driver through a dynamic import so SQLite
 * deployments never require it at runtime. These are `import type` aliases:
 * they disappear at runtime, but every slice now sees a real, narrow executor
 * contract instead of an `any` that would also erase its `satisfies Pick<...>`
 * result checks.
 *
 * The structural interfaces below describe *only* what the slices use — one
 * `unsafe` statement helper plus `begin`/`end` on the pool. Method syntax keeps
 * parameter checks bivariant, so the driver's real `Sql` / `TransactionSql`
 * satisfy them without casts. The conformance check happens at the one place a
 * real `Sql` enters the code: `createPostgresStore(sql)`.
 *
 * Column values stay dynamic by design: `postgres.Row` is the driver's own
 * `[column: string]: any` row shape, and mapping those rows into typed domain
 * records is the job of `postgres-shared.ts` and each slice.
 */
import type { Row, Sql, TransactionSql } from "postgres";

/** A driver row, before a slice maps it into a domain record. */
export type PgRow = Row;

/**
 * The only statement helper shared by slices and migration capture. `TRow`
 * mirrors postgres.js's own `unsafe<T>`: a query that returns a known column
 * set can name its row shape, while the default stays the driver's row.
 */
export interface PgExecutor {
  unsafe<TRow = PgRow>(query: string, parameters?: readonly unknown[]): Promise<TRow[]>;
}

/** The executor handed to a `sql.begin` callback (a subset of the pool). */
export interface PgTransaction extends PgExecutor {}

/** The pool returned by `createPostgresClient`. */
export interface PgDatabase extends PgExecutor {
  begin<T>(work: (tx: PgTransaction) => T | Promise<T>): Promise<T>;
  end(options?: { timeout?: number }): Promise<void>;
}

// Compile-time proof that the real driver satisfies our narrow contract. These
// are type-only assertions: no runtime import, no JS is emitted.
type Assert<T extends true> = T;
type _DriverIsExecutor = Assert<Sql extends PgExecutor ? true : false>;
type _TransactionIsExecutor = Assert<TransactionSql extends PgTransaction ? true : false>;
