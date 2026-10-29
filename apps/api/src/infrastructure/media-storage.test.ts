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

/** A fake S3 client so retry behavior is exercised without a network or real timers. */
function fakeClient(failures: Array<{ name?: string; status?: number }>, { succeedAfter = failures.length } = {}) {
  const calls: string[] = [];
  const delays: number[] = [];
  let attempt = 0;
  const client = {
    async send(command: unknown) {
      const name = (command as { constructor: { name: string } }).constructor.name;
      calls.push(name);
      attempt += 1;
      if (attempt <= succeedAfter) {
        const failure = failures[Math.min(attempt - 1, failures.length - 1)] ?? {};
        const error = Object.assign(new Error(failure.name ?? "storage failure"), {
          name: failure.name ?? "StorageError",
          $metadata: failure.status === undefined ? undefined : { httpStatusCode: failure.status },
        });
        throw error;
      }
      if (name === "GetObjectCommand") {
        return { Body: (async function* () { yield Buffer.from("webp-bytes"); })() };
      }
      return {};
    },
    destroy() {},
  };
  return {
    client,
    calls,
    delays,
    deps: {
      createClient: () => client,
      sleep: async (ms: number) => { delays.push(ms); },
    },
  };
}

const storageEnv = {
  MEDIA_S3_BUCKET: "media",
  MEDIA_S3_REGION: "aws-ap-southeast-1",
  MEDIA_S3_ENDPOINT: "https://br-example.storage.c-2.aws.neon.tech",
  MEDIA_S3_ACCESS_KEY_ID: "access",
  MEDIA_S3_SECRET_ACCESS_KEY: "secret",
};

test("a Neon-style SlowDown response is retried and then succeeds", async () => {
  const fake = fakeClient([{ name: "SlowDown", status: 503 }], { succeedAfter: 2 });
  const storage = createMediaObjectStorage(storageEnv, fake.deps);
  assert.ok(storage);
  await storage.putObject({ key: "media/a.webp", bytes: Buffer.from("x"), sha256: "abc" });
  assert.equal(fake.calls.length, 3);
  assert.deepEqual(fake.delays, [100, 200]);
  storage.close();
});

test("retries are bounded so a permanently throttled store fails instead of hanging", async () => {
  const fake = fakeClient([{ name: "SlowDown", status: 503 }], { succeedAfter: 99 });
  const storage = createMediaObjectStorage(storageEnv, fake.deps);
  assert.ok(storage);
  await assert.rejects(() => storage.deleteObject("media/a.webp"), /SlowDown/);
  assert.equal(fake.calls.length, 3);
  storage.close();
});

test("non-retryable storage failures are not retried", async () => {
  const fake = fakeClient([{ name: "NoSuchKey", status: 404 }], { succeedAfter: 99 });
  const storage = createMediaObjectStorage(storageEnv, fake.deps);
  assert.ok(storage);
  await assert.rejects(() => storage.getObject("media/missing.webp"), /NoSuchKey/);
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.delays, []);
  storage.close();
});

test("reads also retry a throttled request and return the stored bytes", async () => {
  const fake = fakeClient([{ name: "SlowDown", status: 503 }], { succeedAfter: 1 });
  const storage = createMediaObjectStorage(storageEnv, fake.deps);
  assert.ok(storage);
  const bytes = await storage.getObject("media/a.webp");
  assert.equal(bytes.toString(), "webp-bytes");
  assert.equal(fake.calls.length, 2);
  storage.close();
});
