/**
 * Compile-time regression tests for the typed persistence ports (issue #167).
 *
 * This file is not run: it exists to be *typechecked*. `pnpm typecheck` compiles
 * `src/**` excluding tests, and `@ts-expect-error` turns into a build failure the
 * moment the expected error stops happening — so if the contract ever decays
 * back to `(...args: any[]) => any`, the lines below stop erroring and the
 * compiler says so.
 *
 * It is the executable form of the acceptance criterion: a wrong parameter name
 * or a wrong argument type at a call site must fail `pnpm typecheck`, not a
 * request at 3am.
 */
import type { PersistenceAdapterContract } from "./persistence-ports.ts";
import type {
  Article,
  AuthorProfile,
  IdentitySessionSeed,
  RefreshRotation,
} from "./persistence-port-types.ts";

type IsAny<T> = 0 extends 1 & T ? true : false;
type Expect<T extends true> = T;

/** The contract is a map of typed functions, not a record of `any`. */
type _AdapterIsNotAny = Expect<IsAny<PersistenceAdapterContract> extends false ? true : false>;

declare const adapter: PersistenceAdapterContract;

export async function typedCallSitesCompile(): Promise<void> {
  // Correct calls keep compiling, and their results keep their precise types.
  const articles: Article[] = await adapter.listPublishedArticles({ locale: "en", limit: 10 });
  const first = articles[0];
  const publishedAt: string | null | undefined = first?.publishedAt;

  const profile: AuthorProfile | null = await adapter.getAuthorProfile({ userId: "u1", locale: "en" });
  const displayName: string | undefined = profile?.displayName;

  const rotation: RefreshRotation = await adapter.rotateIdentityRefresh({
    refreshHash: "a".repeat(64),
    nextRefreshHash: "b".repeat(64),
    accessTokenId: "token-1",
    issuedAt: new Date().toISOString(),
    accessExpiresAt: new Date().toISOString(),
  });
  // The four-way refresh answer stays discriminated: reading `userId` without
  // narrowing is a compile error, which is what keeps a rotated-only field from
  // leaking into the `invalid`/`reused` branches.
  if (rotation.status === "rotated") {
    const userId: string = rotation.userId;
    void userId;
  }

  const seed: IdentitySessionSeed = {
    sessionId: "s1",
    userId: "u1",
    accessTokenId: "a1",
    refreshHash: "c".repeat(64),
    expiresAt: new Date().toISOString(),
    accessExpiresAt: new Date().toISOString(),
  };
  await adapter.createIdentityAccount({ userId: "u1", email: "a@b.test", passwordHash: "h", session: seed });

  void publishedAt;
  void displayName;
}

export async function wrongArgumentsAreRejected(): Promise<void> {
  // A parameter *name* that the port does not have: the old `any` signature
  // accepted this silently and the store answered `undefined` for `slug`.
  // @ts-expect-error `getPublishedArticle` takes a slug, not a userId.
  await adapter.getPublishedArticle({ userId: "u1", locale: "en" });

  // A wrong argument *type* on an otherwise correct call.
  // @ts-expect-error `limit` is a number.
  await adapter.listPublishedArticles({ limit: "ten" });

  // A selector the port does not accept: `kind` is `category` or `tag`.
  // @ts-expect-error "series" is not a taxonomy kind.
  await adapter.listTaxonomies({ kind: "series" });

  // A wrong arity: cursors live inside the input object, not in a second args bag.
  // @ts-expect-error `getPublishedArticle` takes one input object.
  await adapter.getPublishedArticle({ slug: "a-work" }, { locale: "en" });

  // A wrong enum member where the port is deliberately narrow.
  // @ts-expect-error sort is "latest" or "popular".
  await adapter.listPublishedArticles({ sort: "newest" });
}

export async function wrongResultsAreRejected(): Promise<void> {
  // The return type is the mapped domain record, not `any`: a list is a list.
  // @ts-expect-error an article list is not a number.
  const count: number = await adapter.listPublishedArticles({ locale: "en" });

  const likeInfo = await adapter.getArticleLikeInfo({ slug: "a-work" });
  // @ts-expect-error the adapter answers likeCount, not likes.
  const likes: number | undefined = likeInfo?.likes;

  void count;
  void likes;
}
