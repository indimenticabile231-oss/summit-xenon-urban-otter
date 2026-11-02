import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clientAddress,
  quotaDisabled,
  quotaLimits,
  reserveQuota,
  type QuotaLimits,
  type QuotaState,
} from "./quota.server.ts";

const limits: QuotaLimits = {
  inspectPerDay: 2,
  downloadPerDay: 2,
  inspectPerWindow: 2,
  downloadPerWindow: 1,
  windowMs: 60_000,
};

const now = new Date("2026-11-02T12:00:00.000Z");

describe("clientAddress", () => {
  it("uses the last valid forwarded hop, then cf, then x-real-ip", () => {
    assert.equal(
      clientAddress(new Headers({ "x-forwarded-for": "1.2.3.4, 10.0.0.8, 203.0.113.9" })),
      "203.0.113.9",
    );
    assert.equal(
      clientAddress(new Headers({ "x-forwarded-for": "not-an-ip", "cf-connecting-ip": "8.8.8.8" })),
      "8.8.8.8",
    );
    assert.equal(clientAddress(new Headers({ "x-real-ip": "1.1.1.1:443" })), "1.1.1.1");
    assert.equal(clientAddress(new Headers({ "x-real-ip": "[::1]" })), "::1");
    assert.equal(clientAddress(new Headers()), "unknown");
  });
});

describe("quota config", () => {
  it("reads positive overrides and ignores junk", () => {
    assert.equal(quotaLimits({ LUOPIAN_DOWNLOAD_PER_DAY: "8" }).downloadPerDay, 8);
    assert.equal(quotaLimits({ LUOPIAN_INSPECT_PER_DAY: "0" }).inspectPerDay, 120);
    assert.equal(quotaLimits({ LUOPIAN_QUOTA_WINDOW_MS: "600000" }).windowMs, 600_000);
    assert.equal(quotaDisabled({ LUOPIAN_QUOTA_DISABLED: "true" }), true);
    assert.equal(quotaDisabled({}), false);
  });
});

describe("reserveQuota", () => {
  it("counts inspect and download separately and blocks the next one", () => {
    const store = new Map<string, QuotaState>();
    assert.equal(reserveQuota(store, { ip: "1.1.1.1", kind: "inspect", now, limits }).ok, true);
    assert.equal(reserveQuota(store, { ip: "1.1.1.1", kind: "inspect", now, limits }).ok, true);
    const denied = reserveQuota(store, { ip: "1.1.1.1", kind: "inspect", now, limits });
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.match(denied.message, /解析次数已经用完/);
    assert.equal(reserveQuota(store, { ip: "8.8.8.8", kind: "inspect", now, limits }).ok, true);
    assert.equal(reserveQuota(store, { ip: "1.1.1.1", kind: "download", now, limits }).ok, true);
    const burst = reserveQuota(store, { ip: "1.1.1.1", kind: "download", now, limits });
    assert.equal(burst.ok, false);
    if (!burst.ok) {
      assert.match(burst.message, /太频繁/);
      assert.ok(burst.retryAfterSec >= 1);
    }
  });

  it("resets the window and the day", () => {
    const store = new Map<string, QuotaState>();
    assert.equal(reserveQuota(store, { ip: "1.1.1.1", kind: "download", now, limits }).ok, true);
    const later = new Date(now.getTime() + limits.windowMs);
    assert.equal(reserveQuota(store, { ip: "1.1.1.1", kind: "download", now: later, limits }).ok, true);
    const denied = reserveQuota(store, { ip: "1.1.1.1", kind: "download", now: later, limits });
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.match(denied.message, /下载次数已经用完/);
    const tomorrow = new Date("2026-11-03T00:00:00.000Z");
    assert.equal(reserveQuota(store, { ip: "1.1.1.1", kind: "download", now: tomorrow, limits }).ok, true);
  });

  it("does not consume the daily count when the window is already full", () => {
    const store = new Map<string, QuotaState>();
    const wide: QuotaLimits = { ...limits, downloadPerDay: 5, downloadPerWindow: 1 };
    assert.equal(reserveQuota(store, { ip: "1.1.1.1", kind: "download", now, limits: wide }).ok, true);
    assert.equal(reserveQuota(store, { ip: "1.1.1.1", kind: "download", now, limits: wide }).ok, false);
    assert.equal(store.get("1.1.1.1")?.download, 1);
  });
});
