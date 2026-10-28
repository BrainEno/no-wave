# Persistence-provider deployment guidance

## Recommendation

- **Local development, evaluation, and single-host installations:** SQLite is convenient and remains the fresh-install default.
- **Production/server deployments:** prefer PostgreSQL while the API's built-in `node:sqlite` driver is a release-candidate API. PostgreSQL has an independently versioned driver and is the recommended provider for multi-instance deployments and workloads needing server-side concurrency controls.
- **MongoDB:** not currently implemented as a runtime provider. Do not select it for a deployment.

This recommendation does not mean changing `DATABASE_PROVIDER` migrates data. Provider selection only chooses the adapter at process startup. Cross-provider migration requires the separate, reviewed snapshot/change-capture/reconciliation/cutover procedure documented in [the migration plan](../architecture/postgres-migration-plan.md).

## Runtime compatibility notice

This repository pins the supported runtime to Node.js 24 (`>=24 <25`). The official Node.js documentation marks `node:sqlite` as **Stability 1.2 — Release Candidate** starting at Node.js 24.15.0; before that minor release, it is still marked experimental. Release-candidate APIs are not equivalent to Stability 2 stable APIs and may change before stabilization.

At startup the API emits one JSON line containing the selected provider, `process.version`, the SQLite API stability classification (when SQLite is selected), and the deployment recommendation. Treat this as a compatibility notice, not a health check or proof of application compatibility. The tests pin supported binding/result-type assumptions; run the full verification workflow whenever Node.js is upgraded.

Use Node.js 24.15.0 or newer within the supported Node 24 line for the current release-candidate API. Do not suppress a startup notice as a substitute for reviewing an upgrade.

## SQLite operating boundaries

SQLite is intended for a local or single-host deployment with a durable local database path. Keep the database and its WAL/SHM files on the same host and an appropriate local filesystem; do not treat WAL as a cross-host replication or high-availability mechanism. Plan and rehearse backups/restores, control filesystem permissions, monitor disk capacity, and avoid multiple application hosts opening a shared SQLite file over a network filesystem.

Prefer PostgreSQL when production requirements include multiple API instances, independent application hosts, server-managed concurrent writes, or operational needs beyond a single machine. Configure `DATABASE_PROVIDER=postgres` and `DATABASE_URL`, apply reviewed migrations as an explicit release step, and configure least-privilege credentials, TLS, backups, restore drills, connection bounds, and monitoring.

## Re-evaluation and fallback conditions

Revisit the built-in driver decision before a Node major upgrade and before any production release that intends to rely on SQLite. Trigger a new architecture review if:

- Node.js changes or removes the API contract relied on by the adapter;
- the binding/type regression suite fails or reveals a behavior change;
- upstream stabilization is delayed enough that the compatibility risk is no longer acceptable; or
- deployment requirements exceed SQLite's single-host operating profile.

The review may select PostgreSQL for the deployment or evaluate a maintained SQLite driver such as `better-sqlite3`. A driver replacement must include a maintenance/security/license/native-build portability review and pass the existing persistence-adapter contract suite. Do not introduce a new native dependency or switch an existing database in place without an approved migration plan.
