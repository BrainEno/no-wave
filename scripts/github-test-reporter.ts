import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(import.meta.dirname, "..");
const MAX_ANNOTATIONS = 20;
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const escapeData = (value: string) => value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
const escapeProperty = (value: string) => escapeData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");

function location(data: Record<string, unknown>): string {
  const properties: string[] = [];
  if (typeof data.file === "string") {
    let path = data.file;
    try { if (path.startsWith("file:")) path = fileURLToPath(path); } catch { path = ""; }
    const local = path ? relative(root, resolve(path)).replaceAll("\\", "/") : "";
    if (local && !isAbsolute(local) && local !== ".." && !local.startsWith("../") && local.length <= 2000) {
      properties.push(`file=${escapeProperty(local)}`);
      for (const [field, name] of [["line", "line"], ["column", "col"]] as const) {
        const value = data[field];
        if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) properties.push(`${name}=${value}`);
      }
    }
  }
  const name = typeof data.name === "string" ? data.name : "Node test failed";
  properties.push(`title=${escapeProperty(name.slice(0, 240))}`);
  return properties.join(",");
}

function failureMessage(details: unknown): string {
  if (!object(details) || !object(details.error)) return "Inspect the failed test output.";
  const error = details.error;
  const cause = object(error.cause) ? error.cause : error;
  return typeof cause.message === "string" ? cause.message : typeof error.message === "string" ? error.message : "Inspect the failed test output.";
}

/** Companion to the spec reporter. It observes failures; Node still owns the exit status. */
export default async function* githubTestReporter(events: AsyncIterable<unknown>): AsyncGenerator<string> {
  let emitted = 0;
  for await (const event of events) {
    if (!object(event) || event.type !== "test:fail" || !object(event.data)) continue;
    if (emitted === MAX_ANNOTATIONS) {
      yield "::warning title=Additional test failures::Further failure annotations were omitted; the readable test report still contains every result.\n";
    }
    if (emitted++ >= MAX_ANNOTATIONS) continue;
    const data = event.data;
    const name = typeof data.name === "string" ? data.name : "Node test failed";
    const message = `${name}\n${failureMessage(data.details)}`.slice(0, 6000);
    yield `::error ${location(data)}::${escapeData(message)}\n`;
  }
}
