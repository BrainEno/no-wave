import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server, type Socket } from "node:net";

import {
  SmtpError,
  SmtpReplyReader,
  encodeHeaderValue,
  renderSmtpMessage,
  sendSmtpMessage,
  smtpDate,
  type SmtpConfig,
  type SmtpConnection,
} from "./smtp-client.ts";

/**
 * Submission-client contract.
 *
 * These tests exist because this is the one place in the API that turns a
 * credential into bytes on a socket: what has to be true is not "it can send a
 * mail" but "it will not authenticate before the channel is encrypted, it will
 * not let an address escape its field, and it will not hang forever".
 */

type Script = {
  replies: string[];
  index: number;
  sent: string[];
  upgrades: number;
  closed: boolean;
};

function script(replies: readonly string[]): Script {
  return { replies: [...replies], index: 0, sent: [], upgrades: 0, closed: false };
}

/** A peer that answers from a fixed script instead of a socket. */
function scriptedConnection(state: Script): SmtpConnection {
  return {
    send(line) { state.sent.push(line); },
    read() {
      const next = state.replies[state.index];
      state.index += 1;
      if (next === undefined) return Promise.reject(new SmtpError("SCRIPT_EXHAUSTED", "the test script ran out of replies"));
      // Script entries are written without the line terminator; multiline
      // replies carry their own internal CRLFs and get the final one here.
      const [reply] = new SmtpReplyReader().push(`${next}\r\n`);
      assert.ok(reply, "the test script must contain a parsable reply");
      return Promise.resolve(reply);
    },
    // STARTTLS swaps the channel but not the conversation, so the script
    // continues where it left off.
    upgrade() { state.upgrades += 1; return Promise.resolve(scriptedConnection(state)); },
    close() { state.closed = true; },
  };
}

const BASE: SmtpConfig = { host: "relay.test", port: 587, security: "starttls", user: "relay-user", password: "relay-secret" };
const MESSAGE = { from: "no-reply@no-wave.test", to: "writer@example.test", subject: "重置你的密码", text: "我们收到了重置密码的请求。\n\nhttps://no-wave.test/reset-password?token=abc" };

const HAPPY_PATH = [
  "220 relay.test ESMTP ready",
  "250-relay.test\r\n250-STARTTLS\r\n250 AUTH PLAIN",
  "220 2.0.0 Ready to start TLS",
  "250-relay.test\r\n250 AUTH PLAIN",
  "334 ",
  "235 2.7.0 Authentication successful",
  "250 2.1.0 Ok",
  "250 2.1.5 Ok",
  "354 End data with <CR><LF>.<CR><LF>",
  "250 2.0.0 Ok: queued",
];

test("a message goes out over STARTTLS with AUTH PLAIN, in the protocol's order", async () => {
  const state = script(HAPPY_PATH);
  const log: string[] = [];
  await sendSmtpMessage(BASE, MESSAGE, { dial: async () => scriptedConnection(state), log: (line) => log.push(line) });

  assert.deepEqual(state.sent.slice(0, 6), [
    "EHLO localhost",
    "STARTTLS",
    "EHLO localhost",
    "AUTH PLAIN",
    Buffer.from("\u0000relay-user\u0000relay-secret", "utf8").toString("base64"),
    "MAIL FROM:<no-reply@no-wave.test>",
  ]);
  assert.deepEqual(state.sent.slice(6, 8), ["RCPT TO:<writer@example.test>", "DATA"]);
  // The Message-ID is random per message, so it is compared apart from it.
  const redact = (payload: string): string => payload.replace(/Message-ID: .*/, "Message-ID: <redacted>");
  assert.equal(redact(state.sent[8] ?? ""), redact(renderSmtpMessage(MESSAGE)));
  assert.equal(state.upgrades, 1, "the channel must be upgraded exactly once");
  assert.equal(state.closed, true, "the connection must be closed even on success");
  assert.equal(state.sent.at(-1), "QUIT");
  assert.match(log.join("\n"), /accepted one message/);
});

test("a server that does not offer STARTTLS never sees a credential", async () => {
  const state = script(["220 relay.test", "250-relay.test\r\n250 AUTH PLAIN"]);
  await assert.rejects(
    sendSmtpMessage(BASE, MESSAGE, { dial: async () => scriptedConnection(state) }),
    (error: unknown) => error instanceof SmtpError && error.code === "STARTTLS_REQUIRED",
  );
  assert.equal(
    state.sent.some((line) => line.startsWith("AUTH")),
    false,
    "authenticating over an unencrypted channel would put the password on the wire",
  );
  assert.equal(state.sent.some((line) => line.startsWith("MAIL FROM")), false);
});

