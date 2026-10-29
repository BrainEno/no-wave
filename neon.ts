/**
 * Neon resources used by no-wave.
 *
 * The Neon CLI validates this default export using its own config loader, so the
 * application workspace does not need an additional @neon/config runtime dependency.
 * Keep bucket/function declarations here as the source of truth for provisioned
 * services. PostgreSQL itself is present on every Neon project.
 */
export default {
  // Keep uploaded user media private; the existing API proxies access checks.
  buckets: {
    media: { access: "private" },
  },
  functions: {
    health: {
      name: "No Wave database health",
      source: "./apps/api/src/neon/health.ts",
    },
  },
  // Provision Realtime now; client subscriptions should be added with explicit
  // row-level authorization and a product-level live-update contract.
  preview: {
    realtime: true,
  },
};
