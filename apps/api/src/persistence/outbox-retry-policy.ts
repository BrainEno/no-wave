/** Shared by the worker, bounded drain and both lease implementations. */
export const DEFAULT_OUTBOX_MAX_ATTEMPTS = 8;
export const DEFAULT_OUTBOX_MAX_RETRY_DELAY_SECONDS = 86400;

export function validateOutboxMaxAttempts(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new TypeError("maxAttempts must be an integer between 1 and 100.");
  }
  return value;
}

export type OutboxRetryPolicy = {
  retryDelaySeconds: number;
  maxRetryDelaySeconds: number;
  maxAttempts: number;
};

export function resolveOutboxRetryPolicy({
  retryDelaySeconds = 30,
  maxRetryDelaySeconds = DEFAULT_OUTBOX_MAX_RETRY_DELAY_SECONDS,
  maxAttempts = DEFAULT_OUTBOX_MAX_ATTEMPTS,
}: Partial<OutboxRetryPolicy> = {}): OutboxRetryPolicy {
  for (const [name, value] of [["retryDelaySeconds", retryDelaySeconds], ["maxRetryDelaySeconds", maxRetryDelaySeconds]] as const) {
    if (!Number.isInteger(value) || value < 1 || value > 86400) {
      throw new TypeError(`${name} must be an integer between 1 and 86400.`);
    }
  }
  if (maxRetryDelaySeconds < retryDelaySeconds) {
    throw new TypeError("maxRetryDelaySeconds must not be less than retryDelaySeconds.");
  }
  return { retryDelaySeconds, maxRetryDelaySeconds, maxAttempts: validateOutboxMaxAttempts(maxAttempts) };
}

/** Attempt one uses the base delay; null is a terminal, not a zero-delay retry. */
export function outboxRetryDelaySeconds(attempts: number, policy: OutboxRetryPolicy): number | null {
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new TypeError("attempts must be a positive safe integer.");
  if (attempts >= policy.maxAttempts) return null;
  return Math.min(policy.maxRetryDelaySeconds, policy.retryDelaySeconds * 2 ** (attempts - 1));
}