test("rejected credentials stop the conversation before the envelope", async () => {
  const state = script([
    "220 relay.test",
    "250-relay.test\r\n250-STARTTLS\r\n250 AUTH PLAIN",
    "220 go ahead",
    "250-relay.test\r\n250 AUTH PLAIN",
    "334 ",
    "535 5.7.8 Authentication credentials invalid",
  ]);
  await assert.rejects(
    sendSmtpMessage(BASE, MESSAGE, { dial: async () => scriptedConnection(state) }),
    (error: unknown) => error instanceof SmtpError && error.code === "AUTH",
  );
  assert.equal(state.sent.some((line) => line.startsWith("MAIL FROM")), false);
});

test("credentials are refused when the server advertises no AUTH at all", async () => {
  const state = script([
    "220 relay.test",
    "250-relay.test\r\n250-STARTTLS\r\n250 8BITMIME",
    "220 go ahead",
    "250-relay.test\r\n250 8BITMIME",
  ]);
  await assert.rejects(
    sendSmtpMessage(BASE, MESSAGE, { dial: async () => scriptedConnection(state) }),
    (error: unknown) => error instanceof SmtpError && error.code === "AUTH_REFUSED",
  );
  assert.equal(state.sent.some((line) => line.startsWith("AUTH")), false);
});

test("explicit plaintext plus credentials is refused outright", async () => {
  const state = script(["220 relay.test", "250-relay.test\r\n250 AUTH PLAIN"]);
  await assert.rejects(
    sendSmtpMessage({ ...BASE, security: "none" }, MESSAGE, { dial: async () => scriptedConnection(state) }),
    (error: unknown) => error instanceof SmtpError && error.code === "AUTH_REFUSED",
  );
});

test("AUTH LOGIN is used when a server only offers the older mechanism", async () => {
  const state = script([
    "220 relay.test",
    "250-relay.test\r\n250-STARTTLS\r\n250 AUTH LOGIN",
    "220 go ahead",
    "250-relay.test\r\n250 AUTH LOGIN",
    "334 VXNlcm5hbWU6",
    "334 UGFzc3dvcmQ6",
    "235 ok",
    "250 2.1.0 Ok",
    "250 2.1.5 Ok",
    "354 go ahead",
    "250 queued",
  ]);
  await sendSmtpMessage(BASE, MESSAGE, { dial: async () => scriptedConnection(state) });
  assert.deepEqual(state.sent.slice(3, 6), [
    "AUTH LOGIN",
    Buffer.from("relay-user", "utf8").toString("base64"),
    Buffer.from("relay-secret", "utf8").toString("base64"),
  ]);
});

test("implicit TLS authenticates straight after the greeting, without STARTTLS", async () => {
  const state = script([
    "220 relay.test",
    "250-relay.test\r\n250 AUTH PLAIN",
    "334 ",
    "235 ok",
    "250 2.1.0 Ok",
    "250 2.1.5 Ok",
    "354 go ahead",
    "250 queued",
  ]);
  await sendSmtpMessage({ ...BASE, security: "implicit", port: 465 }, MESSAGE, { dial: async () => scriptedConnection(state) });
  assert.equal(state.sent.includes("STARTTLS"), false);
  assert.equal(state.upgrades, 0);
  assert.equal(state.sent[0], "EHLO localhost");
});

test("an address that could escape its field is rejected before anything is dialed", async () => {
  let dialed = 0;
  const dial = async (): Promise<SmtpConnection> => { dialed += 1; return scriptedConnection(script(HAPPY_PATH)); };
  for (const to of ["writer@example.test\r\nRCPT TO:<victim@elsewhere.test>", "writer@example.test\n", "not an address", "a@b", `${"x".repeat(250)}@example.test`]) {
    await assert.rejects(
      sendSmtpMessage(BASE, { ...MESSAGE, to }, { dial }),
      (error: unknown) => error instanceof SmtpError && error.code === "INVALID_ADDRESS",
    );
  }
  assert.equal(dialed, 0, "a rejected address must not open a connection");
});

test("a rejected recipient is reported, and QUIT is still attempted", async () => {
  const state = script([
    "220 relay.test",
    "250-relay.test\r\n250-STARTTLS\r\n250 AUTH PLAIN",
    "220 go ahead",
    "250-relay.test\r\n250 AUTH PLAIN",
    "334 ",
    "235 ok",
    "250 2.1.0 Ok",
    "550 5.1.1 unknown user",
  ]);
  await assert.rejects(
    sendSmtpMessage(BASE, MESSAGE, { dial: async () => scriptedConnection(state) }),
    (error: unknown) => error instanceof SmtpError && error.code === "RCPT TO",
  );
  assert.equal(state.closed, true, "a failed delivery must still release the socket");
});

