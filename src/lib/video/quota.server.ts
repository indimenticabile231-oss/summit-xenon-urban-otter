import { isIP } from "node:net";

/**
 * Per-IP quotas for `/api/inspect` and `/api/download`.
 *
 * 落片不把登录当作下载门槛：默认关掉 Better Auth（`VITE_AUTH_ENABLED=false`），
 * 粘贴链接就能解析。这里用 IP 额度挡住把站点当公开代理的用法。
 * 计数在进程内存里，重启或多实例不会共享。
 *
 * 客户端地址取 `X-Forwarded-For` 里最后一个合法 IP（边缘代理追加的那一跳），
 * 没有则看 `cf-connecting-ip`、`x-real-ip`。进程如果被直接打到，这些头可以伪造。
 */

export type QuotaKind = "inspect" | "download";

export type QuotaLimits = {
  inspectPerDay: number;
  downloadPerDay: number;
  inspectPerWindow: number;
  downloadPerWindow: number;
  windowMs: number;
};

export const DEFAULT_QUOTA: QuotaLimits = {
  inspectPerDay: 120,
  downloadPerDay: 40,
  inspectPerWindow: 30,
  downloadPerWindow: 10,
  windowMs: 10 * 60 * 1000,
};

export type QuotaState = {
  day: string;
  inspect: number;
  download: number;
  windowStart: number;
  windowInspect: number;
  windowDownload: number;
};

export type QuotaDecision =
  | { ok: true }
  | { ok: false; message: string; retryAfterSec: number };

const INSPECT_DAY = "今天的解析次数已经用完了，明天再试";
const INSPECT_WINDOW = "解析太频繁了，请过几分钟再试";
const DOWNLOAD_DAY = "今天的下载次数已经用完了，明天再试";
const DOWNLOAD_WINDOW = "下载太频繁了，请过几分钟再试";

export function quotaDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.LUOPIAN_QUOTA_DISABLED?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export function quotaLimits(env: NodeJS.ProcessEnv = process.env): QuotaLimits {
  return {
    inspectPerDay: positiveInt(env.LUOPIAN_INSPECT_PER_DAY, DEFAULT_QUOTA.inspectPerDay),
    downloadPerDay: positiveInt(env.LUOPIAN_DOWNLOAD_PER_DAY, DEFAULT_QUOTA.downloadPerDay),
    inspectPerWindow: positiveInt(env.LUOPIAN_INSPECT_PER_WINDOW, DEFAULT_QUOTA.inspectPerWindow),
    downloadPerWindow: positiveInt(env.LUOPIAN_DOWNLOAD_PER_WINDOW, DEFAULT_QUOTA.downloadPerWindow),
    windowMs: positiveInt(env.LUOPIAN_QUOTA_WINDOW_MS, DEFAULT_QUOTA.windowMs, 86_400_000),
  };
}

function positiveInt(raw: string | undefined, fallback: number, max = 100_000): number {
  if (raw == null || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) return fallback;
  return value;
}

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function normalizeIp(raw: string): string | null {
  let value = raw.trim();
  if (!value) return null;
  if (value.startsWith("[") && value.includes("]")) {
    value = value.slice(1, value.indexOf("]"));
  } else {
    const v4Port = /^(\d+\.\d+\.\d+\.\d+):\d+$/.exec(value);
    if (v4Port) value = v4Port[1] ?? value;
  }
  return isIP(value) ? value : null;
}

/** Best-effort client IP. See the module comment for proxy trust. */
export function clientAddress(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded
      .split(",")
      .map((part) => normalizeIp(part))
      .filter((ip): ip is string => Boolean(ip));
    const last = hops.at(-1);
    if (last) return last;
  }
  return (
    normalizeIp(headers.get("cf-connecting-ip") ?? "") ??
    normalizeIp(headers.get("x-real-ip") ?? "") ??
    "unknown"
  );
}

function secondsUntilUtcMidnight(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

function freshState(day: string, nowMs: number): QuotaState {
  return {
    day,
    inspect: 0,
    download: 0,
    windowStart: nowMs,
    windowInspect: 0,
    windowDownload: 0,
  };
}

export function reserveQuota(
  store: Map<string, QuotaState>,
  input: { ip: string; kind: QuotaKind; now?: Date; limits?: QuotaLimits },
): QuotaDecision {
  const now = input.now ?? new Date();
  const limits = input.limits ?? DEFAULT_QUOTA;
  const day = utcDay(now);
  let state = store.get(input.ip);
  if (!state || state.day !== day) {
    state = freshState(day, now.getTime());
    store.set(input.ip, state);
  } else if (now.getTime() - state.windowStart >= limits.windowMs) {
    state.windowStart = now.getTime();
    state.windowInspect = 0;
    state.windowDownload = 0;
  }

  if (store.size > 4000) {
    for (const [key, value] of store) {
      if (value.day !== day) store.delete(key);
    }
  }

  if (input.kind === "inspect") {
    if (state.inspect >= limits.inspectPerDay) {
      return { ok: false, message: INSPECT_DAY, retryAfterSec: secondsUntilUtcMidnight(now) };
    }
    if (state.windowInspect >= limits.inspectPerWindow) {
      return {
        ok: false,
        message: INSPECT_WINDOW,
        retryAfterSec: windowRetry(state, now.getTime(), limits.windowMs),
      };
    }
    state.inspect += 1;
    state.windowInspect += 1;
    return { ok: true };
  }

  if (state.download >= limits.downloadPerDay) {
    return { ok: false, message: DOWNLOAD_DAY, retryAfterSec: secondsUntilUtcMidnight(now) };
  }
  if (state.windowDownload >= limits.downloadPerWindow) {
    return {
      ok: false,
      message: DOWNLOAD_WINDOW,
      retryAfterSec: windowRetry(state, now.getTime(), limits.windowMs),
    };
  }
  state.download += 1;
  state.windowDownload += 1;
  return { ok: true };
}

function windowRetry(state: QuotaState, nowMs: number, windowMs: number): number {
  return Math.max(1, Math.ceil((state.windowStart + windowMs - nowMs) / 1000));
}

const liveStore = new Map<string, QuotaState>();

export function takeRequestQuota(
  request: Request,
  kind: QuotaKind,
  now = new Date(),
): { denial: { message: string; retryAfterSec: number } | null } {
  if (quotaDisabled()) return { denial: null };
  const decision = reserveQuota(liveStore, {
    ip: clientAddress(request.headers),
    kind,
    now,
    limits: quotaLimits(),
  });
  if (decision.ok) return { denial: null };
  return { denial: { message: decision.message, retryAfterSec: decision.retryAfterSec } };
}
