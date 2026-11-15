import { createServer } from "vite";

// Loads the real vite.config.ts, including both native ingress plugins and SSR.
const server = await createServer({ server: { port: 0, strictPort: true } });
await server.listen();
const address = server.httpServer?.address();
if (!address || typeof address === "string") throw new Error("No development fixture port.");
process.stdout.write(JSON.stringify({ event: "refresh_fixture_listening", port: address.port }) + "\n");
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  void server.close().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; });
});
