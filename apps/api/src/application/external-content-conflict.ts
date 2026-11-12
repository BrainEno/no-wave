/** A provenance key was concurrently claimed by a different work or account. */
export class ExternalContentConflictError extends Error {
  constructor() {
    super("The Notion page is already linked to another work or account.");
    this.name = "ExternalContentConflictError";
  }
}
