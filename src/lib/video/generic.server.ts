import { VideoError } from "@/lib/video/errors";
import type { InspectResult, VideoFormat } from "@/lib/video/format";
import { fileStem } from "@/lib/video/format";
import {
  assertMediaResponse,
  assertPublicHttpUrl,
  headerSize,
  mediaHeaders,
  readTextLimited,
  safeFetch,
} from "@/lib/video/http.server";

type Candidate = { url: string; ext: string; score: number };

const MEDIA_EXT = /\.(mp4|webm|m4v|mov|m4a|mp3|ogv|ogg|m3u8)(?:$|\?)/i;

function decodeEntities(value: string): string {
  return value
    .replace(/&/g, "&")
    .replace(/"/g, '"')
    .replace(/&#0?39;|'/g, "'")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/\\u0026/g, "&")
    .replace(/\\u002F/gi, "/")
    .replace(/\\\//g, "/");
}

function extOf(url: string): string | null {
  const match = url.toLowerCase().match(MEDIA_EXT);
  if (!match?.[1]) return null;
  const ext = match[1];
  if (ext === "ogv" || ext === "ogg") return "ogv";
  return ext;
}

function scoreOf(url: string): number {
  const value = url.toLowerCase();
  if (/\.(jpg|jpeg|png|gif|webp|svg|css|js)(?:$|\?)/.test(value)) return -1;
  if (value.includes("thumbnail") || value.includes("poster") || value.includes("sprite")) return -1;
  let score = 0;
  if (value.includes(".mp4")) score += 50;
  else if (value.includes(".webm") || value.includes(".m4v")) score += 40;
  else if (value.includes(".mov")) score += 28;
  else if (value.includes(".m3u8")) score += 18;
  else if (value.includes(".m4a") || value.includes(".mp3")) score += 12;
  else if (value.includes(".ogv") || value.includes(".ogg")) score += 16;
  if (value.includes("1080")) score += 8;
  if (value.includes("720")) score += 5;
  return score;
}

function pushCandidate(list: Candidate[], raw: string, base: URL) {
  const decoded = decodeEntities(raw.trim());
  if (!decoded || decoded.startsWith("blob:") || decoded.startsWith("data:")) return;
  let absolute: URL;
  try {
    absolute = new URL(decoded, base);
  } catch {
    return;
  }
  if (absolute.protocol !== "http:" && absolute.protocol !== "https:") return;
  const ext = extOf(absolute.pathname + absolute.search) ?? extOf(absolute.href);
  if (!ext) return;
  const score = scoreOf(absolute.href);
  if (score < 0) return;
  list.push({ url: absolute.toString(), ext, score });
}

function metaContent(html: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`, "i"),
  ];
  for (const pattern of patterns) {
    const found = html.match(pattern)?.[1];
    if (found) return decodeEntities(found);
  }
  return null;
}

function collect(html: string, base: URL): Candidate[] {
  const found: Candidate[] = [];
  const keys = [
    "og:video",
    "og:video:url",
    "og:video:secure_url",
    "twitter:player:stream",
  ];
  for (const key of keys) {
    const value = metaContent(html, key);
    if (value) pushCandidate(found, value, base);
  }
  for (const match of html.matchAll(/<(?:video|audio|source)\b[^>]*\bsrc=["']([^"']+)["']/gi)) {
    if (match[1]) pushCandidate(found, match[1], base);
  }
  for (const match of html.matchAll(/https?:\\?\/\\?\/[^"'\\\s<>]+?\.(?:mp4|webm|m4v|mov|m3u8|m4a|mp3|ogv)(?:\?[^"'\\\s<>]*)?/gi)) {
    pushCandidate(found, match[0].replace(/\\\//g, "/"), base);
  }
  const deduped = new Map<string, Candidate>();
  for (const item of found) {
    const key = item.url.split("#")[0] ?? item.url;
    const prev = deduped.get(key);
    if (!prev || item.score > prev.score) deduped.set(key, item);
  }
  return [...deduped.values()].sort((a, b) => b.score - a.score).slice(0, 5);
}

function titleFrom(html: string, page: URL): string {
  return (
    metaContent(html, "og:title") ||
    html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() ||
    decodeURIComponent(page.pathname.split("/").filter(Boolean).pop() || "视频")
  );
}

function directExt(page: URL): string | null {
  return extOf(page.pathname);
}

async function publicOrNull(url: string): Promise<string | null> {
  try {
    return (await assertPublicHttpUrl(url)).toString();
  } catch {
    return null;
  }
}

export async function inspectGeneric(page: URL): Promise<InspectResult> {
  const direct = directExt(page);
  if (direct === "m3u8") {
    return {
      title: decodeURIComponent(page.pathname.split("/").pop() || "播放列表"),
      author: null,
      thumbnail: null,
      duration: null,
      source: "播放列表",
      pageUrl: page.toString(),
      formats: [
        {
          id: "hls:direct",
          label: "合并播放列表",
          ext: "ts",
          size: null,
          hasAudio: true,
          hasVideo: true,
        },
      ],
    };
  }
  if (direct) {
    const head = await safeFetch(page.toString(), {
      headers: mediaHeaders(page.origin),
      method: "GET",
    });
    const type = head.headers.get("content-type") || "";
    const size = headerSize(head.headers);
    await head.body?.cancel().catch(() => {});
    if (/text\/html/i.test(type)) {
      // Extension lied; fall through by refetching as a page below.
    } else {
      const audio = direct === "m4a" || direct === "mp3";
      return {
        title: decodeURIComponent(page.pathname.split("/").pop() || "视频"),
        author: null,
        thumbnail: null,
        duration: null,
        source: "直链",
        pageUrl: page.toString(),
        formats: [
          {
            id: "direct",
            label: audio ? "音频文件" : "视频文件",
            ext: direct === "ogv" ? "ogv" : direct,
            size,
            hasAudio: true,
            hasVideo: !audio,
          },
        ],
      };
    }
  }

  const response = await safeFetch(page.toString(), {
    headers: {
      "User-Agent": mediaHeaders().get("User-Agent")!,
      Accept: "text/html,application/xhtml+xml,video/*,*/*",
    },
  });
  const type = response.headers.get("content-type") || "";
  if (/^video\/|^audio\//i.test(type)) {
    const size = headerSize(response.headers);
    await response.body?.cancel().catch(() => {});
    const audio = /^audio\//i.test(type);
    const ext = audio ? "m4a" : type.includes("webm") ? "webm" : "mp4";
    return {
      title: decodeURIComponent(page.pathname.split("/").pop() || "视频"),
      author: null,
      thumbnail: null,
      duration: null,
      source: "直链",
      pageUrl: page.toString(),
      formats: [
        {
          id: "direct",
          label: audio ? "音频文件" : "视频文件",
          ext,
          size,
          hasAudio: true,
          hasVideo: !audio,
        },
      ],
    };
  }
  const html = await readTextLimited(response);
  const candidates = collect(html, page);
  if (candidates.length === 0) {
    throw new VideoError("这个页面里没有找到公开的视频文件。加密视频、需要登录的视频，目前下不了。");
  }
  const checked: Candidate[] = [];
  for (const candidate of candidates) {
    const safe = await publicOrNull(candidate.url);
    if (safe) checked.push({ ...candidate, url: safe });
  }
  if (checked.length === 0) throw new VideoError("页面里的视频地址不能访问");
  const thumb = metaContent(html, "og:image");
  const durationRaw = metaContent(html, "video:duration") || metaContent(html, "og:video:duration");
  const duration = durationRaw && /^\d+$/.test(durationRaw) ? Number(durationRaw) : null;
  const formats: VideoFormat[] = checked.map((candidate, index) => ({
    id: candidate.ext === "m3u8" ? `hls:${index}` : `pick:${index}`,
    label: candidate.ext === "m3u8" ? `流媒体 ${index + 1}` : `视频 ${index + 1}`,
    ext: candidate.ext === "m3u8" ? "ts" : candidate.ext,
    size: null,
    hasAudio: true,
    hasVideo: candidate.ext !== "m4a" && candidate.ext !== "mp3",
  }));
  if (formats.length === 1 && formats[0]) {
    formats[0].label = formats[0].ext === "ts" ? "合并播放列表" : "页面中的视频";
  }
  return {
    title: titleFrom(html, page),
    author: metaContent(html, "og:site_name") || metaContent(html, "author"),
    thumbnail: thumb && (await publicOrNull(new URL(thumb, page).toString())),
    duration,
    source: "网页",
    pageUrl: page.toString(),
    formats,
  };
}

async function candidatesFrom(page: URL): Promise<{ title: string; items: Candidate[] }> {
  const response = await safeFetch(page.toString(), {
    headers: {
      "User-Agent": mediaHeaders().get("User-Agent")!,
      Accept: "text/html,application/xhtml+xml,*/*",
    },
  });
  const html = await readTextLimited(response);
  return { title: titleFrom(html, page), items: collect(html, page) };
}

export async function openGeneric(
  page: URL,
  formatId: string,
): Promise<{ filename: string; contentType: string; size: number | null; body: ReadableStream<Uint8Array> }> {
  if (formatId === "hls:direct" || (directExt(page) === "m3u8" && formatId.startsWith("hls"))) {
    const segments = await hlsSegments(page.toString(), page.origin);
    const movie = segments.some((url) => /\.m4s|\.mp4/i.test(url));
    const stem = decodeURIComponent(page.pathname.split("/").pop() || "playlist");
    return {
      filename: `${fileStem(stem.replace(/\.[^.]+$/, ""))}.${movie ? "mp4" : "ts"}`,
      contentType: movie ? "video/mp4" : "video/mp2t",
      size: null,
      body: concatUrls(segments, page.origin),
    };
  }
  if (formatId === "direct" || directExt(page)) {
    if (formatId === "direct" || !formatId.startsWith("pick:") && !formatId.startsWith("hls:")) {
      const upstream = await safeFetch(page.toString(), { headers: mediaHeaders(page.origin) });
      assertMediaResponse(upstream, page.toString());
      if (!upstream.body) throw new VideoError("视频内容是空的");
      const ext = directExt(page) || "mp4";
      const name = decodeURIComponent(page.pathname.split("/").pop() || `video.${ext}`);
      return {
        filename: name.includes(".") ? fileStem(name.replace(/\.[^.]+$/, "")) + `.${ext === "m3u8" ? "ts" : ext}` : `${fileStem(name)}.${ext}`,
        contentType: upstream.headers.get("content-type")?.split(";")[0] || "video/mp4",
        size: headerSize(upstream.headers),
        body: upstream.body,
      };
    }
  }
  const { title, items } = await candidatesFrom(page);
  const index = Number(formatId.split(":")[1] ?? "0");
  const item = items[index];
  if (!item) throw new VideoError("这个视频地址已经失效，请重新解析");
  if (item.ext === "m3u8" || formatId.startsWith("hls:")) {
    const segments = await hlsSegments(item.url, page.origin);
    const movie = segments.some((url) => /\.m4s|\.mp4/i.test(url));
    return {
      filename: `${fileStem(title)}.${movie ? "mp4" : "ts"}`,
      contentType: movie ? "video/mp4" : "video/mp2t",
      size: null,
      body: concatUrls(segments, page.origin),
    };
  }
  const upstream = await safeFetch(item.url, { headers: mediaHeaders(page.origin) });
  assertMediaResponse(upstream, item.url);
  if (!upstream.body) throw new VideoError("视频内容是空的");
  return {
    filename: `${fileStem(title)}.${item.ext}`,
    contentType: upstream.headers.get("content-type")?.split(";")[0] || "application/octet-stream",
    size: headerSize(upstream.headers),
    body: upstream.body,
  };
}

async function hlsSegments(playlistUrl: string, referer: string, depth = 0): Promise<string[]> {
  if (depth > 3) throw new VideoError("播放列表嵌套过深");
  const response = await safeFetch(playlistUrl, { headers: mediaHeaders(referer) });
  if (!response.ok) throw new VideoError("无法读取播放列表");
  const text = await readTextLimited(response, 1_000_000);
  if (/#EXT-X-KEY(?![^\n]*METHOD=NONE)/i.test(text)) {
    throw new VideoError("这条视频使用了加密流，不能直接保存");
  }
  if (text.includes("#EXT-X-STREAM-INF")) {
    const lines = text.split(/\r?\n/);
    let bestBandwidth = -1;
    let bestUri = "";
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (!line.startsWith("#EXT-X-STREAM-INF")) continue;
      const bandwidth = Number(line.match(/BANDWIDTH=(\d+)/)?.[1] ?? 0);
      const uri = (lines[i + 1] ?? "").trim();
      if (uri && !uri.startsWith("#") && bandwidth >= bestBandwidth) {
        bestBandwidth = bandwidth;
        bestUri = uri;
      }
    }
    if (!bestUri) throw new VideoError("播放列表里没有可用的清晰度");
    return hlsSegments(new URL(bestUri, playlistUrl).toString(), referer, depth + 1);
  }
  const segments: string[] = [];
  const map = text.match(/#EXT-X-MAP:URI="([^"]+)"/);
  if (map?.[1]) segments.push(new URL(map[1], playlistUrl).toString());
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    segments.push(new URL(trimmed, playlistUrl).toString());
  }
  if (segments.length === 0) throw new VideoError("播放列表是空的");
  if (segments.length > 800) throw new VideoError("分片太多，这条流暂时保存不了");
  const safe: string[] = [];
  for (const segment of segments) {
    safe.push((await assertPublicHttpUrl(segment)).toString());
  }
  return safe;
}

function concatUrls(urls: string[], referer: string): ReadableStream<Uint8Array> {
  let index = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  return new ReadableStream({
    async pull(controller) {
      while (true) {
        if (!reader) {
          if (index >= urls.length) {
            controller.close();
            return;
          }
          const upstream = await safeFetch(urls[index]!, { headers: mediaHeaders(referer) });
          const current = urls[index]!;
          index += 1;
          assertMediaResponse(upstream, current);
          if (!upstream.body) throw new VideoError("分片下载失败");
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
