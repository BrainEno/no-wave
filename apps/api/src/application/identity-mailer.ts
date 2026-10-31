/**
 * Outbound mail for the two account transitions that need it.
 *
 * This port exists so the identity service can ask "tell this address that
 * something happened to its account" without knowing what carries the message.
 * Nothing here is provider-specific on purpose: ADR 0012 forbids provider code
 * until a hosting candidate has passed the zero-cost/no-card gate, and an SMTP
 * or API driver is exactly the kind of detail that would have to be rewritten
 * the moment that gate decides. See ADR 0014.
 */

import { sendSmtpMessage, SmtpError, type SmtpConfig, type SmtpDependencies, type SmtpSecurity } from "../infrastructure/smtp-client.ts";
import { MailDisabledError } from "../domain/errors.ts";

export type IdentityTokenPurpose = "password_reset" | "email_verification";

export type IdentityMailMessage = {
  readonly to: string;
  readonly purpose: IdentityTokenPurpose;
  readonly subject: string;
  readonly text: string;
  /** The page the recipient opens; it posts the token back rather than the API reading it from a path. */
  readonly link: string;
};

export type IdentityMailer = {
  send(message: IdentityMailMessage): Promise<void>;
};

/**
 * Where the link points.
 *
 * `AUTH_IDENTITY_BASE_URL` is public origin of the site (for example
 * `https://example.com`); without it the link is host-relative, which is enough
 * to exercise the flow and useless in a real mailbox — and saying so out loud
 * is better than inventing an origin.
 */
export function identityLink({ env = process.env, purpose, token }: {
  env?: NodeJS.ProcessEnv;
  purpose: IdentityTokenPurpose;
  token: string;
}): string {
  const raw = typeof env.AUTH_IDENTITY_BASE_URL === "string" ? env.AUTH_IDENTITY_BASE_URL.trim() : "";
  const base = raw.replace(/\/+$/, "");
  const path = purpose === "password_reset" ? "/reset-password" : "/verify-email";
  return `${base}${path}?token=${encodeURIComponent(token)}`;
}

/**
 * The default mailer: a structured log line instead of a delivered message.
 *
 * It never writes the link unless an operator opts in with
 * `AUTH_IDENTITY_MAIL_LOG_LINK=1` for local development. A log line that can
 * reset somebody's password is a password reset waiting to be read by whoever
 * reads the logs, and the whole point of a single-use token is that exactly one
 * party holds it.
 */
export function createLogMailer({ env = process.env, log = (line: string) => process.stdout.write(`${line}\n`) }: {
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
} = {}): IdentityMailer {
  return Object.freeze({
    async send({ to, purpose, subject, text, link }: IdentityMailMessage): Promise<void> {
      log(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "info",
        component: "api",
        event: "identity_mail",
        to,
        purpose,
        subject,
        text,
        link: env.AUTH_IDENTITY_MAIL_LOG_LINK === "1" ? link : null,
      }));
    },
  });
}

/**
 * One retry, and only inside this budget.
 *
 * A refused connection fails in microseconds, so the retry is nearly free; a
 * relay that hangs for ten seconds has already spent the budget, and a retry
 * would turn one slow recovery request into two slow ones.
 */
const DELIVERY_ATTEMPTS = 2;
const DEFAULT_DELIVERY_DEADLINE_MS = 2_000;
const RETRY_DELAY_MS = 150;

export type SmtpMailerConfig = SmtpConfig & {
  from: string;
  fromName?: string;
  /** Total time a delivery may spend across all attempts; capped at 10s. */
  deliveryDeadlineMs?: number;
};

