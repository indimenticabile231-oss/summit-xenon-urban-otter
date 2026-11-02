import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { VideoError } from "./errors.ts";
import {
  assertPublicHttpUrl,
  assertResolvedPublicHttpUrl,
  normalizeInput,
  safeFetch,
} from "./http.server.ts";

const BLOCKED = "不能访问内网地址";

describe("normalizeInput", () => {
  it("adds https when the host is bare", () => {
    assert.equal(normalizeInput(" www.bilibili.com/video/BV1xx411c7mD "), "https://www.bilibili.com/video/BV1xx411c7mD");
  });

  it("keeps an explicit scheme", () => {
    assert.equal(normalizeInput("http://b23.tv/abc"), "http://b23.tv/abc");
  });
});

describe("assertPublicHttpUrl", () => {
  it("rejects non-http schemes, userinfo, and local names without DNS", async () => {
    await assert.rejects(() => assertPublicHttpUrl("not a url"), /有效的网页链接/);
    await assert.rejects(() => assertPublicHttpUrl("file:///etc/passwd"), /http 或 https/);
    await assert.rejects(() => assertPublicHttpUrl("http://user:pass@1.1.1.1/a"), /账号密码/);
    await assert.rejects(() => assertPublicHttpUrl("http://localhost/x"), new VideoError(BLOCKED));
    await assert.rejects(() => assertPublicHttpUrl("http://app.localhost/x"), new VideoError(BLOCKED));
    await assert.rejects(() => assertPublicHttpUrl("http://printer.local/x"), new VideoError(BLOCKED));
    await assert.rejects(() => assertPublicHttpUrl("http://metadata.google.internal/"), new VideoError(BLOCKED));
    await assert.rejects(() => assertPublicHttpUrl("http://2130706433/"), new VideoError(BLOCKED));
  });

  it("rejects literal private and link-local IPv4 addresses", async () => {
    const blocked = [
      "http://127.0.0.1/",
      "http://10.1.2.3/x",
      "http://172.16.0.1/",
      "http://192.168.1.9/",
      "http://169.254.169.254/latest/meta-data",
      "http://0.0.0.0/",
      "http://100.64.1.1/",
      "http://192.0.2.1/",
      "http://198.51.100.1/",
      "http://203.0.113.1/",
      "http://224.0.0.1/",
    ];
    for (const raw of blocked) {
      await assert.rejects(() => assertPublicHttpUrl(raw), new VideoError(BLOCKED), raw);
    }
  });

  it("fails closed on bracketed IPv6 literals", async () => {
    // URL.hostname keeps the brackets, so these are not classified as IP literals.
    // DNS then fails. That must stay a rejection, including IPv4-mapped loopback.
    for (const raw of [
      "http://[::1]/",
      "http://[fc00::1]/",
      "http://[fe80::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[2606:4700:4700::1111]/",
    ]) {
      await assert.rejects(() => assertPublicHttpUrl(raw), (error: unknown) => {
        assert.ok(error instanceof VideoError, raw);
        assert.match((error as VideoError).message, /内网|无法解析/, raw);
        return true;
      });
    }
  });

  it("allows a literal public IPv4 address", async () => {
    const url = await assertPublicHttpUrl("http://1.1.1.1/video.mp4");
    assert.equal(url.hostname, "1.1.1.1");
  });
});

describe("assertResolvedPublicHttpUrl", () => {
  it("rejects a public name that resolves to a blocked address", () => {
    assert.throws(
      () => assertResolvedPublicHttpUrl("https://cdn.example/a.mp4", ["1.1.1.1", "127.0.0.1"]),
      new VideoError(BLOCKED),
    );
    assert.throws(
      () => assertResolvedPublicHttpUrl("https://cdn.example/a.mp4", []),
      new VideoError(BLOCKED),
    );
    assert.throws(
      () => assertResolvedPublicHttpUrl("https://cdn.example/a.mp4", ["::ffff:169.254.169.254"]),
      new VideoError(BLOCKED),
    );
    assert.throws(
      () => assertResolvedPublicHttpUrl("https://cdn.example/a.mp4", ["::1"]),
      new VideoError(BLOCKED),
    );
    assert.throws(
      () => assertResolvedPublicHttpUrl("https://cdn.example/a.mp4", ["::ffff:127.0.0.1"]),
      new VideoError(BLOCKED),
    );
  });

  it("accepts a name when every answer is public", () => {
    const url = assertResolvedPublicHttpUrl("https://cdn.example/a.mp4", ["1.1.1.1", "8.8.8.8"]);
    assert.equal(url.hostname, "cdn.example");
  });
});

describe("safeFetch", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  it("returns the upstream response and does not follow a blocked redirect", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const href = String(input);
      seen.push(href);
      if (href.startsWith("http://1.1.1.1/")) {
        return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } });
      }
      return new Response("should not fetch", { status: 200 });
    }) as typeof fetch;

    await assert.rejects(() => safeFetch("http://1.1.1.1/start"), new VideoError(BLOCKED));
    assert.deepEqual(seen, ["http://1.1.1.1/start"]);
  });

  it("follows a redirect to another public URL", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const href = String(input);
      if (href === "http://1.1.1.1/start") {
        return new Response(null, { status: 302, headers: { location: "/file.mp4" } });
      }
      return new Response("ok", { status: 200, headers: { "content-type": "video/mp4" } });
    }) as typeof fetch;

    const response = await safeFetch("http://1.1.1.1/start");
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
  });

  it("stops after too many redirects", async () => {
    globalThis.fetch = (async () =>
      new Response(null, { status: 302, headers: { location: "http://8.8.8.8/loop" } })) as typeof fetch;
    await assert.rejects(() => safeFetch("http://1.1.1.1/start"), /重定向次数过多/);
  });

  it("rejects a redirect with no location", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 302 })) as typeof fetch;
    await assert.rejects(() => safeFetch("http://1.1.1.1/start"), /重定向不完整/);
  });
});
