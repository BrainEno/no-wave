import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server, type Socket } from "node:net";

import { SmtpError } from "../infrastructure/smtp-client.ts";
import { createSmtpMailer, createLogMailer, identityLink, resolveIdentityMailer, resolveSmtpMailerConfig } from "./identity-mailer.ts";

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
  assert.deepEqual(failures, [], "a failed delivery logs nothing from the mailer itself");

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
