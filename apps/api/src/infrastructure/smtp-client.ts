import { randomBytes } from "node:crypto";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

/**
 * A minimal SMTP submission client (RFC 5321 SUBMIT, STARTTLS, AUTH PLAIN/LOGIN).
 *
 * Why this exists instead of a provider SDK: ADR 0012 keeps provider-specific
 * code out of business logic, and submission is the one mail interface every
 * transactional provider offers — Brevo, Resend, SMTP2GO and a mailbox host are
 * all this same code with different environment variables. The identity service
 * talks to `IdentityMailer`; it never learns which relay is behind it.
 *
 * The surface is deliberately narrow: one sender, one recipient, a text body.
 * That is all an account mail needs, and every command not implemented here is a
 * command that cannot go wrong.
 */

export type SmtpSecurity = "starttls" | "implicit" | "none";

export type SmtpConfig = {
  host: string;
  port: number;
  security: SmtpSecurity;
  user?: string;
  password?: string;
  /** Name announced in `EHLO`; defaults to `localhost`. */
  clientName?: string;
  /** Maximum wait for a single server reply. */
  timeoutMs?: number;
};

export type SmtpMessage = {
  from: string;
  /** Optional display name; encoded when it is not ASCII. */
  fromName?: string;
  to: string;
  subject: string;
  text: string;
};

/** An SMTP reply: a three-digit code plus every line that came with it. */
export type SmtpReply = { code: number; lines: readonly string[] };

export class SmtpError extends Error {
  readonly code: string;
  readonly reply?: SmtpReply;

  constructor(code: string, message: string, reply?: SmtpReply) {
    super(message);
    this.name = "SmtpError";
    this.code = code;
    if (reply) this.reply = reply;
  }
}

/**
 * The conversation's transport.
 *
 * A seam rather than a socket: production dials a real TCP/TLS socket, tests
 * supply a scripted peer, and the protocol code is identical for both.
 */
export type SmtpConnection = {
  send(line: string): void;
  read(): Promise<SmtpReply>;
  /** STARTTLS: layer TLS over the existing socket and return the new channel. */
  upgrade(): Promise<SmtpConnection>;
  close(): void;
};

export type SmtpDependencies = {
  dial?: (config: SmtpConfig) => Promise<SmtpConnection>;
  log?: (line: string) => void;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REPLY_LINE_BYTES = 4096;
const MAX_REPLY_BYTES = 65_536;

/**
 * What an address may look like at this boundary.
 *
 * `MAIL FROM` and `RCPT TO` are the injection point of SMTP: a newline in an
 * address turns one message into arbitrary commands. The identity service
 * validates the address long before it reaches here; this is the second door and
 * it does not assume the first one is shut.
 */
const ADDRESS_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

export function assertSmtpAddress(value: string, field: "from" | "to"): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 254) {
    throw new SmtpError("INVALID_ADDRESS", `The ${field} address is not usable.`);
  }
  // Checked before the pattern: a string that looks right but carries a control
  // character is still an injection.
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new SmtpError("INVALID_ADDRESS", `The ${field} address contains control characters.`);
  }
  if (!ADDRESS_PATTERN.test(value)) {
    throw new SmtpError("INVALID_ADDRESS", `The ${field} address is not usable.`);
  }
}

/** RFC 2047 encoded-word, used only when the value is not already ASCII. */
export function encodeHeaderValue(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** RFC 2822 date, always ASCII regardless of the process locale. */
export function smtpDate(now = new Date()): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (value: number): string => String(value).padStart(2, "0");
  const offset = -now.getTimezoneOffset();
  const absolute = Math.abs(offset);
  return `${days[now.getDay()]}, ${pad(now.getDate())} ${months[now.getMonth()]} ${now.getFullYear()} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} ` +
    `${offset >= 0 ? "+" : "-"}${pad(Math.floor(absolute / 60))}${pad(absolute % 60)}`;
}

/**
 * Render the DATA payload, ending with the terminating dot and **no** trailing
 * CRLF (the connection adds it).
 *
 * The body is base64 and the subject is an encoded word, so only 7-bit ASCII
 * goes on the wire: no 8BITMIME, no SMTPUTF8 negotiation, and no way for a
 * newline in the body to become a header.
 */
