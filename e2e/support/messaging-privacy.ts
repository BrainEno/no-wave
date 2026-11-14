import { expect, type BrowserContext, type Page } from "@playwright/test";
import { uniqueEmail } from "./accounts.ts";

const PASSWORD = "disposable-message-privacy-password";
export const ACTOR_HEADER = "x-expected-messaging-actor";

/** Disposable API fixtures; the browser under test still uses real HttpOnly cookies. */
export async function register(context: BrowserContext, origin: string) {
  const email = uniqueEmail("message-privacy");
  const response = await context.request.post(`${origin}/api/auth/register`, {
    headers: { origin }, data: { email, password: PASSWORD },
  });
  expect(response.status()).toBe(201);
  const session = await context.request.get(`${origin}/api/authoring/session`);
  expect(session.status()).toBe(200);
  return { email, id: (await session.json()).data.id as string };
}

export async function login(context: BrowserContext, origin: string, email: string) {
  const response = await context.request.post(`${origin}/api/auth/login`, {
    headers: { origin }, data: { email, password: PASSWORD },
  });
  expect(response.status()).toBe(200);
}

export async function conversation(context: BrowserContext, origin: string, recipient: string, body: string) {
  const created = await context.request.post(`${origin}/api/authoring/inbox`, {
    headers: { origin, "idempotency-key": crypto.randomUUID() }, data: { participantIds: [recipient] },
  });
  expect(created.status()).toBe(201);
  const id = (await created.json()).data.id as string;
  const sent = await context.request.post(`${origin}/api/authoring/inbox/${id}/messages`, {
    headers: { origin, "idempotency-key": crypto.randomUUID() }, data: { body },
  });
  expect(sent.status()).toBe(201);
  return id;
}

export function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

export async function settleUi(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

export async function unloadBlocked(page: Page) {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

export async function restorePage(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
}
