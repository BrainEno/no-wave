import type { Page, Route } from "@playwright/test";

/**
 * A stand-in for `POST /api/authoring/notion-import` for journeys that test the
 * *browser's* half of the import: what the page reads out of a file, what it
 * sends, how it splits, retries and reports. The real endpoint is throttled at
 * 20 requests per IP per ten minutes (shared with Notion jobs), and the real-API
 * journeys in notion-import.spec.ts already spend nearly all of it, so a new
 * client-side journey that also used the real endpoint would turn the suite red
 * for a reason that has nothing to do with the import. What the server does with
 * a bundle stays covered by those real-API journeys and by the planner tests.
 *
 * The stand-in answers like the API: a dry run returns a plan token and one
 * `create` row per page; an apply with that token returns the same rows as
 * applied. `respond` may override any call (a 429, a refusal, a failed page).
 */
export type MockImportRequest = {
  bundle: { pages: { id: string; properties: Record<string, unknown>; blocks: unknown[] }[] };
  apply?: boolean;
  planToken?: string;
};

export type MockReportPage = {
  externalId: string; title: string; locale: string; action: "create" | "update" | "skip" | "refused" | "failed";
  slug: string; articleId: string | null; detail: string; issues: { code: string; detail: string }[];
};

type Override = { status: number; headers?: Record<string, string>; body: unknown } | null;

export function titleOf(page: MockImportRequest["bundle"]["pages"][number]): string {
  for (const value of Object.values(page.properties)) {
    const prop = value as { type?: string; title?: { plain_text: string }[] };
    if (prop?.type === "title") return (prop.title ?? []).map((run) => run.plain_text).join("");
  }
  return "";
}

export function defaultRows(request: MockImportRequest): MockReportPage[] {
  return request.bundle.pages.map((page) => ({
    externalId: page.id, title: titleOf(page), locale: "zh", action: "create",
    slug: "", articleId: null, detail: "", issues: [],
  }));
}

export function reportBody(request: MockImportRequest, rows: MockReportPage[], call: number) {
  const summary = { create: 0, update: 0, skip: 0, refused: 0, failed: 0 };
  for (const row of rows) summary[row.action] += 1;
  const applied = request.apply === true;
  return {
    data: {
      applied,
      ...(applied ? {} : { planToken: `mock-plan-${call}`, planExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString() }),
      database: { id: "", title: "Notion Markdown 导出" },
      summary,
      pages: rows,
    },
  };
}

export async function mockNotionImport(
  page: Page,
  respond: (request: MockImportRequest, call: number) => Override | MockReportPage[] = () => null,
): Promise<MockImportRequest[]> {
  const seen: MockImportRequest[] = [];
  await page.route("**/api/authoring/notion-import", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const request = route.request().postDataJSON() as MockImportRequest;
    const call = seen.push(request);
    const answer = respond(request, call);
    if (answer !== null && !Array.isArray(answer)) {
      return route.fulfill({ status: answer.status, headers: { "content-type": "application/json", ...(answer.headers ?? {}) }, body: JSON.stringify(answer.body) });
    }
    const rows = Array.isArray(answer) ? answer : defaultRows(request);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(reportBody(request, rows, call)) });
  });
  return seen;
}
