/**
 * Compile-time regression guards for the typed persistence port contract
 * (issues #66 / #167).
 *
 * This module is intentionally never imported at runtime: `pnpm typecheck` is
 * its test runner. Each `@ts-expect-error` must remain an error. If the port
 * surface ever falls back to `(...args: any[]) => any` again, TypeScript reports
 * an *unused* `@ts-expect-error` directive and the build fails — which is the
 * property the contract is meant to guarantee.
 */
import type {
  PersistencePorts,
  TypedPersistenceAdapterContract,
} from "./persistence-ports.ts";
import type { ApplicationServices } from "./services.ts";

declare const ports: PersistencePorts;
declare const services: ApplicationServices;

/** Nothing here executes; the calls exist only so `tsc` checks their arguments. */
export function assertTypedPortInputs(): void {
  void ports.content.getPublishedArticle({ slug: "hello", locale: "en" });
  void services.getPublishedArticle({ slug: "hello", locale: "en" });
  void services.listPublishedArticles({ locale: "en", limit: 20, offset: 0 });

  // @ts-expect-error a misspelled port parameter name is a compile error
  void ports.content.getPublishedArticle({ slugg: "hello" });
  // @ts-expect-error a wrong port parameter type is a compile error
  void ports.content.listPublishedArticles({ limit: "20" });
  // @ts-expect-error a misspelled transport parameter name is a compile error
  void services.listPublishedArticles({ limt: 20 });
  // @ts-expect-error a method that is not in the port table does not exist
  void ports.content.listPublishedArticless({});
  // @ts-expect-error `health` resolves to a boolean, not a number
  const wrongReturn: Promise<number> = ports.operations.health();
  void wrongReturn;
}

/** An adapter with a wrongly typed method cannot satisfy the contract. */
export function assertTypedAdapterShape(): void {
  void ({ async getPublishedArticle({ slug, locale }: { slug?: string; locale?: string }) { return { slug, locale } as never; } } satisfies Pick<TypedPersistenceAdapterContract, "getPublishedArticle">);

  // @ts-expect-error an adapter method taking a parameter the contract does not declare is rejected
  void ({ async getPublishedArticle({ slugg }: { slugg: string }) { return null; } } satisfies Pick<TypedPersistenceAdapterContract, "getPublishedArticle">);
}
