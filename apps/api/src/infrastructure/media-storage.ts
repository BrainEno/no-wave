import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export type MediaObjectStorage = {
  putObject(input: { key: string; bytes: Buffer; sha256: string }): Promise<void>;
  getObject(key: string): Promise<Buffer>;
  deleteObject(key: string): Promise<void>;
  close(): void;
};

type MediaStorageClient = {
  send(command: unknown): Promise<any>;
  destroy(): void;
};

/**
 * Test seams. Production callers pass nothing; the adapter builds a real
 * `S3Client` and sleeps with a real timer.
 */
export type MediaObjectStorageDependencies = {
  createClient?: (config: MediaStorageConfig) => MediaStorageClient;
  sleep?: (milliseconds: number) => Promise<void>;
};

/** S3-compatible stores throttle with `503 SlowDown`; retry a bounded number of times. */
const STORAGE_MAX_ATTEMPTS = 3;
const STORAGE_BASE_DELAY_MS = 100;

export class MediaStorageUnavailableError extends Error {
  constructor(message = "Media storage is not configured or is temporarily unavailable.") {
    super(message);
    this.name = "MediaStorageUnavailableError";
  }
}

type MediaStorageConfig = {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string;
  forcePathStyle: boolean;
};

function normalizedEnv(value: string | undefined): string {
  return value?.trim() ?? "";
}

function resolveConfig(env: NodeJS.ProcessEnv): MediaStorageConfig | null {
  const mediaOverrides = {
    bucket: normalizedEnv(env.MEDIA_S3_BUCKET),
    region: normalizedEnv(env.MEDIA_S3_REGION),
    accessKeyId: normalizedEnv(env.MEDIA_S3_ACCESS_KEY_ID),
    secretAccessKey: normalizedEnv(env.MEDIA_S3_SECRET_ACCESS_KEY),
    endpoint: normalizedEnv(env.MEDIA_S3_ENDPOINT),
    forcePathStyle: normalizedEnv(env.MEDIA_S3_FORCE_PATH_STYLE),
  };

  // Do not accidentally enable media storage just because another AWS integration
  // happens to populate generic AWS_* variables. The app's bucket name is an
  // explicit opt-in; after that, Neon credentials can use the standard AWS names.
  if (![mediaOverrides.bucket, mediaOverrides.region, mediaOverrides.accessKeyId, mediaOverrides.secretAccessKey, mediaOverrides.endpoint].some(Boolean)) return null;

  const values = {
    bucket: mediaOverrides.bucket,
    // App-specific aliases intentionally win over Neon/AWS-standard environment variables.
    region: mediaOverrides.region || normalizedEnv(env.AWS_REGION),
    accessKeyId: mediaOverrides.accessKeyId || normalizedEnv(env.AWS_ACCESS_KEY_ID),
    secretAccessKey: mediaOverrides.secretAccessKey || normalizedEnv(env.AWS_SECRET_ACCESS_KEY),
    endpoint: mediaOverrides.endpoint || normalizedEnv(env.AWS_ENDPOINT_URL_S3),
  };
  if (!values.bucket || !values.region || !values.accessKeyId || !values.secretAccessKey) {
    throw new Error(
      "MEDIA_S3_BUCKET, a region (MEDIA_S3_REGION or AWS_REGION), an access key (MEDIA_S3_ACCESS_KEY_ID or AWS_ACCESS_KEY_ID), and a secret key (MEDIA_S3_SECRET_ACCESS_KEY or AWS_SECRET_ACCESS_KEY) are required when media storage is configured.",
    );
  }
  if (values.bucket.length > 255 || /[\\/]/.test(values.bucket)) throw new Error("MEDIA_S3_BUCKET is invalid.");
  if (values.region.length > 100 || !/^[a-z0-9-]+$/.test(values.region)) throw new Error("MEDIA_S3_REGION is invalid.");
  let endpoint: string | undefined;
  if (values.endpoint) {
    let parsed: URL;
    try { parsed = new URL(values.endpoint); }
    catch { throw new Error("MEDIA_S3_ENDPOINT must be an absolute HTTP(S) URL."); }
    const localHost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
    if ((parsed.protocol !== "https:" && !(parsed.protocol === "http:" && localHost)) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("MEDIA_S3_ENDPOINT must use HTTPS, except for an explicitly local endpoint, and must not contain credentials, query or fragment.");
    }
    endpoint = parsed.toString().replace(/\/$/, "");
  }
  const forcePathStyleValue = mediaOverrides.forcePathStyle;
  if (forcePathStyleValue && forcePathStyleValue !== "true" && forcePathStyleValue !== "false") {
    throw new Error("MEDIA_S3_FORCE_PATH_STYLE must be true or false.");
  }
  return {
    bucket: values.bucket,
    region: values.region,
    accessKeyId: values.accessKeyId,
    secretAccessKey: values.secretAccessKey,
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle: forcePathStyleValue ? forcePathStyleValue === "true" : Boolean(endpoint),
  };
}