export function renderSmtpMessage(message: SmtpMessage, now = new Date()): string {
  assertSmtpAddress(message.from, "from");
  assertSmtpAddress(message.to, "to");
  const name = message.fromName?.trim();
  const from = name && name.length > 0
    ? `${/^[\x20-\x7e]+$/.test(name) ? `"${name.replace(/["\\]/g, "")}"` : encodeHeaderValue(name)} <${message.from}>`
    : message.from;
  const body = Buffer.from(message.text, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");

  const headers = [
    `Date: ${smtpDate(now)}`,
    `From: ${from}`,
    `To: ${message.to}`,
    `Subject: ${encodeHeaderValue(message.subject)}`,
    `Message-ID: <${randomBytes(12).toString("hex")}@${message.from.split("@")[1] ?? "localhost"}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    // Account mail is triggered by the holder — or by somebody typing their
    // address — so it is marked automated and never asks for a human reply.
    "Auto-Submitted: auto-generated",
    `Reply-To: ${message.from}`,
  ];
  // Dot-stuffing: a line starting with "." would end DATA. Base64 never
  // produces one, but the rule belongs to the renderer, not to today's alphabet.
  return [...headers, "", body].join("\r\n").replace(/\r\n\./g, "\r\n..") + "\r\n.";
}

/** Split a byte stream into complete SMTP replies as they arrive. */
export class SmtpReplyReader {
  private buffer = "";
  private collected: string[] = [];
  private readonly maximumBytes: number;

  constructor(maximumBytes = MAX_REPLY_BYTES) {
    this.maximumBytes = maximumBytes;
  }

  /** Feed a chunk; return every reply that is now complete, in order. */
  push(chunk: string): SmtpReply[] {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, "utf8") > this.maximumBytes) {
      throw new SmtpError("REPLY_TOO_LARGE", "The SMTP server sent a response that exceeded the limit.");
    }
    const replies: SmtpReply[] = [];
    for (;;) {
      const end = this.buffer.indexOf("\r\n");
      if (end === -1) break;
      const line = this.buffer.slice(0, end);
      if (Buffer.byteLength(line, "utf8") > MAX_REPLY_LINE_BYTES) {
        throw new SmtpError("REPLY_TOO_LARGE", "The SMTP server sent a response line that exceeded the limit.");
      }
      this.buffer = this.buffer.slice(end + 2);
      const code = Number(line.slice(0, 3));
      if (!Number.isInteger(code) || code < 100 || code > 599) {
        throw new SmtpError("BAD_REPLY", "The SMTP server sent an unparsable response.");
      }
      this.collected.push(line);
      // `250-…` continues the reply; `250 …` ends it.
      if (line[3] !== "-") {
        replies.push({ code, lines: [...this.collected] });
        this.collected = [];
      }
    }
    return replies;
  }
}

/** A connection over a real socket, with a bounded wait per reply. */
export function socketConnection(
  socket: Socket | TLSSocket,
  timeoutMs: number,
  upgrade?: () => Promise<SmtpConnection>,
): SmtpConnection {
  const reader = new SmtpReplyReader();
  const waiters: { resolve: (reply: SmtpReply) => void; reject: (error: Error) => void }[] = [];
  const queued: SmtpReply[] = [];
  let closed = false;

  const fail = (error: Error): void => {
    for (const waiter of waiters.splice(0)) waiter.reject(error);
    if (!closed) { closed = true; socket.destroy(); }
  };

  socket.setEncoding("utf8");
  socket.setTimeout(timeoutMs);
  socket.on("data", (chunk: string) => {
    try {
      for (const reply of reader.push(chunk)) {
        const waiter = waiters.shift();
        if (waiter) waiter.resolve(reply);
        else queued.push(reply);
      }
    } catch (error) {
      fail(error instanceof Error ? error : new SmtpError("BAD_REPLY", "The SMTP server sent an unparsable response."));
    }
  });
  socket.on("timeout", () => fail(new SmtpError("TIMEOUT", "The SMTP server did not answer in time.")));
  socket.on("error", (error: Error) => fail(error));
  socket.on("close", () => fail(new SmtpError("CONNECTION_CLOSED", "The SMTP server closed the connection.")));

  return {
    send(line) {
      if (closed) throw new SmtpError("CONNECTION_CLOSED", "The SMTP connection is closed.");
      socket.write(`${line}\r\n`);
    },
    read() {
      const reply = queued.shift();
      if (reply) return Promise.resolve(reply);
      return new Promise<SmtpReply>((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((entry) => entry.resolve === resolve);
          if (index !== -1) waiters.splice(index, 1);
          reject(new SmtpError("TIMEOUT", "The SMTP server did not answer in time."));
        }, timeoutMs);
        waiters.push({
          resolve: (value) => { clearTimeout(timer); resolve(value); },
          reject: (error) => { clearTimeout(timer); reject(error); },
        });
      });
    },
    upgrade() {
      if (!upgrade) return Promise.reject(new SmtpError("STARTTLS_UNAVAILABLE", "This connection cannot be upgraded."));
      return upgrade();
    },
    close() {
      if (closed) return;
      closed = true;
      try { socket.end(); } catch { /* already gone */ }
    },
  };
}

/**
 * Production dialer: a plain socket for STARTTLS/plaintext, a TLS socket for
 * implicit TLS (port 465).
 */
export function dialSmtp(config: SmtpConfig): Promise<SmtpConnection> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // A distinct code from the in-conversation `TIMEOUT`: before the server has
  // said anything, nothing can have been delivered, so a connect failure is the
  // one class of failure that is safe to retry.
  const timeout = new SmtpError("CONNECT", "The SMTP server did not accept the connection in time.");
  if (config.security === "implicit") {
    return new Promise<SmtpConnection>((resolve, reject) => {
      const socket = tlsConnect(
        // Certificate verification stays at Node's default and is never turned
        // off here: a relay that cannot present a valid certificate does not get
        // to see an authentication attempt.
        { host: config.host, port: config.port, servername: config.host },
        () => { socket.setTimeout(timeoutMs); resolve(socketConnection(socket, timeoutMs)); },
      );
      socket.setTimeout(timeoutMs);
      socket.on("timeout", () => { socket.destroy(); reject(timeout); });
      socket.on("error", reject);
    });
  }
  return new Promise<SmtpConnection>((resolve, reject) => {
    const socket = netConnect({ host: config.host, port: config.port }, () => {
      socket.setTimeout(timeoutMs);
      resolve(socketConnection(socket, timeoutMs, () => Promise.resolve(startTls(socket, config, timeoutMs))));
    });
    socket.setTimeout(timeoutMs);
    socket.on("timeout", () => { socket.destroy(); reject(timeout); });
    socket.on("error", reject);
  });
}

/** Layer TLS over an open submission socket (STARTTLS). */
function startTls(socket: Socket, config: SmtpConfig, timeoutMs: number): SmtpConnection {
  // The server name is the configured host, which is what the certificate has to
  // match: reaching a relay by IP address fails verification, by design.
  const secured = tlsConnect({ socket, servername: config.host });
  return socketConnection(secured, timeoutMs);
}

function hasCapability(reply: SmtpReply, name: string): boolean {
  const pattern = new RegExp(`^\\d{3}[- ]${name}\\b`, "i");
  return reply.lines.some((line) => pattern.test(line));
}

/**
 * The mechanisms behind `AUTH`.
 *
 * They are not separate capabilities: the line is `250-AUTH PLAIN LOGIN` (or
 * `AUTH=PLAIN LOGIN`), so looking for a capability named `PLAIN` would find
 * nothing and silently refuse to authenticate.
 */
function authMechanisms(reply: SmtpReply): string[] {
  for (const line of reply.lines) {
    const match = /^\d{3}[- ]AUTH(?:=|\s+)(.+)$/i.exec(line);
    if (match) return (match[1] ?? "").trim().toUpperCase().split(/\s+/).filter((entry) => entry.length > 0);
  }
  return [];
}

/**
 * One message, one connection.
 *
 * The order is the protocol's, not a preference: greet, advertise, secure,
 * authenticate, then envelope, then data. Authentication happens **after** the
 * channel is secured and never before, so a server that cannot do STARTTLS is
 * never handed a credential.
 */
export async function sendSmtpMessage(
  config: SmtpConfig,
  message: SmtpMessage,
  deps: SmtpDependencies = {},
): Promise<void> {
  const dial = deps.dial ?? dialSmtp;
  const log = deps.log ?? ((): void => undefined);
  const clientName = config.clientName ?? "localhost";
  assertSmtpAddress(message.from, "from");
  assertSmtpAddress(message.to, "to");

  let connection = await dial(config);
  let secured = config.security === "implicit";

  const expect = async (step: string, allowed: readonly number[]): Promise<SmtpReply> => {
    const reply = await connection.read();
    if (!allowed.includes(reply.code)) {
      throw new SmtpError(step.toUpperCase(), `The SMTP server rejected ${step}: ${reply.lines.join(" ")}`, reply);
    }
    return reply;
  };

  try {
    await expect("greeting", [220]);

    connection.send(`EHLO ${clientName}`);
    let capabilities = await expect("EHLO", [250]);

    if (config.security === "starttls") {
      if (!hasCapability(capabilities, "STARTTLS")) {
        throw new SmtpError(
          "STARTTLS_REQUIRED",
          "The SMTP server does not offer STARTTLS; refusing to continue over an unencrypted connection.",
        );
      }
      connection.send("STARTTLS");
      await expect("STARTTLS", [220]);
      connection = await connection.upgrade();
      secured = true;
      // The greeting is re-read and the capabilities re-fetched after the
      // handshake: servers routinely advertise AUTH only once the channel is
      // secure, and nothing before this point may be trusted.
      connection.send(`EHLO ${clientName}`);
      capabilities = await expect("EHLO", [250]);
    }

    if (config.user && config.password) {
      if (!secured) throw new SmtpError("AUTH_REFUSED", "Refusing to authenticate without TLS.");
      await authenticate(connection, capabilities, config, log);
    }

    connection.send(`MAIL FROM:<${message.from}>`);
    await expect("MAIL FROM", [250]);
    connection.send(`RCPT TO:<${message.to}>`);
    await expect("RCPT TO", [250, 251]);
    connection.send("DATA");
    await expect("DATA", [354]);
    connection.send(renderSmtpMessage(message));
    await expect("DATA", [250]);
    log(`smtp: accepted one message for ${message.to}`);
  } finally {
    // A failed QUIT says nothing about the delivery, and the socket goes away
    // either way.
    try { connection.send("QUIT"); } catch { /* already closed */ }
    connection.close();
  }
}

/**
 * AUTH PLAIN (RFC 4616), falling back to LOGIN for servers that only offer the
 * older mechanism.
 *
 * Nothing here logs the credential: the base64 blob is the password, and a log
 * line that can authenticate is a password in a log file.
 */
async function authenticate(
  connection: SmtpConnection,
  capabilities: SmtpReply,
  config: SmtpConfig,
  log: (line: string) => void,
): Promise<void> {
  const credential = Buffer.from(`\u0000${config.user ?? ""}\u0000${config.password ?? ""}`, "utf8").toString("base64");
  const mechanisms = authMechanisms(capabilities);
  if (mechanisms.length === 0) {
    throw new SmtpError("AUTH_REFUSED", "The SMTP server does not advertise AUTH; refusing to send credentials.");
  }

  if (mechanisms.includes("PLAIN")) {
    connection.send("AUTH PLAIN");
    const challenge = await connection.read();
    if (challenge.code === 334) {
      connection.send(credential);
      const result = await connection.read();
      if (result.code !== 235) throw new SmtpError("AUTH", "The SMTP server rejected the credentials.", result);
      log("smtp: authenticated with AUTH PLAIN");
      return;
    }
    throw new SmtpError("AUTH", "The SMTP server refused AUTH PLAIN.", challenge);
  }

  if (mechanisms.includes("LOGIN")) {
    connection.send("AUTH LOGIN");
    const userPrompt = await connection.read();
    if (userPrompt.code !== 334) throw new SmtpError("AUTH", "The SMTP server refused AUTH LOGIN.", userPrompt);
    connection.send(Buffer.from(config.user ?? "", "utf8").toString("base64"));
    const passwordPrompt = await connection.read();
    if (passwordPrompt.code !== 334) throw new SmtpError("AUTH", "The SMTP server refused the username.", passwordPrompt);
    connection.send(Buffer.from(config.password ?? "", "utf8").toString("base64"));
    const result = await connection.read();
    if (result.code !== 235) throw new SmtpError("AUTH", "The SMTP server rejected the credentials.", result);
    log("smtp: authenticated with AUTH LOGIN");
    return;
  }

  throw new SmtpError("AUTH_REFUSED", "The SMTP server offers neither AUTH PLAIN nor AUTH LOGIN.");
}
