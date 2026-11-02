import { createHash } from "node:crypto";

import { VideoError } from "./errors.ts";
import { fileStem, type InspectResult, type VideoFormat } from "./format.ts";
import {
  BROWSER_UA,
  assertMediaResponse,
  headerSize,
  mediaHeaders,
  safeFetch,
} from "./http.server.ts";

const MIXIN = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
  28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
  54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

const QN_LABEL: Record<number, string> = {
  127: "8K",
  126: "杜比视界",
  125: "HDR",
  120: "4K",
  116: "1080P60",
  112: "1080P+",
  80: "1080P",
  64: "720P",
  32: "480P",
  16: "360P",
};

const API_HEADERS = {
  "User-Agent": BROWSER_UA,
  Referer: "https://www.bilibili.com/",
  Origin: "https://www.bilibili.com",
};

type ViewData = {
  title?: string;
  owner?: { name?: string };
  pic?: string;
  duration?: number;
  cid?: number;
  videos?: number;
  pages?: { cid: number; page: number; part: string }[];
};

type PlayPart = { url: string; size: number; backup_url?: string[] };

type PlayData = {
  quality?: number;
  timelength?: number;
  durl?: PlayPart[];
};

let wbiCache: { key: string; at: number } | null = null;

function mixinKey(imgKey: string, subKey: string): string {
  return MIXIN.map((index) => (imgKey + subKey)[index] ?? "")
    .join("")
    .slice(0, 32);
}

async function wbiKey(): Promise<string> {
  if (wbiCache && Date.now() - wbiCache.at < 30 * 60 * 1000) return wbiCache.key;
  const response = await safeFetch("https://api.bilibili.com/x/web-interface/nav", {
    headers: API_HEADERS,
  });
  const json = (await response.json()) as {
    data?: { wbi_img?: { img_url?: string; sub_url?: string } };
  };
  const img = json.data?.wbi_img?.img_url?.split("/").pop()?.split(".")[0] ?? "";
  const sub = json.data?.wbi_img?.sub_url?.split("/").pop()?.split(".")[0] ?? "";
  if (!img || !sub) throw new VideoError("哔哩哔哩签名获取失败");
  wbiCache = { key: mixinKey(img, sub), at: Date.now() };
  return wbiCache.key;
}