function configured(value: string | undefined | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function securityFromEnv(value: string | undefined): SmtpSecurity {
  // Unknown values fall back to `starttls`, which is the strict one: a typo
  // must not quietly turn TLS off.
  return value === "implicit" || value === "none" ? value : "starttls";
}

function portFromEnv(value: string | undefined, security: SmtpSecurity): number {
  if (typeof value === "string" && /^[1-9]\d*$/.test(value.trim())) {
    const port = Number(value.trim());
    if (port <= 65535) return port;
  }
  return security === "implicit" ? 465 : 587;
}

/**
 * The relay configuration, or `null` when no relay is configured.
 *
 * Mail is opt-in: without `MAIL_SMTP_HOST` and `MAIL_FROM` the API keeps logging
 * instead of sending, so an unconfigured instance cannot start mailing anybody.
 */
export function resolveSmtpMailerConfig(env: NodeJS.ProcessEnv = process.env): SmtpMailerConfig | null {
  const host = configured(env.MAIL_SMTP_HOST);
  const from = configured(env.MAIL_FROM);
  if (host.length === 0 || from.length === 0) return null;
  const security = securityFromEnv(configured(env.MAIL_SMTP_SECURITY));
  const user = configured(env.MAIL_SMTP_USER);
  const password = typeof env.MAIL_SMTP_PASSWORD === "string" ? env.MAIL_SMTP_PASSWORD : "";
  const timeout = configured(env.MAIL_SMTP_TIMEOUT_MS);
  const deadline = configured(env.MAIL_SMTP_DELIVERY_DEADLINE_MS);
  return {
    host,
    port: portFromEnv(env.MAIL_SMTP_PORT, security),
    security,
    ...(user.length > 0 ? { user, password } : {}),
    ...(/^[1-9]\d*$/.test(timeout) ? { timeoutMs: Math.min(Number(timeout), 60_000) } : {}),
    ...(/^[1-9]\d*$/.test(deadline) ? { deliveryDeadlineMs: Math.min(Number(deadline), 10_000) } : {}),
    from,
    ...(configured(env.MAIL_FROM_NAME) ? { fromName: configured(env.MAIL_FROM_NAME) } : {}),
  };
}

/**
 * Deliver through an SMTP submission relay.
 *
 * The port knows nothing about which provider is on the other end — that is the
 * point. Every transactional provider (Brevo, Resend, SMTP2GO) and any mailbox
 * host speaks submission, so switching is an environment change, not a code
 * change. See ADR 0015.
 */
/**
 * Whether a failure is worth another attempt.
 *
 * Only failures that happened **before the relay could have accepted anything**:
 * a refused connection, a DNS miss, a connect timeout. Once the server has
 * opened its mouth — a rejected credential, a rejected recipient, a lost reply
 * to DATA — the outcome is either a decision or an unknown, and retrying a
 * message that may already be queued is how one reset link becomes two mails.
 */
export function isRetryableMailFailure(error: unknown): boolean {
  if (error instanceof SmtpError) return error.code === "CONNECT";
  // `dialSmtp` rejects with the raw system error for everything else that can
  // go wrong while connecting (ECONNREFUSED, ENOTFOUND, EAI_AGAIN, ECONNRESET).
  return error instanceof Error;
}

export function createSmtpMailer({ config, deps = {}, log = (line: string) => process.stdout.write(`${line}\n`), sleep = defaultSleep }: {
  config: SmtpMailerConfig;
  deps?: SmtpDependencies;
  log?: (line: string) => void;
  sleep?: (milliseconds: number) => Promise<void>;
} = { config: { host: "", port: 587, security: "starttls", from: "" } }): IdentityMailer {
  return Object.freeze({
    async send({ to, subject, text, link }: IdentityMailMessage): Promise<void> {
      // The link is the point of the mail, so it goes on a line of its own
      // rather than buried in a paragraph an operator might edit.
      const body = [text, "", link].join("\n");
      const startedAt = Date.now();
      const deadlineMs = config.deliveryDeadlineMs ?? DEFAULT_DELIVERY_DEADLINE_MS;

      for (let attempt = 1; ; attempt += 1) {
        try {
          await sendSmtpMessage(
            { host: config.host, port: config.port, security: config.security, ...(config.user ? { user: config.user, password: config.password ?? "" } : {}), ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}), ...(config.clientName ? { clientName: config.clientName } : {}) },
            { from: config.from, ...(config.fromName ? { fromName: config.fromName } : {}), to, subject, text: body },
            deps,
          );
          return;
        } catch (error: unknown) {
          const outOfTime = Date.now() - startedAt >= deadlineMs;
          if (attempt >= DELIVERY_ATTEMPTS || outOfTime || !isRetryableMailFailure(error)) {
            // Re-thrown with the purpose but **without** the address: the caller
            // records this, and a mailbox in a failure log is the kind of detail
            // that turns a log store into a mailing list.
            const code = error instanceof SmtpError ? error.code : "SMTP_UNAVAILABLE";
            const detail = error instanceof Error ? error.message : "The mail relay could not be reached.";
            throw new SmtpError(code, `delivery of a ${subject} mail failed: ${detail}`);
          }
          log(`smtp: delivery attempt ${attempt} failed (${(error as { code?: string }).code ?? "CONNECTION"}); retrying once`);
          await sleep(RETRY_DELAY_MS);
        }
      }
    },
  });
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

/**
 * The switch for every feature that would put mail in somebody's inbox.
 *
 * Off by default, and off means off: an instance that has not enabled mail does
 * not send, does not queue and does not pretend. A configured relay is not
 * enough on its own — this is the operator's decision, not a side effect of
 * having filled in `MAIL_SMTP_HOST`, so a deployment can hold working
 * credentials while keeping recovery switched off.
 *
 * The variable is read at request time by both tiers (the API here, the Web app
 * for what it shows), so it can be changed without a rebuild. Unset, empty and
 * unrecognised values all mean "off": a typo must not switch mail on.
 */
export function isMailEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = typeof env.MAIL_ENABLED === "string" ? env.MAIL_ENABLED.trim().toLowerCase() : "";
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

/**
 * The mailer the API runs with: a relay when one is configured, a log line
 * otherwise — and nothing at all while mail is switched off.
 *
 * The log mailer stays the default on purpose. A deployment that has not
 * configured a relay has not finished setting up recovery, and pretending
 * otherwise by inventing a sender would be worse than saying so.
 *
 * The disabled mailer throws rather than dropping the message on the floor:
 * reaching it means some path tried to deliver without checking the switch, and
 * the one thing a switched-off instance must never do is look like it sent
 * something. Callers check {@link isMailEnabled} first and answer 409.
 */
export function resolveIdentityMailer(env: NodeJS.ProcessEnv = process.env): IdentityMailer {
  if (isMailEnabled(env) === false) {
    return {
      async send() { throw new MailDisabledError(); },
    };
  }
  const config = resolveSmtpMailerConfig(env);
  return config ? createSmtpMailer({ config }) : createLogMailer({ env });
}
