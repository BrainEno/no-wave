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
 * The mailer the API runs with.
 *
 * No provider is wired yet, so this is the log mailer — which means recovery and
 * verification are fully implemented *except* for the last mile. That is a
 * deliberate, documented state (ADR 0014), not a stub somebody forgot to finish:
 * the alternative is writing provider code before the hosting decision exists.
 */
export function resolveIdentityMailer(env: NodeJS.ProcessEnv = process.env): IdentityMailer {
  return createLogMailer({ env });
}
