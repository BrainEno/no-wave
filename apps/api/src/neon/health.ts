import postgres from "postgres";

let client: ReturnType<typeof postgres> | undefined;

async function queryDatabase(): Promise<boolean> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is missing.");
  // Reuse the same small pool between warm Function invocations.
  client ??= postgres(connectionString, {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    connection: { application_name: "no-wave-neon-health" },
  });
  const rows = await client`SELECT 1 AS ok`;
  return Number(rows[0]?.ok) === 1;
}

const noStore = { "cache-control": "no-store" } as const;

/**
 * A deliberately read-only, non-sensitive smoke endpoint proving that a Neon
 * Function can query the branch's injected DATABASE_URL. Business API routes
 * remain served by the existing standalone API service.
 */
export function createNeonDatabaseHealthHandler({
  query = queryDatabase,
}: {
  query?: () => Promise<boolean>;
} = {}) {
  return Object.freeze({
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (request.method !== "GET") {
        return Response.json(
          { error: { code: "METHOD_NOT_ALLOWED", message: "Only GET is supported." } },
          { status: 405, headers: { ...noStore, allow: "GET" } },
        );
      }
      if (url.pathname !== "/" && url.pathname !== "/health") {
        return Response.json(
          { error: { code: "NOT_FOUND", message: "The requested route was not found." } },
          { status: 404, headers: noStore },
        );
      }
      try {
        if (!(await query())) throw new Error("Database probe failed.");
        return Response.json(
          { status: "ok", service: "no-wave-neon-health", database: "ok" },
          { status: 200, headers: noStore },
        );
      } catch {
        // Never return the connection string, credentials, SQL errors, or stack.
        return Response.json(
          { status: "not_ready", service: "no-wave-neon-health", database: "unavailable" },
          { status: 503, headers: noStore },
        );
      }
    },
  });
}

export default createNeonDatabaseHealthHandler();
