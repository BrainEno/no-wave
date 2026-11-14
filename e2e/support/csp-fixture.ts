import { expect, test as base, type Browser, type BrowserContext, type TestInfo } from "@playwright/test";

export type CspViolation = { directive: string; blockedURI: string; disposition: string; document: string };
type ExpectedViolation = Pick<CspViolation, "directive" | "blockedURI"> & { count: number };
export type CspAudit = {
  readonly violations: CspViolation[];
  expectBlocked(directive: string, blockedURI: string, count?: number): void;
};
type AuditState = CspAudit & { expected: ExpectedViolation[]; contexts: number; documents: number; policyErrors: string[] };
const audits = new WeakMap<TestInfo, AuditState>();

function safeAddress(raw: string): string {
  try { const url = new URL(raw); return url.origin + url.pathname; }
  catch { return raw.slice(0, 200); }
}

async function observeContext(context: BrowserContext): Promise<BrowserContext> {
  const audit = audits.get(base.info());
  if (!audit) throw new Error("A browser context was created outside the automatic CSP audit.");
  audit.contexts += 1;
  // The binding receives violations immediately, not by reading a page-global
  // array at teardown: that would lose earlier navigations and closed tabs.
  await context.exposeBinding("__noWaveCspViolation", ({ frame }, value: unknown) => {
    if (!value || typeof value !== "object") throw new TypeError("Invalid CSP audit event.");
    const event = value as Record<string, unknown>;
    if (![event.directive, event.blockedURI, event.disposition].every(item => typeof item === "string")) throw new TypeError("Invalid CSP audit fields.");
    audit.violations.push({ directive: event.directive as string, blockedURI: safeAddress(event.blockedURI as string),
      disposition: event.disposition as string, document: safeAddress(frame.url()) });
  });
  await context.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      const report = (globalThis as unknown as { __noWaveCspViolation(value: unknown): Promise<void> }).__noWaveCspViolation;
      void report({ directive: event.effectiveDirective, blockedURI: event.blockedURI, disposition: event.disposition });
    });
  });
  context.on("response", (response) => {
    if (!response.request().isNavigationRequest()) return;
    const headers = response.headers();
    if (!headers["content-type"]?.toLowerCase().includes("text/html")) return;
    audit.documents += 1;
    const policy = headers["content-security-policy"] ?? "";
    const scripts = policy.split(";").find(value => value.trim().startsWith("script-src ")) ?? "";
    if (!scripts || /unsafe-inline|unsafe-eval|nonce-/.test(scripts) || !policy.includes("frame-ancestors 'none'")) {
      audit.policyErrors.push(`Non-enforcing HTML script policy at ${safeAddress(response.url())}`);
    }
    if (headers["x-content-type-options"] !== "nosniff" || headers["x-frame-options"] !== "DENY") {
      audit.policyErrors.push(`Missing browser baseline at ${safeAddress(response.url())}`);
    }
  });
  return context;
}

/** Every suite uses this fixture, including fonts and multi-account contexts.
 * Only deliberate attack tests register exact expected directive/URI/counts;
 * there is no blanket ignore list, report-only pass or console-text heuristic. */
export const test = base.extend<{ cspAudit: CspAudit }>({
  browser: async ({ browser }, runWithBrowser) => {
    const wrapped = new Proxy(browser, {
      get(target, property) {
        if (property === "newContext") return async (...args: Parameters<Browser["newContext"]>) => observeContext(await target.newContext(...args));
        if (property === "newPage") return async (...args: Parameters<Browser["newPage"]>) => {
          const page = await target.newPage(...args);
          await observeContext(page.context());
          return page;
        };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await runWithBrowser(wrapped);
  },
  cspAudit: [async ({}, runWithAudit, info) => {
    const audit: AuditState = { violations: [], expected: [], contexts: 0, documents: 0, policyErrors: [],
      expectBlocked(directive, blockedURI, count = 1) {
        if (!Number.isSafeInteger(count) || count < 1 || !directive || !blockedURI) throw new TypeError("Expected CSP violations need an exact positive count and target.");
        this.expected.push({ directive, blockedURI: safeAddress(blockedURI), count });
      } };
    audits.set(info, audit);
    try { await runWithAudit(audit); }
    finally {
      audits.delete(info);
      await info.attach("csp-audit.json", { body: JSON.stringify({ contexts: audit.contexts, documents: audit.documents,
        violations: audit.violations, expected: audit.expected, policyErrors: audit.policyErrors }, null, 2), contentType: "application/json" });
      expect(audit.policyErrors, "Every navigated HTML document enforces the production policy").toEqual([]);
      const unmatched = [...audit.violations];
      for (const expected of audit.expected) {
        const matching = unmatched.filter(event => event.disposition === "enforce" && event.directive === expected.directive && event.blockedURI === expected.blockedURI);
        expect(matching.length, `Expected blocked ${expected.directive}: ${expected.blockedURI}`).toBe(expected.count);
        for (const event of matching) unmatched.splice(unmatched.indexOf(event), 1);
      }
      expect(unmatched, "Unexpected CSP violations, including previous navigations and closed secondary contexts").toEqual([]);
    }
  }, { auto: true }],
});
