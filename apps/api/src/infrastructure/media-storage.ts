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
export function createMediaObjectStorage(env: NodeJS.ProcessEnv = process.env): MediaObjectStorage | null {
  const config = resolveConfig(env);
  if (!config) return null;
  const client = new S3Client({
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  return Object.freeze({
    async putObject({ key, bytes, sha256 }) {
      await client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: bytes,
        ContentLength: bytes.byteLength,
        ContentType: "image/webp",
        CacheControl: "public, max-age=31536000, immutable",
        Metadata: { sha256 },
      }));
    },
    async getObject(key) {
      const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
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
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
    },
    close() { client.destroy(); },
  });
}
