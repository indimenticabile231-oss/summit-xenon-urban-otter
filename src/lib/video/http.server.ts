import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

import { VideoError } from "./errors.ts";

const block = new BlockList();
block.addSubnet("0.0.0.0", 8, "ipv4");
block.addSubnet("10.0.0.0", 8, "ipv4");
block.addSubnet("100.64.0.0", 10, "ipv4");
block.addSubnet("127.0.0.0", 8, "ipv4");
block.addSubnet("169.254.0.0", 16, "ipv4");
block.addSubnet("172.16.0.0", 12, "ipv4");
block.addSubnet("192.0.0.0", 24, "ipv4");
block.addSubnet("192.0.2.0", 24, "ipv4");
block.addSubnet("192.168.0.0", 16, "ipv4");
block.addSubnet("198.18.0.0", 15, "ipv4");
block.addSubnet("198.51.100.0", 24, "ipv4");
block.addSubnet("203.0.113.0", 24, "ipv4");
block.addSubnet("224.0.0.0", 3, "ipv4");
block.addAddress("::1", "ipv6");
block.addSubnet("fc00::", 7, "ipv6");
block.addSubnet("fe80::", 10, "ipv6");
block.addSubnet("ff00::", 8, "ipv6");

export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const MAX_REDIRECTS = 5;

export function normalizeInput(raw: string): string {
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[\w.-]+\.[a-z]{2,}(?:[/?#]|$)/i.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

function ipIsBlocked(ip: string): boolean {
  const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return block.check(mapped[1], "ipv4");
  const kind = isIP(ip);
  if (kind === 4) return block.check(ip, "ipv4");
  if (kind === 6) return block.check(ip, "ipv6");
  return true;
}

function hostLooksLocal(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localdomain")) return true;
  if (host === "metadata.google.internal" || host === "metadata.internal") return true;
  if (/^\d+$/.test(host)) return true;
  return false;
}

function parsePublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new VideoError("这不是一个有效的网页链接");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new VideoError("只支持 http 或 https 链接");
  }
  if (url.username || url.password) throw new VideoError("链接里不能带账号密码");
  if (hostLooksLocal(url.hostname)) throw new VideoError("不能访问内网地址");
  return url;
}

/**
 * Same policy as `assertPublicHttpUrl`, with DNS answers supplied by the caller.
 * Literal IP hosts ignore `addresses`. Non-literal hosts are rejected when any
 * answer is missing or blocked. Production always passes the real lookup result.
 */
export function assertResolvedPublicHttpUrl(raw: string, addresses: readonly string[]): URL {
  const url = parsePublicHttpUrl(raw);
  if (isIP(url.hostname)) {
    if (ipIsBlocked(url.hostname)) throw new VideoError("不能访问内网地址");
    return url;
  }
  if (addresses.length === 0 || addresses.some((address) => ipIsBlocked(address))) {
    throw new VideoError("不能访问内网地址");
  }
  return url;
}

export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  const url = parsePublicHttpUrl(raw);
  // Node keeps brackets on IPv6 hostname (`[::1]`), so isIP() misses them.
  // Those URLs fall through to DNS and fail closed. Do not strip the brackets
  // without also blocking IPv4-mapped forms like `::ffff:7f00:1`: ipIsBlocked
  // only special-cases the dotted spelling `::ffff:127.0.0.1`.
  if (isIP(url.hostname)) return assertResolvedPublicHttpUrl(raw, []);
  let records: { address: string }[];
  try {
    records = await lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new VideoError("无法解析这个链接的地址");
  }
  return assertResolvedPublicHttpUrl(
    raw,
    records.map((record) => record.address),
  );
}

export async function safeFetch(raw: string, init: RequestInit = {}): Promise<Response> {
  let current = (await assertPublicHttpUrl(raw)).toString();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetch(current, {
      ...init,
      redirect: "manual",
      signal: init.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      if (!location) throw new VideoError("网站重定向不完整");
      current = (await assertPublicHttpUrl(new URL(location, current).toString())).toString();
      continue;
    }
    return response;
  }
  throw new VideoError("重定向次数过多");
}

export function mediaHeaders(referer?: string): Headers {
  const headers = new Headers();
  headers.set("User-Agent", BROWSER_UA);
  headers.set("Accept", "*/*");
  if (referer) headers.set("Referer", referer);
  return headers;
}

export async function readTextLimited(response: Response, maxBytes = 2_000_000): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    const room = maxBytes - total;
    chunks.push(room < value.byteLength ? value.slice(0, room) : value);
    total += Math.min(value.byteLength, room);
    if (value.byteLength > room) break;
  }
  await reader.cancel().catch(() => {});
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}

export function headerSize(headers: Headers): number | null {
  const range = headers.get("content-range");
  const total = range?.match(/\/(\d+)\s*$/)?.[1];
  if (total) return Number(total);
  const length = headers.get("content-length");
  if (length && /^\d+$/.test(length)) return Number(length);
  return null;
}

const MEDIA_TYPE =
  /^(video\/|audio\/|application\/octet-stream|application\/mp4|binary\/octet-stream)/i;

export function assertMediaResponse(response: Response, pageUrl: string): void {
  if (response.status === 403 || response.status === 401 || response.status === 567) {
    throw new VideoError("视频地址校验没通过，这条片子暂时下不了");
  }
  if (!response.ok) throw new VideoError(`视频地址返回了 ${response.status}，下不下来`);
  const type = (response.headers.get("content-type") || "").split(";")[0]?.trim() ?? "";
  if (!type) return;
  if (MEDIA_TYPE.test(type)) return;
  if (/mpegurl|mp2t/i.test(type)) return;
  const path = pageUrl.toLowerCase();
  if (/\.(mp4|webm|m4v|mov|m4a|mp3|ogv|ogg)(\?|$)/.test(path) && /octet-stream|binary/i.test(type)) return;
  throw new VideoError("这个地址打开的是网页，不是视频文件");
}
