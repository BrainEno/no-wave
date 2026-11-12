import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { ImportConflictError, ImportPlanInvalidError } from "../domain/errors.ts";
import type { StoredArticle, StoredExternalContentLink } from "./persistence-ports.ts";

export const NOTION_IMPORT_PLAN_TTL_MS = 15 * 60 * 1000;
export const MAX_NOTION_PLAN_TOKEN_BYTES = 512 * 1024;

/** All source locales (including absence) and the primary create-key recovery. */
export type NotionImportWorkExpectation = {
  key: string;
  sourceIds: string[];
  links: StoredExternalContentLink[];
  createKey: string;
  createKeyArticleId: string | null;
  article: { id: string; revision: string } | null;
};
export type NotionImportPlan = {
  version: 1;
  actorId: string;
  bundleHash: string;
  /** Database-local and deliberately excluded from provider transfer/replay. */
  generation: string;
  issuedAt: number;
  expiresAt: number;
  works: NotionImportWorkExpectation[];
};
export type NotionImportEditionWrite = {
  externalId: string;
  locale: string;
  title: string;
  summary: string;
  contentBlocks: unknown[];
  contentBlocksVersion: number;
  workType: string;
  publish: boolean;
  tags: string[];
  /** Null means derive and uniquify the primary edition's address. */
  requestedSlug: string | null;
  digest: string;
  syncedAt: string;
};
export type CommitNotionImportWorkInput = {
  actorId: string;
  generation: string;
  expiresAt: number;
  expected: NotionImportWorkExpectation;
  editions: NotionImportEditionWrite[];
};
export type CommittedNotionImportEdition = { externalId: string; article: StoredArticle; created: boolean };

/** Key order is irrelevant; page/block/selection order is not. Includes unmapped fields. */
export function notionBundleHash(bundle: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
    }
    return value;
  };
  return createHash("sha256").update(JSON.stringify(canonical(bundle))).digest("hex");
}

/** Domain-separated from access JWTs, even when using the same configured secret. */
export function createNotionImportPlanCodec(secret: string) {
  if (Buffer.byteLength(secret) < 32) throw new TypeError("Import plan signing requires a configured authentication secret.");
  const signature = (payload: string) => createHmac("sha256", secret).update("notion-import-plan:v1\0").update(payload).digest();
  return {
    sign(plan: NotionImportPlan): string {
      const payload = Buffer.from(JSON.stringify(plan)).toString("base64url");
      const token = `${payload}.${signature(payload).toString("base64url")}`;
      if (token.length > MAX_NOTION_PLAN_TOKEN_BYTES) throw new ImportPlanInvalidError();
      return token;
    },
    verify(token: unknown): NotionImportPlan {
      if (typeof token !== "string" || token.length > MAX_NOTION_PLAN_TOKEN_BYTES) throw new ImportPlanInvalidError();
      const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
      if (!match) throw new ImportPlanInvalidError();
      const [, payload, encodedSignature] = match;
      const supplied = Buffer.from(encodedSignature!, "base64url");
      if (supplied.toString("base64url") !== encodedSignature || !timingSafeEqual(supplied, signature(payload!))) throw new ImportPlanInvalidError();
      try {
        const bytes = Buffer.from(payload!, "base64url");
        if (bytes.toString("base64url") !== payload) throw new ImportPlanInvalidError();
        // Only our authenticated, versioned payload is decoded as this type.
        const plan = JSON.parse(bytes.toString("utf8")) as NotionImportPlan;
        if (plan?.version !== 1 || !Array.isArray(plan.works) || plan.works.length > 200) throw new ImportPlanInvalidError();
        return plan;
      } catch { throw new ImportPlanInvalidError(); }
    },
  };
}

export function assertNotionImportPlan(plan: NotionImportPlan, input: {
  actorId: string; bundleHash: string; generation: string; now: number;
}): void {
  if (plan.actorId !== input.actorId || plan.bundleHash !== input.bundleHash || plan.generation !== input.generation ||
      !Number.isSafeInteger(plan.issuedAt) || !Number.isSafeInteger(plan.expiresAt) ||
      plan.issuedAt > input.now || plan.expiresAt <= input.now || plan.expiresAt - plan.issuedAt !== NOTION_IMPORT_PLAN_TTL_MS) {
    throw new ImportPlanInvalidError();
  }
}

/** Compare normalized rows, never timestamps or digests in place of a work revision. */
export function sameNotionImportLinks(left: readonly StoredExternalContentLink[], right: readonly StoredExternalContentLink[]): boolean {
  const rows = (links: readonly StoredExternalContentLink[]) => links.map((link) =>
    [link.provider, link.externalId, link.locale, link.articleId, link.ownerId, link.digest, link.syncedAt])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify(rows(left)) === JSON.stringify(rows(right));
}

export function assertNotionImportWorkState(input: CommitNotionImportWorkInput, current: {
  generation: string;
  links: StoredExternalContentLink[];
  createKeyArticleId: string | null;
  article: { id: string; authorId: string; revision: string; deleted: boolean } | null;
}): void {
  const expected = input.expected;
  if (current.generation !== input.generation || input.expiresAt <= Date.now()) throw new ImportConflictError();
  if (current.links.some((link) => link.ownerId !== input.actorId)) throw new ImportConflictError("ownership");
  if (!sameNotionImportLinks(expected.links, current.links) ||
      current.createKeyArticleId !== expected.createKeyArticleId ||
      (expected.article === null ? current.article !== null :
        current.article === null || current.article.deleted || current.article.authorId !== input.actorId ||
        current.article.id !== expected.article.id || current.article.revision !== expected.article.revision)) {
    throw new ImportConflictError();
  }
}