test("the rendered message is 7-bit, encoded, and dot-stuffed", () => {
  const payload = renderSmtpMessage(MESSAGE, new Date("2026-10-30T08:00:00Z"));
  assert.equal(/[^\x00-\x7f]/.test(payload), false, "nothing outside ASCII may go on the wire");
  assert.match(payload, /^Date: \w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} [+-]\d{4}\r\n/);
  assert.match(payload, /Subject: =\?UTF-8\?B\?/);
  assert.match(payload, /Content-Transfer-Encoding: base64/);
  assert.match(payload, /Auto-Submitted: auto-generated/);
  assert.ok(payload.endsWith("\r\n."), "DATA ends at a dot on a line of its own");

  const body = payload.split("\r\n\r\n").slice(1).join("\r\n\r\n").replace(/\r\n\.$/, "");
  assert.equal(Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8"), MESSAGE.text);
});

test("a subject that tries to inject a header cannot leave the subject line", () => {
  const payload = renderSmtpMessage({ ...MESSAGE, subject: "hi\r\nBcc: victim@elsewhere.test" });
  const headers = payload.split("\r\n\r\n")[0] ?? "";
  assert.equal(headers.includes("\r\nBcc:"), false);
  assert.equal(headers.split("\r\n").filter((line) => line.startsWith("Bcc")).length, 0);
});

test("no line inside the data section can be mistaken for the end of DATA", () => {
  // Base64 never produces a leading dot, so this holds today by construction;
  // it is asserted so that a later switch to a different encoding cannot
  // silently reintroduce the problem.
  const payload = renderSmtpMessage({ ...MESSAGE, text: ".hidden\r\nvisible\r\n." });
  const data = payload.replace(/\r\n\.$/, "");
  const dangerous = data.split("\r\n").filter((line) => line.startsWith("."));
  assert.deepEqual(dangerous, [], "a leading dot would end DATA early and truncate the mail");
});

test("the reply reader assembles multiline replies split across chunks", () => {
  const reader = new SmtpReplyReader();
  assert.deepEqual(reader.push("250-relay.test\r\n250-STARTT"), []);
  const replies = reader.push("LS\r\n250 AUTH PLAIN\r\n");
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.code, 250);
  assert.equal(replies[0]?.lines.length, 3);
});

test("the reply reader refuses an unbounded response", () => {
  const reader = new SmtpReplyReader(1024);
  assert.throws(() => reader.push("250 " + "x".repeat(2048) + "\r\n"), /REPLY_TOO_LARGE|exceeded/);
});

test("encoded headers only encode what needs it", () => {
  assert.equal(encodeHeaderValue("Password reset"), "Password reset");
  assert.match(encodeHeaderValue("重置密码"), /^=\?UTF-8\?B\?/);
  assert.equal(smtpDate(new Date("2026-10-30T08:00:00Z")).endsWith("+0000"), true);
});

/** A real loopback server: proves the socket plumbing, not just the state machine. */
async function withRelayServer(handler: (socket: Socket) => void): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { port: address.port, close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }) };
}

test("the whole conversation runs over a real socket against a plaintext relay", async () => {
  const received: string[] = [];
  const relay = await withRelayServer((socket) => {
    let data = "";
    let inData = false;
    socket.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
      for (;;) {
        const end = data.indexOf("\r\n");
        if (end === -1) break;
        const line = data.slice(0, end);
        data = data.slice(end + 2);
        received.push(line);
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

  try {
    await sendSmtpMessage(
      { host: "127.0.0.1", port: relay.port, security: "none" },
      { ...MESSAGE, subject: "Reset" },
    );
    assert.ok(received.includes("EHLO localhost"));
    assert.ok(received.includes("MAIL FROM:<no-reply@no-wave.test>"));
    assert.ok(received.includes("RCPT TO:<writer@example.test>"));
    const start = received.indexOf("DATA");
    const end = received.indexOf(".", start);
    assert.ok(end > start, "the relay must see the terminating dot");
    // The relay reads line by line, so the data section arrives as separate
    // lines: rejoin them, skip the headers, and decode what is left.
    const data = received.slice(start + 1, end).join("\r\n");
    const separator = data.indexOf("\r\n\r\n");
    assert.ok(separator > 0, "the relay must see a header/body separator");
    const headers = data.slice(0, separator);
    const body = Buffer.from(data.slice(separator + 4), "base64").toString("utf8");
    assert.match(headers, /To: writer@example\.test/);
    assert.match(headers, /Content-Transfer-Encoding: base64/);
    assert.match(body, /https:\/\/no-wave\.test\/reset-password\?token=abc/);
  } finally {
    await relay.close();
  }
});