function sign(params: Record<string, string | number>, key: string): string {
  const wts = Math.round(Date.now() / 1000);
  const merged: Record<string, string> = { wts: String(wts) };
  for (const [name, value] of Object.entries(params)) {
    merged[name] = String(value).replace(/[!'()*]/g, "");
  }
  const query = Object.keys(merged)
    .sort()
    .map((name) => `${encodeURIComponent(name)}=${encodeURIComponent(merged[name] ?? "")}`)
    .join("&");
  const rid = createHash("md5").update(query + key).digest("hex");
  return `${query}&w_rid=${rid}`;
}

export function bilibiliIdentity(page: URL): { bvid?: string; aid?: string } {
  const bvid = page.href.match(/BV[0-9A-Za-z]{10}/)?.[0];
  const aid = page.pathname.match(/\/av(\d+)/i)?.[1] ?? page.searchParams.get("aid") ?? undefined;
  return { bvid, aid };
}

export function bilibiliViewQuery(id: { bvid?: string; aid?: string }): string {
  if (!id.bvid && !id.aid) throw new VideoError("没有在链接里找到 BV 号或 av 号");
  return id.bvid ? `bvid=${id.bvid}` : `aid=${id.aid}`;
}

export type BilibiliPartChoice = {
  cid: number;
  part: string | null;
  page: number;
  parts: { page: number; title: string }[];
};

export function selectBilibiliPart(
  view: { cid?: number; pages?: { cid: number; page: number; part?: string }[] },
  wantedRaw: string | null,
): BilibiliPartChoice {
  const wanted = Number(wantedRaw || "1");
  const pages = view.pages ?? [];
  const selected = pages.find((item) => item.page === wanted) ?? pages[0];
  const cid = selected?.cid ?? view.cid;
  if (!cid) throw new VideoError("读不到视频分片信息");
  const parts = pages.map((item, index) => ({
    page: item.page,
    title: item.part?.trim() || `第 ${item.page || index + 1} P`,
  }));
  const page = selected?.page ?? (Number.isFinite(wanted) && wanted > 0 ? wanted : 1);
  return {
    cid,
    part: pages.length > 1 ? (selected?.part?.trim() || null) : null,
    page,
    parts,
  };
}

export function bilibiliUnsupportedReason(page: URL): string | null {
  if (page.hostname.includes("live.bilibili.com")) {
    return "直播间没有可保存的完整视频文件";
  }
  if (page.pathname.includes("/bangumi/")) {
    return "番剧页面通常有地区或登录限制，这里拿不到视频文件";
  }
  return null;
}

export function qualityFromFormatId(formatId: string): number {
  const quality = Number(formatId.split(":")[1] || "80");
  return Number.isFinite(quality) ? quality : 80;
}

export function formatsFromPlayResponses(
  settled: Array<{ quality?: number; durl?: { size?: number }[] } | null>,
): VideoFormat[] {
  const formats: VideoFormat[] = [];
  const seen = new Set<string>();
  for (const data of settled) {
    if (!data?.durl?.[0]) continue;
    const quality = data.quality ?? 0;
    const size = data.durl.reduce((sum, partUrl) => sum + (partUrl.size || 0), 0);
    const key = `${quality}:${size}`;
    if (seen.has(key)) continue;
    seen.add(key);
    formats.push({
      id: `bili:${quality}`,
      label: QN_LABEL[quality] ?? `${quality}P`,
      ext: "mp4",
      size: size || null,
      hasAudio: true,
      hasVideo: true,
    });
  }
  return formats;
}

async function loadView(
  page: URL,
): Promise<{ view: ViewData; cid: number; part: string | null; page: number; parts: { page: number; title: string }[] }> {
  const query = bilibiliViewQuery(bilibiliIdentity(page));
  const response = await safeFetch(`https://api.bilibili.com/x/web-interface/view?${query}`, {
    headers: API_HEADERS,
  });
  const json = (await response.json()) as { code?: number; message?: string; data?: ViewData };
  if (json.code !== 0 || !json.data) {
    throw new VideoError(json.message || "读不到这个哔哩哔哩视频");
  }
  const selected = selectBilibiliPart(json.data, page.searchParams.get("p"));
  return { view: json.data, ...selected };
}

async function playurl(page: URL, cid: number, qn: number): Promise<PlayData> {
  const { bvid, aid } = bilibiliIdentity(page);
  const key = await wbiKey();
  const params: Record<string, string | number> = {
    cid,
    qn,
    fnval: 1,
    fnver: 0,
    fourk: 1,
  };
  if (bvid) params.bvid = bvid;
  if (aid) params.aid = aid;
  const response = await safeFetch(
    `https://api.bilibili.com/x/player/wbi/playurl?${sign(params, key)}`,
    { headers: API_HEADERS },
  );
  const json = (await response.json()) as { code?: number; message?: string; data?: PlayData };
  if (json.code !== 0 || !json.data?.durl?.length) {
    throw new VideoError(json.message || "哔哩哔哩没有返回可下载的视频地址");
  }
  return json.data;
}

function partCandidates(part: PlayPart): string[] {
  return [part.url, ...(part.backup_url ?? [])].filter(Boolean);
}

function looksLikeMedia(response: Response): boolean {
  if (response.status === 401 || response.status === 403 || response.status === 567) return false;
  if (!response.ok) return false;
  const type = (response.headers.get("content-type") || "").split(";")[0]?.trim() ?? "";
  if (!type) return true;
  return /^(video\/|audio\/|application\/octet-stream|application\/mp4|binary\/octet-stream)/i.test(type);
}

async function openCandidate(urls: string[], referer: string): Promise<Response> {
  let last: Response | null = null;
  for (const url of urls) {
    const response = await safeFetch(url, { headers: mediaHeaders(referer) });
    if (looksLikeMedia(response)) return response;
    last = response;
    await response.body?.cancel().catch(() => {});
  }
  if (last) assertMediaResponse(last, urls.at(-1) ?? "");
  throw new VideoError("没有可下载的视频地址");
}

export async function inspectBilibili(page: URL): Promise<InspectResult> {
  const unsupported = bilibiliUnsupportedReason(page);
  if (unsupported) throw new VideoError(unsupported);
  const { view, cid, part, page: pageNo, parts } = await loadView(page);
  const asks = [80, 64, 32, 16];
  const settled = await Promise.all(
    asks.map(async (qn) => {
      try {
        return await playurl(page, cid, qn);
      } catch {
        return null;
      }
    }),
  );
  const formats = formatsFromPlayResponses(settled);
  if (formats.length === 0) throw new VideoError("这个哔哩哔哩视频没有公开的视频文件");
  const title = part ? `${view.title ?? "哔哩哔哩视频"} · ${part}` : (view.title ?? "哔哩哔哩视频");
  return {
    title,
    author: view.owner?.name ?? null,
    thumbnail: view.pic ?? null,
    duration: view.duration ?? null,
    source: "哔哩哔哩",
    pageUrl: page.toString(),
    formats,
    parts,
    page: pageNo,
  };
}

export async function openBilibili(
  page: URL,
  formatId: string,
): Promise<{ filename: string; contentType: string; size: number | null; body: ReadableStream<Uint8Array> }> {
  const unsupported = bilibiliUnsupportedReason(page);
  if (unsupported) throw new VideoError(unsupported);
  const quality = qualityFromFormatId(formatId);
  const { view, cid, part } = await loadView(page);
  const data = await playurl(page, cid, quality);
  const parts = data.durl ?? [];
  const groups = parts.map(partCandidates).filter((urls) => urls.length > 0);
  if (groups.length === 0) throw new VideoError("没有可下载的视频地址");
  const title = part ? `${view.title ?? "bilibili"} · ${part}` : (view.title ?? "bilibili");
  const size = parts.reduce((sum, item) => sum + (item.size || 0), 0) || null;
  if (groups.length === 1) {
    const upstream = await openCandidate(groups[0]!, "https://www.bilibili.com/");
    if (!upstream.body) throw new VideoError("视频内容是空的");
    return {
      filename: `${fileStem(title)}.mp4`,
      contentType: "video/mp4",
      size: headerSize(upstream.headers) ?? size,
      body: upstream.body,
    };
  }
  return {
    filename: `${fileStem(title)}.mp4`,
    contentType: "video/mp4",
    size,
    body: concatParts(groups, "https://www.bilibili.com/"),
  };
}

function concatParts(groups: string[][], referer: string): ReadableStream<Uint8Array> {
  let index = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  return new ReadableStream({
    async pull(controller) {
      while (true) {
        if (!reader) {
          if (index >= groups.length) {
            controller.close();
            return;
          }
          const upstream = await openCandidate(groups[index]!, referer);
          index += 1;
          if (!upstream.body) throw new VideoError("视频分段是空的");
          reader = upstream.body.getReader();
        }
        const { done, value } = await reader.read();
        if (done) {
          reader = null;
          continue;
        }
        controller.enqueue(value);
        return;
      }
    },
    cancel() {
      reader?.cancel().catch(() => {});
    },
  });
}
