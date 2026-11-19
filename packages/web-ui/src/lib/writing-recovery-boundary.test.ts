import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { WritingRecoveryBoundary } from "./writing-recovery-boundary.ts";

test("account mutation synchronously invalidates before awaiting disk; only closed metadata crosses tabs", async () => {
  const messages: unknown[] = [],
    order: string[] = [];
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const boundary = new WritingRecoveryBoundary({
    id: randomUUID,
    send: (value) => messages.push(value),
    store: () => ({
      purge: async () => {
        order.push("purge");
        await gate;
      },
      close: () => {
        order.push("close");
      },
    }),
  });
  const stop = boundary.subscribe(() => {
    order.push("hide");
  });
  const clearing = boundary.clearForSessionChange();
  assert.deepEqual(order, ["hide", "purge"]);
  assert.equal(messages.length, 1);
  assert.deepEqual(Object.keys(messages[0] as object).sort(), [
    "source",
    "version",
  ]);
  finish();
  assert.equal(await clearing, null);
  assert.deepEqual(order, ["hide", "purge", "close", "hide"]);
  stop();
  const count = order.length;
  boundary.announce();
  assert.equal(order.length, count);
});

test("malformed or credential-bearing cross-tab messages cannot inject text or trigger storage actions", () => {
  let notices = 0;
  const boundary = new WritingRecoveryBoundary({
    id: randomUUID,
    send: () => {},
    store: () => {
      throw new Error("not a request channel");
    },
  });
  boundary.subscribe(() => {
    notices++;
  });
  for (const value of [
    null,
    "clear",
    { version: 2, source: randomUUID() },
    { version: 1, source: "bad" },
    { version: 1, source: randomUUID(), backup: "private" },
    { version: 1, source: randomUUID(), token: "synthetic" },
  ])
    boundary.receive(value);
  assert.equal(notices, 0);
  boundary.receive({ version: 1, source: randomUUID() });
  assert.equal(notices, 1);
});

test("disk deletion failure remains visible, closes the handle and never revives a tab when broadcast is blocked", async () => {
  let hidden = 0,
    closed = 0;
  const boundary = new WritingRecoveryBoundary({
    id: randomUUID,
    send: () => {
      throw new DOMException("disabled", "SecurityError");
    },
    store: () => ({
      purge: () =>
        Promise.reject(new DOMException("disabled", "SecurityError")),
      close: () => {
        closed++;
      },
    }),
  });
  boundary.subscribe(() => {
    hidden++;
  });
  assert.match((await boundary.clearForSessionChange())!, /未能清除/);
  assert.equal(hidden, 2);
  assert.equal(closed, 1);
});

test("missing secure random identifiers cannot prevent local invalidation or an attempted logout purge", async () => {
  let hidden = 0,
    purged = 0;
  const boundary = new WritingRecoveryBoundary({
    id: () => {
      throw new Error("randomUUID unavailable");
    },
    send: () => {
      throw new Error("must not send an invented identifier");
    },
    store: () => ({
      purge: async () => {
        purged++;
      },
      close: () => {},
    }),
  });
  boundary.subscribe(() => {
    hidden++;
  });
  assert.equal(await boundary.clearForSessionChange(), null);
  assert.equal(purged, 1);
  assert.equal(hidden, 2);
});

test("an account mutation fences both sides: a newly opened tab writing during the request cannot leave cache behind after logout", async () => {
  let manuscripts = ["before"],
    purges = 0;
  const warnings: (string | null)[] = [];
  const boundary = new WritingRecoveryBoundary({
    id: randomUUID,
    send: () => {},
    store: () => ({
      purge: async () => {
        manuscripts = [];
        purges++;
      },
      close: () => {},
    }),
  });
  const result = await boundary.runSessionChange(
    async () => {
      assert.equal(manuscripts.length, 0);
      manuscripts.push("new tab opened before the logout response");
      return "cookie transition completed";
    },
    (warning) => warnings.push(warning),
  );
  assert.equal(result, "cookie transition completed");
  assert.deepEqual(manuscripts, []);
  assert.equal(purges, 2);
  assert.deepEqual(warnings, [null, null]);
  await assert.rejects(
    boundary.runSessionChange(async () => {
      manuscripts.push("ambiguous auth response");
      throw new Error("transport failed");
    }),
    /transport failed/,
  );
  assert.deepEqual(manuscripts, []);
  assert.equal(purges, 4);
});

test("either boundary's deletion failure stays visible, without suppressing the account request or its failure", async () => {
  for (const failAt of [1, 2]) {
    let purges = 0,
      requests = 0;
    const warnings: (string | null)[] = [];
    const boundary = new WritingRecoveryBoundary({
      id: randomUUID,
      send: () => {},
      store: () => ({
        purge: async () => {
          if (++purges === failAt)
            throw new DOMException("blocked", "SecurityError");
        },
        close: () => {},
      }),
    });
    await assert.rejects(
      boundary.runSessionChange(
        async () => {
          requests++;
          throw new Error("ambiguous auth response");
        },
        (warning) => warnings.push(warning),
      ),
      /ambiguous auth response/,
    );
    assert.equal(requests, 1);
    assert.equal(purges, 2);
    assert.match(warnings.at(-1)!, /未能清除/);
  }
});
