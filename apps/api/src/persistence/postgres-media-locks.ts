import { collectMediaAssetIds } from "../domain/media-references.ts";

/**
 * Take a shared row lock on every media asset a write is about to reference.
 *
 * This is the writer's half of the protocol that makes `deleteUnusedMediaAsset`
 * safe under READ COMMITTED (issue #156). The deleter scans for references and
 * then deletes — two statements, one transaction — and a save that commits
 * *between* them is a save the scan never sees. The save cannot rely on the
 * deleter's scan and the deleter cannot re-check after the fact, so the two meet
 * on the row: a writer names the assets its content mentions and holds
 * `FOR SHARE` on them until it commits, and a deleter takes `FOR UPDATE` on the
 * asset row before it scans. Whichever arrives second waits:
 *
 * - save first, delete second → the delete waits, sees the committed reference,
 *   and refuses;
 * - delete first, save second → the save waits on the delating row lock, and when
 *   it continues the row it was about to reference is gone, so it fails rather
 *   than publishing a work with a broken image.
 *
 * `FOR SHARE` and not `FOR UPDATE`: two authors saving different works that use
 * the same image must not block each other. Only a delete needs exclusivity.
 *
 * Missing rows are ignored rather than an error: an id extracted from a body may
 * belong to no asset (a hand-written URL, an asset from another deployment), and
 * an existing work that mentions one is not this save's problem to fix. The
 * order is normalised so two concurrent saves cannot deadlock on each other's
 * lock order.
 */
export async function lockMediaAssetReferences(executor, content: unknown): Promise<void> {
  const ids = collectMediaAssetIds(content).sort();
  if (ids.length === 0) return;
  await executor.unsafe("SELECT id FROM media_assets WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE", [ids]);
}

