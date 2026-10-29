import assert from "node:assert/strict";
import test from "node:test";
import { createMediaObjectStorage } from "./media-storage.ts";

test("Neon Object Storage credentials use AWS-standard environment variable names", () => {
  const storage = createMediaObjectStorage({
    MEDIA_S3_BUCKET: "media",
    AWS_REGION: "us-east-2",
    AWS_ACCESS_KEY_ID: "test-access-key",
    AWS_SECRET_ACCESS_KEY: "test-secret-key",
    AWS_ENDPOINT_URL_S3: "https://objects.example.test",
  });
  assert.ok(storage);
  storage.close();
});

test("explicit MEDIA_S3 values take precedence over AWS-standard aliases", () => {
  assert.throws(
    () => createMediaObjectStorage({
      MEDIA_S3_BUCKET: "media",
      MEDIA_S3_REGION: "invalid region",
      MEDIA_S3_ACCESS_KEY_ID: "explicit-access-key",
      MEDIA_S3_SECRET_ACCESS_KEY: "explicit-secret-key",
      MEDIA_S3_ENDPOINT: "https://media.example.test",
      AWS_REGION: "us-east-2",
      AWS_ACCESS_KEY_ID: "fallback-access-key",
      AWS_SECRET_ACCESS_KEY: "fallback-secret-key",
      AWS_ENDPOINT_URL_S3: "https://objects.example.test",
    }),
    /MEDIA_S3_REGION is invalid/,
  );
});

test("generic AWS credentials do not enable media storage without an explicit app bucket", () => {
  assert.equal(
    createMediaObjectStorage({
      AWS_REGION: "us-east-2",
      AWS_ACCESS_KEY_ID: "test-access-key",
      AWS_SECRET_ACCESS_KEY: "test-secret-key",
      AWS_ENDPOINT_URL_S3: "https://objects.example.test",
    }),
    null,
  );
});

test("partial media configuration still fails closed when Neon aliases are incomplete", () => {
  assert.throws(
    () => createMediaObjectStorage({
      MEDIA_S3_BUCKET: "media",
      AWS_REGION: "us-east-2",
    }),
    /MEDIA_S3_BUCKET.*AWS_REGION.*AWS_ACCESS_KEY_ID.*AWS_SECRET_ACCESS_KEY/,
  );
});
