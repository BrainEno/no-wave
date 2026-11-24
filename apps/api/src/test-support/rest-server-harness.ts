/**
 * Shared fixtures for the REST server suites (`apps/api/src/server*.test.ts`).
 * Not a test file: node:test discovers only `*.test.ts`.
 */
import { createHmac } from "node:crypto";
import { createApiServer } from "../server.ts";
import { persistencePortMethods } from "../application/persistence-ports.ts";
import type { PersistenceAdapterContract } from "../application/persistence-ports.ts";

/** Options accepted by {@link withServer}; `store` may be a partial fake. */
type ApiServerOptions = NonNullable<Parameters<typeof createApiServer>[0]>;
export type ServerHarnessOptions = Partial<Omit<ApiServerOptions, "store">> & {
  store?: Partial<PersistenceAdapterContract>;
};

/**
 * Mail is enabled for this suite: the recovery and verification tests below are
 * about what those endpoints do when they work. The switch itself — off unless
 * an operator turns it on, and 503 while it is off — has its own test.
 */
export const authEnv = {
  AUTH_JWT_SECRET: "test-only-secret-that-is-at-least-32-bytes",
  AUTH_JWT_ISSUER: "https://auth.example.test",
  AUTH_JWT_AUDIENCE: "bot-thk-api",
  MAIL_ENABLED: "true",
  // Media deletion is off by default since #156; these tests exercise the delete
  // path itself, so they opt in. The default and the rejection have their own
  // test below — opting in everywhere without one would leave the switch
  // unverified.
  MEDIA_DELETE_ENABLED: "true",
};

/**
 * A token with two *different* identifiers, the way the API issues them: `sid`
 * is the session the token was minted from, `jti` is this individual token.
 * A test that mixes them up then fails instead of passing by coincidence.
 */
export function signedToken(sub: string): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({
    alg: "HS256",
    typ: "application/vnd.bot-thk.access+jwt",
  });
  const payload = encode({
    sub,
    iss: authEnv.AUTH_JWT_ISSUER,
    aud: authEnv.AUTH_JWT_AUDIENCE,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60,
    sid: `session-${sub}`,
    jti: `token-${sub}`,
  });
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${createHmac("sha256", authEnv.AUTH_JWT_SECRET).update(unsigned).digest("base64url")}`;
}

export function completeFakeAdapter(
  overrides: Record<string, unknown> = {},
): PersistenceAdapterContract {
  const adapter: Record<string, unknown> = {
    async health() {
      return true;
    },
    async outboxBacklog() {
      return { pendingEvents: 0, deadLetterEvents: 0, oldestPendingAgeMs: 0 };
    },
  };
  for (const methods of Object.values(persistencePortMethods)) {
    for (const method of methods) {
      if (typeof adapter[method] !== "function") {
        adapter[method] =
          method === "consumeRateLimit"
            ? async () => ({
                allowed: true,
                resetAt: new Date(Date.now() + 60000).toISOString(),
              })
            : async () => null;
      }
    }
  }
  // The fake implements only the methods a test needs plus every port method as a default,
  // so it is deliberately partial; the cast states that once, here.
  return Object.assign(
    adapter,
    overrides,
  ) as unknown as PersistenceAdapterContract;
}

export async function withServer(
  run: (baseUrl: string) => Promise<unknown>,
  options: ServerHarnessOptions = {},
): Promise<void> {
  const { store, ...rest } = options;
  const server = createApiServer({
    ...rest,
    store: store ? completeFakeAdapter(store) : store,
    logger: rest.logger ?? (() => {}),
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the test server has no TCP address");
  }
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
