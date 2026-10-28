import { createPersistencePorts } from "./persistence-ports.ts";
import { ArticleInputError } from "../domain/errors.ts";

/**
 * Application-facing service facade.
 *
 * GraphQL resolvers depend on these domain-grouped operations rather than on
 * a database driver. Business use cases can be moved into this module without
 * changing transport resolvers or adapter implementations.
 */
export function createApplicationServices({ persistence, onPersistenceOperation = null }) {
  const ports = createPersistencePorts(persistence, { onOperation: onPersistenceOperation });
  const serviceMethods = Object.values(ports).flatMap((group) => Object.entries(group));
  const services = Object.fromEntries(serviceMethods);

  // Parse transport-serialized content at the application boundary, not in GraphQL.
  const parseContentBlocks = (serialized) => {
    let blocks;
    try {
      blocks = JSON.parse(serialized);
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

  return Object.freeze(services);
}