/** Build a portable S3-compatible adapter. Missing credentials disable uploads; partial configuration fails fast. */
/**
 * Describe the failure modes that are safe to retry.
 *
 * `putObject`, `getObject` and `deleteObject` are all idempotent, so a throttled
 * or timed-out attempt can be repeated without changing the outcome. Anything
 * else (bad credentials, missing bucket, checksum mismatch) fails immediately so
 * a misconfiguration is not hidden behind three slow attempts.
 */
export function isRetryableStorageError(error: unknown): boolean {
  const candidate = error as { name?: unknown; Code?: unknown; code?: unknown; $metadata?: { httpStatusCode?: unknown } } | null;
  if (candidate === null || typeof candidate !== "object") return false;
  const code = [candidate.name, candidate.Code, candidate.code].find((value): value is string => typeof value === "string") ?? "";
  const status = candidate.$metadata?.httpStatusCode;
  return code === "SlowDown"
    || code === "RequestTimeout"
    || code === "Throttling"
    || code === "ThrottlingException"
    || status === 429
    || status === 503;
}

/** Retry an idempotent storage operation with bounded, capped exponential backoff. */
export async function withStorageRetry<T>(
  operation: () => Promise<T>,
  { sleep = defaultSleep, maxAttempts = STORAGE_MAX_ATTEMPTS }: { sleep?: (milliseconds: number) => Promise<void>; maxAttempts?: number } = {},
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await operation();
    } catch (error: unknown) {
      attempt += 1;
      if (attempt >= maxAttempts || !isRetryableStorageError(error)) throw error;
      await sleep(Math.min(STORAGE_BASE_DELAY_MS * 2 ** (attempt - 1), 1000));
    }
  }
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Build a portable S3-compatible adapter.
 *
 * One configuration covers AWS S3, Neon Object Storage (the qualified zero-cost
 * provider, see docs/roadmap/hosting-qualification.md) and any other S3-style
 * endpoint; nothing here is specific to a vendor. Missing credentials disable
 * uploads, partial configuration fails fast.
 */
export function createMediaObjectStorage(
  env: NodeJS.ProcessEnv = process.env,
  { createClient, sleep }: MediaObjectStorageDependencies = {},
): MediaObjectStorage | null {
  const config = resolveConfig(env);
  if (!config) return null;
  const client = createClient
    ? createClient(config)
    : new S3Client({
        region: config.region,
        ...(config.endpoint ? { endpoint: config.endpoint } : {}),
        forcePathStyle: config.forcePathStyle,
        credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
        // S3-compatible endpoints (Neon Object Storage among them) reject the
        // flexible-checksum trailer the SDK would otherwise add by default.
        requestChecksumCalculation: "WHEN_REQUIRED",
      });
  return Object.freeze({
    async putObject({ key, bytes, sha256 }) {
      await withStorageRetry(() => client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: bytes,
        ContentLength: bytes.byteLength,
        ContentType: "image/webp",
        CacheControl: "public, max-age=31536000, immutable",
        Metadata: { sha256 },
      })), { sleep });
    },
    async getObject(key) {
      const response = await withStorageRetry(
        () => client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key })),
        { sleep },
      );
      if (!response.Body) throw new MediaStorageUnavailableError("The stored media object has no body.");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
        const buffer = Buffer.from(chunk);
        size += buffer.byteLength;
        if (size > 8 * 1024 * 1024) throw new MediaStorageUnavailableError("The stored media object exceeds the configured safety limit.");
        chunks.push(buffer);
      }
      return Buffer.concat(chunks, size);
    },
    async deleteObject(key) {
      await withStorageRetry(() => client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key })), { sleep });
    },
    close() { client.destroy(); },
  });
}
