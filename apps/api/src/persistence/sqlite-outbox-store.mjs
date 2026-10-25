/** SQLite transactional outbox store with lease-based claims and retry scheduling. */
export function createSqliteOutboxStore(db) {
  if (!db || typeof db.prepare !== "function" || typeof db.exec !== "function") throw new TypeError("A SQLite database connection is required.");
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  function requiredEventId(eventId) {
    if (typeof eventId !== "string" || eventId.trim().length === 0 || eventId !== eventId.trim()) throw new TypeError("eventId must be a non-empty, trimmed string.");
  }
  return Object.freeze({
    async claimOutboxEvents({ limit = 25, leaseSeconds = 60 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError("limit must be an integer between 1 and 100.");
      if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3600) throw new TypeError("leaseSeconds must be an integer between 1 and 3600.");
      const now = Date.now(), leaseUntil = new Date(now + leaseSeconds * 1000).toISOString(), nowIso = new Date(now).toISOString();
      db.exec("BEGIN IMMEDIATE");
      try {
        const candidates = all("SELECT id FROM outbox_events WHERE delivered_at IS NULL AND available_at <= ? ORDER BY created_at,id LIMIT ?", nowIso, limit);
        const update = db.prepare("UPDATE outbox_events SET attempts=attempts+1,available_at=? WHERE id=? AND delivered_at IS NULL AND available_at <= ?");
        const claimed = [];
        for (const item of candidates) {
          const result = update.run(leaseUntil, item.id, nowIso);
          if (!result.changes) continue;
          const row = get("SELECT id,event_key,event_type,aggregate_id,payload,attempts,available_at FROM outbox_events WHERE id=?", item.id);
          if (row) claimed.push({ ...row, payload: JSON.parse(row.payload), attempts: Number(row.attempts), available_at: new Date(row.available_at).toISOString() });
        }
        db.exec("COMMIT");
        return claimed;
      } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
    },
    async markOutboxDelivered({ eventId }) {
      requiredEventId(eventId);
      return run("UPDATE outbox_events SET delivered_at=? WHERE id=? AND delivered_at IS NULL", new Date().toISOString(), eventId).changes === 1;
    },
    async rescheduleOutboxEvent({ eventId, delaySeconds = 30 }) {
      requiredEventId(eventId);
      if (!Number.isInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > 86400) throw new TypeError("delaySeconds must be an integer between 1 and 86400.");
      return run("UPDATE outbox_events SET available_at=? WHERE id=? AND delivered_at IS NULL", new Date(Date.now() + delaySeconds * 1000).toISOString(), eventId).changes === 1;
    },
  });
}
