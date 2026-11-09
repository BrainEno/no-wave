/**
 * The bundle planner, re-exported for the operator seed.
 *
 * The logic moved into the application layer when `POST /api/v1/imports/notion`
 * arrived: the endpoint and this script must decide "is this page already
 * imported?" the same way, or two runs of the same bundle would disagree. This
 * module stays so the seed's imports keep reading as script code, and so the
 * scripts tsconfig keeps type-checking the surface the seed uses.
 */
export {
  NotionBundleError,
  articleWriteBody,
  draftDigest,
  emptyNotionSeedState,
  groupNotionWorks,
  idempotencyKeyFor,
  parseNotionBundle,
  parseNotionSeedState,
  planNotionSeed,
} from "../../apps/api/src/application/notion-bundle.ts";
export type {
  NotionBundle,
  NotionBundlePage,
  NotionSeedState,
  NotionSeedStatePage,
  NotionWork,
  PlannedEdition,
  PlannedWork,
  SeedPlan,
} from "../../apps/api/src/application/notion-bundle.ts";
