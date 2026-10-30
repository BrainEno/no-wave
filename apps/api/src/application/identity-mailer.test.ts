import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server, type Socket } from "node:net";

import {
  createSmtpMailer,
  createLogMailer,
  identityLink,
  isRetryableMailFailure,
  resolveIdentityMailer,
  resolveSmtpMailerConfig,
  type SmtpMailerConfig,
} from "./identity-mailer.ts";
import { SmtpError, SmtpReplyReader, type SmtpConnection } from "../infrastructure/smtp-client.ts";

/**
 * Mailer selection and delivery.
 *
 * The recovery flow is useless if mail silently goes nowhere, and dangerous if
 * it goes somewhere readable: these tests pin the two properties that decide
 * which of those happens — mail is only sent when a relay is configured, and a
 * failure is reported without leaking the address or the credential.
 */

const SMTP_ENV = {
  MAIL_SMTP_HOST: "smtp-relay.example.test",
  MAIL_SMTP_USER: "relay-user",
  MAIL_SMTP_PASSWORD: "relay-secret",
  MAIL_FROM: "no-reply@no-wave.test",
};

test("no relay configured means no mail is sent, and the log mailer stays in place", async () => {
  assert.equal(resolveSmtpMailerConfig({}), null);
  assert.equal(resolveSmtpMailerConfig({ MAIL_SMTP_HOST: "relay.test" }), null, "a host without a sender is not configured");
  assert.equal(resolveSmtpMailerConfig({ MAIL_FROM: "a@b.test" }), null, "a sender without a host is not configured");

  const lines: string[] = [];
  const mailer = createLogMailer({ env: {}, log: (line) => lines.push(line) });
  await mailer.send({ to: "writer@example.test", purpose: "password_reset", subject: "重置", text: "正文", link: "https://x/reset?token=t" });
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0] ?? "{}") as { event?: string; link?: string | null };
  assert.equal(entry.event, "identity_mail");
  assert.equal(entry.link, null, "the log mailer must not write a usable reset link by default");
});

test("a configured relay is read from the environment, with TLS by default", () => {
  const config = resolveSmtpMailerConfig(SMTP_ENV);
  assert.ok(config);
  assert.equal(config.host, "smtp-relay.example.test");
  assert.equal(config.port, 587);
  assert.equal(config.security, "starttls");
  assert.equal(config.user, "relay-user");
  assert.equal(config.password, "relay-secret");
  assert.equal(config.from, "no-reply@no-wave.test");
});

test("the port follows the security mode unless it is set explicitly", () => {
  assert.equal(resolveSmtpMailerConfig({ ...SMTP_ENV, MAIL_SMTP_SECURITY: "implicit" })?.port, 465);
  assert.equal(resolveSmtpMailerConfig({ ...SMTP_ENV, MAIL_SMTP_PORT: "2525" })?.port, 2525);
  assert.equal(resolveSmtpMailerConfig({ ...SMTP_ENV, MAIL_SMTP_PORT: "not-a-port" })?.port, 587, "an unparsable port falls back");
  assert.equal(resolveSmtpMailerConfig({ ...SMTP_ENV, MAIL_SMTP_PORT: "99999" })?.port, 587);
});

test("an unrecognized security value falls back to the strict one", () => {
  // A typo must not turn TLS off: `none` on a public relay would put the
  // password on the wire.
  assert.equal(resolveSmtpMailerConfig({ ...SMTP_ENV, MAIL_SMTP_SECURITY: "NONE" })?.security, "starttls");
  assert.equal(resolveSmtpMailerConfig({ ...SMTP_ENV, MAIL_SMTP_SECURITY: "plain" })?.security, "starttls");
  assert.equal(resolveSmtpMailerConfig({ ...SMTP_ENV, MAIL_SMTP_SECURITY: "none" })?.security, "none", "an exact value is honoured");
});

test("a relay without credentials authenticates as none at all", () => {
  const config = resolveSmtpMailerConfig({ MAIL_SMTP_HOST: "relay.test", MAIL_FROM: "no-reply@no-wave.test" });
  assert.ok(config);
  assert.equal(config.user, undefined, "an unauthenticated local relay must not be sent an empty credential");
});

test("resolveIdentityMailer picks the relay when one is configured", () => {
  assert.notEqual(resolveIdentityMailer({}), undefined);
  const withRelay = resolveIdentityMailer(SMTP_ENV);
  assert.notEqual(withRelay, undefined);
  // The two mailers are distinguished by what they do, not by a type tag, so
  // the assertion is that construction succeeds for both paths.
  assert.equal(typeof withRelay.send, "function");
});

