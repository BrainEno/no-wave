import { createPersistencePorts, type PersistencePorts } from "./persistence-ports.ts";
import { ArticleInputError } from "../domain/errors.ts";

type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never;

/** Flatten `{ content: { a, b }, taxonomy: { c } }` into `{ a, b, c }`. */
type FlatPorts<P> = UnionToIntersection<{ [K in keyof P]: P[K] }[keyof P]>;

/**
 * The application-facing service facade.
 *
 * The type is *derived* from the persistence port table rather than hand-written
 * again: `createApplicationServices` flattens the domain-grouped ports into one
 * object, so the facade type must flatten the same groups. Typing an adapter
 * method therefore tightens every transport call site automatically, and a method
 * name that does not exist in the table is a compile error instead of a runtime
 * "not a function". See issue #66 for the remaining work (annotating the adapter
 * implementations themselves).
 */
export type ApplicationServices<A extends import("./persistence-ports.ts").PersistenceAdapterMethods = import("./persistence-ports.ts").PersistenceAdapterMethods> =
  FlatPorts<PersistencePorts<A>> & {
    createArticle(input: { authorId: string; contentBlocks: unknown; [key: string]: unknown }): Promise<unknown>;
    updateArticle(input: { actorId: string; contentBlocks: unknown; [key: string]: unknown }): Promise<unknown>;
  };

/**
 * GraphQL resolvers depend on these domain-grouped operations rather than on
 * a database driver. Business use cases can be moved into this module without
 * changing transport resolvers or adapter implementations.
 */
export function createApplicationServices<A extends import("./persistence-ports.ts").PersistenceAdapterMethods>({ persistence, onPersistenceOperation = null }: {
  persistence: A;
  onPersistenceOperation?: ((sample: { operation: string; success: boolean; durationMs: number }) => void) | null;
}): ApplicationServices<A> {
  const ports = createPersistencePorts(persistence, { onOperation: onPersistenceOperation ?? undefined });
  const serviceMethods = Object.values(ports).flatMap((group) => Object.entries(group));
  const services = Object.fromEntries(serviceMethods);

  // Parse transport-serialized content at the application boundary, not in GraphQL.
  const parseContentBlocks = (serialized: unknown) => {
    let blocks;
    try {
      blocks = JSON.parse(serialized as string);
    } catch {
      throw new ArticleInputError("contentBlocks must be a valid JSON array.");
    }
    if (!Array.isArray(blocks)) {
      throw new ArticleInputError("contentBlocks must be a valid JSON array.");
    }
    return blocks;
  };

  services.createArticle = async ({ authorId, ...input }) =>
    ports.content.createArticle({ ...input, authorId, contentBlocks: parseContentBlocks(input.contentBlocks) });
  services.updateArticle = async ({ actorId, ...input }) =>
    ports.content.updateArticle({ ...input, actorId, contentBlocks: parseContentBlocks(input.contentBlocks) });

  return Object.freeze(services) as ApplicationServices<A>;
}
