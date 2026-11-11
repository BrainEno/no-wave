import assert from "node:assert/strict";
import test from "node:test";
import { ipv4Answers, resolveUbuntuHosts } from "./ci-ubuntu-dns.ts";

const answer = (...ips: string[]) => Response.json({ Status: 0, Answer: ips.map((data) => ({ type: 1, data })) });

test("DNS JSON accepts unique IPv4 answers only", () => {
  assert.deepEqual(ipv4Answers({ Status: 0, Answer: [
    { type: 1, data: "192.0.2.4" }, { type: 1, data: "192.0.2.4" },
    { type: 28, data: "2001:db8::1" }, { type: 5, data: "cname.example" },
    { type: 1, data: "1.2.3.4\n127.0.0.1 evil.test" }, null,
  ] }), ["192.0.2.4"]);
  for (const bad of [null, {}, { Status: 3, Answer: [{ type: 1, data: "192.0.2.4" }] }, { Status: 0, Answer: "no" }]) {
    assert.deepEqual(ipv4Answers(bad), []);
  }
});

test("only the explicitly requested official domains are resolved", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input) => { calls.push(String(input)); return answer("192.0.2.1", "192.0.2.2"); };
  assert.deepEqual(await resolveUbuntuHosts(["archive.ubuntu.com", "archive.ubuntu.com", "security.ubuntu.com"], fetcher), [
    "192.0.2.1 archive.ubuntu.com", "192.0.2.2 archive.ubuntu.com", "192.0.2.1 security.ubuntu.com", "192.0.2.2 security.ubuntu.com",
  ]);
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[0]!).searchParams.get("name"), "archive.ubuntu.com");
  assert.equal(new URL(calls[1]!).searchParams.get("name"), "security.ubuntu.com");
  assert.ok(calls.every((url) => url.startsWith("https://dns.google/")));
});

test("unapproved names, injected hostnames and IP literals fail before network access", async () => {
  const fetcher: typeof fetch = async () => { throw new Error("should not call fetch"); };
  for (const bad of ["github.com", "127.0.0.1", "archive.ubuntu.com\n127.0.0.1 evil", "Archive.ubuntu.com"]) {
    await assert.rejects(resolveUbuntuHosts([bad], fetcher), /Unexpected DNS hostname/);
  }
});

test("uses the second HTTPS resolver if the first fails or returns no usable answer", async () => {
  for (const first of [() => { throw new Error("offline"); }, () => Response.json({ Status: 3 }), () => new Response("", { status: 503 })]) {
    const urls: string[] = [];
    const fetcher: typeof fetch = async (input) => { urls.push(String(input)); return urls.length === 1 ? first() : answer("192.0.2.9"); };
    assert.deepEqual(await resolveUbuntuHosts(["azure.archive.ubuntu.com"], fetcher), ["192.0.2.9 azure.archive.ubuntu.com"]);
    assert.match(urls[1]!, /^https:\/\/cloudflare-dns\.com\//);
  }
});

test("an unavailable or invalid response never produces partial host entries", async () => {
  const fetcher: typeof fetch = async (input) => {
    const name = new URL(String(input)).searchParams.get("name");
    return name === "archive.ubuntu.com" ? answer("192.0.2.1") : Response.json({ Status: 0, Answer: [{ type: 1, data: "bad" }] });
  };
  await assert.rejects(resolveUbuntuHosts(["archive.ubuntu.com", "security.ubuntu.com"], fetcher), /Unable to resolve security\.ubuntu\.com/);
});

test("empty host list is a no-op", async () => {
  const fetcher: typeof fetch = async () => { throw new Error("unexpected request"); };
  assert.deepEqual(await resolveUbuntuHosts([], fetcher), []);
});

test("CI invokes the DNS fallback only for unresolved official archives and still installs dependencies", async () => {
  const { readFile } = await import("node:fs/promises");
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const job = workflow.slice(workflow.indexOf("  e2e:"), workflow.indexOf("  react-router-prototype:"));
  const full = workflow.slice(workflow.indexOf("  full-local-suite:"), workflow.indexOf("  required-checks:"));
  for (const content of [job, full]) {
    assert.match(content, /if ! timeout 8 getent ahostsv4/);
    assert.match(content, /node scripts\/ci-ubuntu-dns\.ts/);
    assert.match(content, /sudo tee -a \/etc\/hosts/);
    assert.match(content, /pnpm exec playwright install-deps chromium/);
    assert.match(content, /pnpm exec playwright install chromium/);
    assert.doesNotMatch(content, /allow-unauthenticated|trusted=yes|--allow-insecure/);
  }
});