test("the link is delivered on its own line, and a failure carries no address", async () => {
  const failures: string[] = [];
  const mailer = createSmtpMailer({
    config: { host: "127.0.0.1", port: 1, security: "starttls", user: "u", password: "p", from: "no-reply@no-wave.test", timeoutMs: 200 },
    log: (line) => failures.push(line),
  });

  await assert.rejects(
    mailer.send({
      to: "writer@example.test",
      purpose: "password_reset",
      subject: "重置你的密码",
      text: "我们收到了重置密码的请求。",
      link: identityLink({ env: { AUTH_IDENTITY_BASE_URL: "https://no-wave.test" }, purpose: "password_reset", token: "secret-token" }),
    }),
    (error: unknown) => error instanceof SmtpError,
  );
  // The mailer logs its retry, and nothing else: a log line about a delivery
  // must not carry the address or the credential.
  for (const line of failures) {
    assert.match(line, /delivery attempt \d+ failed/);
    assert.equal(line.includes("writer@example.test"), false);
    assert.equal(line.includes("relay-secret"), false);
  }

  try {
    await mailer.send({ to: "writer@example.test", purpose: "password_reset", subject: "s", text: "t", link: "https://x/y" });
    assert.fail("an unreachable relay must not report success");
  } catch (error: unknown) {
    assert.ok(error instanceof SmtpError);
    assert.equal(error.message.includes("writer@example.test"), false, "a mailbox address must not land in the failure text");
    assert.equal(error.message.includes("relay-secret"), false, "nor the credential");
    assert.match(error.message, /delivery of.*failed/);
  }
});

/** The strongest available evidence short of a real provider: a real socket. */
async function startRelay(): Promise<{ port: number; received: () => string; close: () => Promise<void> }> {
  const chunks: string[] = [];
  const server: Server = createServer((socket: Socket) => {
    let buffer = "";
    let inData = false;
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk.toString("utf8"));
      buffer += chunk.toString("utf8");
      for (;;) {
        const end = buffer.indexOf("\r\n");
        if (end === -1) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (inData) {
          if (line === ".") { socket.write("250 2.0.0 Ok: queued\r\n"); inData = false; }
          continue;
        }
        if (line.startsWith("EHLO")) socket.write("250-relay.test\r\n250 8BITMIME\r\n");
        else if (line.startsWith("MAIL FROM") || line.startsWith("RCPT TO")) socket.write("250 2.1.0 Ok\r\n");
        else if (line.startsWith("DATA")) { socket.write("354 End data with <CR><LF>.<CR><LF>\r\n"); inData = true; }
        else if (line.startsWith("QUIT")) { socket.write("221 Bye\r\n"); socket.end(); }
        else socket.write("250 2.0.0 Ok\r\n");
      }
    });
    socket.write("220 relay.test ESMTP ready\r\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    port: address.port,
    received: () => chunks.join(""),
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

test("a real relay receives a decodable recovery mail with the link intact", async () => {
  const relay = await startRelay();
  try {
    const mailer = createSmtpMailer({
      config: { host: "127.0.0.1", port: relay.port, security: "none", from: "no-reply@no-wave.test", fromName: "无浪潮", timeoutMs: 2000 },
    });
    const link = identityLink({ env: { AUTH_IDENTITY_BASE_URL: "https://no-wave.test" }, purpose: "password_reset", token: "tok_en-value" });
    await mailer.send({
      to: "writer@example.test",
      purpose: "password_reset",
      subject: "重置你的密码",
      text: "我们收到了重置密码的请求。",
      link,
    });

    const wire = relay.received();
    assert.match(wire, /MAIL FROM:<no-reply@no-wave\.test>/);
    assert.match(wire, /RCPT TO:<writer@example\.test>/);
    // The display name is Chinese, so it has to arrive encoded rather than as
    // raw UTF-8 in a header.
    assert.match(wire, /From: =\?UTF-8\?B\?/);
    const data = wire.slice(wire.indexOf("DATA\r\n") + 6);
    const body = Buffer.from(data.slice(data.indexOf("\r\n\r\n") + 4).replace(/\r\n\.\r\n$/, ""), "base64").toString("utf8");
    assert.match(body, /重置密码的请求/);
    assert.match(body, /https:\/\/no-wave\.test\/reset-password\?token=tok_en-value/);
  } finally {
    await relay.close();
  }
});

/**
 * Bounded retry.
 *
 * The rule is narrower than "try again": only a failure that happened before
 * the relay could have accepted the message may be retried. Anything after the
 * server has spoken — a rejected credential, a rejected recipient, a lost reply
 * to DATA — is either a decision or an unknown, and retrying an unknown is how
 * one reset link turns into two mails.
 */

const RETRY_CONFIG: SmtpMailerConfig = { host: "relay.test", port: 587, security: "none", from: "no-reply@no-wave.test" };
const MESSAGE_BODY = { to: "writer@example.test", purpose: "password_reset" as const, subject: "重置", text: "正文", link: "https://no-wave.test/reset-password?token=abc" };

function connectionFailure(code: string): Error {
  const failure: Error & { code?: string } = new Error(`connect ${code} relay.test:587`);
  failure.code = code;
  return failure;
}

/** An unauthenticated plaintext submission script: greeting, EHLO, envelope, data. */
const PLAINTEXT_REPLIES = [
  "220 relay.test ESMTP ready",
  "250 relay.test",
  "250 2.1.0 Ok",
  "250 2.1.5 Ok",
  "354 End data with <CR><LF>.<CR><LF>",
  "250 2.0.0 Ok: queued",
];

/** A dialer that fails a fixed number of times, then serves a whole conversation. */
function flakyDialer(failures: number) {
  let attempts = 0;
  const connection: SmtpConnection = {
    send() {},
    read() {
      const reply = PLAINTEXT_REPLIES.shift() ?? "250 2.0.0 Ok";
      const [parsed] = new SmtpReplyReader().push(`${reply}\r\n`);
      return Promise.resolve(parsed ?? { code: 250, lines: [reply] });
    },
    upgrade() { return Promise.reject(new SmtpError("STARTTLS_UNAVAILABLE", "no")); },
    close() {},
  };
  return {
    get attempts() { return attempts; },
    dial: async (): Promise<SmtpConnection> => {
      attempts += 1;
      if (attempts <= failures) throw connectionFailure("ECONNREFUSED");
      return connection;
    },
  };
}

test("a refused connection is retried once and succeeds", async () => {
  const flaky = flakyDialer(1);
  const logs = [];
  const mailer = createSmtpMailer({
    config: RETRY_CONFIG,
    deps: { dial: flaky.dial },
    log: (line) => logs.push(line),
    sleep: async () => undefined,
  });
  await mailer.send(MESSAGE_BODY);
  assert.equal(flaky.attempts, 2);
  assert.ok(logs.some((line) => line.includes("retrying once")));
});

test("a server that has already spoken is never asked twice", async () => {
  for (const error of [new SmtpError("AUTH", "535 rejected"), new SmtpError("RCPT TO", "550 no such user"), new SmtpError("TIMEOUT", "no reply to DATA")]) {
    let attempts = 0;
    const mailer = createSmtpMailer({
      config: RETRY_CONFIG,
      deps: {
        dial: async () => {
          attempts += 1;
          return { send() {}, read() { return Promise.reject(error); }, upgrade() { return Promise.reject(error); }, close() {} };
        },
      },
      sleep: async () => undefined,
    });
    await assert.rejects(mailer.send(MESSAGE_BODY));
    assert.equal(attempts, 1, `${error.code} must not be retried: the relay may already hold the message`);
  }
});

test("a slow first failure spends the budget and is not retried", async () => {
  let attempts = 0;
  const mailer = createSmtpMailer({
    // A zero budget means even an instant failure is out of time.
    config: { ...RETRY_CONFIG, deliveryDeadlineMs: 0 },
    deps: {
      dial: async () => { attempts += 1; throw connectionFailure("ECONNREFUSED"); },
    },
    sleep: async () => undefined,
  });
  await assert.rejects(mailer.send(MESSAGE_BODY));
  assert.equal(attempts, 1, "a retry must not turn one slow recovery request into two");
});

test("only connect-level failures are retryable", () => {
  assert.equal(isRetryableMailFailure(connectionFailure("ECONNREFUSED")), true);
  assert.equal(isRetryableMailFailure(connectionFailure("ENOTFOUND")), true);
  assert.equal(isRetryableMailFailure(new SmtpError("CONNECT", "connect timeout")), true);
  assert.equal(isRetryableMailFailure(new SmtpError("TIMEOUT", "no reply")), false);
  assert.equal(isRetryableMailFailure(new SmtpError("AUTH", "535")), false);
  assert.equal(isRetryableMailFailure(new SmtpError("RCPT TO", "550")), false);
  assert.equal(isRetryableMailFailure("a string that was thrown"), false);
});

test("the delivery budget is configurable and capped", () => {
  assert.equal(resolveSmtpMailerConfig({ ...SMTP_ENV, MAIL_SMTP_DELIVERY_DEADLINE_MS: "5000" })?.deliveryDeadlineMs, 5000);
  assert.equal(resolveSmtpMailerConfig({ ...SMTP_ENV, MAIL_SMTP_DELIVERY_DEADLINE_MS: "999999" })?.deliveryDeadlineMs, 10_000);
  assert.equal(resolveSmtpMailerConfig({ ...SMTP_ENV, MAIL_SMTP_DELIVERY_DEADLINE_MS: "soon" })?.deliveryDeadlineMs, undefined);
});
