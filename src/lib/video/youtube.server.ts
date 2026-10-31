import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { Readable } from "node:stream";

import { Innertube, Platform, UniversalCache } from "youtubei.js";

import { VideoError } from "@/lib/video/errors";
import type { InspectResult, VideoFormat } from "@/lib/video/format";
import { fileStem } from "@/lib/video/format";
import { BROWSER_UA, assertMediaResponse, headerSize, mediaHeaders, safeFetch } from "@/lib/video/http.server";

Platform.shim.eval = async (data) => {
  return new Function(data.output)();
};

type LooseFormat = {
  itag: number;
  url?: string;
  mime_type: string;
  quality_label?: string;
  bitrate: number;
  content_length?: number;
  height?: number;
  has_audio: boolean;
  has_video: boolean;
  decipher: (player?: unknown) => Promise<string>;
};

type LooseInfo = {
  basic_info: {
    title?: string;
    author?: string;
    duration?: number;
    is_live?: boolean;
    thumbnail?: { url: string; width?: number }[];
  };
  playability_status?: { status?: string };
  streaming_data?: {
    formats?: LooseFormat[];
    adaptive_formats?: LooseFormat[];
  };
};

let sessionPromise: Promise<Innertube> | null = null;

function session(): Promise<Innertube> {
  if (!sessionPromise) {
    sessionPromise = Innertube.create({
      cache: new UniversalCache(false),
      generate_session_locally: true,
    }).catch((error: unknown) => {
      sessionPromise = null;
      throw error;
    });
  }
  return sessionPromise;
}

export function youtubeId(page: URL): string | null {
  const host = page.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "youtu.be") {
    const id = page.pathname.split("/").filter(Boolean)[0] ?? "";
    return /^[\w-]{6,}$/.test(id) ? id : null;
  }
  if (page.pathname === "/watch") {
    const id = page.searchParams.get("v") ?? "";
    return /^[\w-]{6,}$/.test(id) ? id : null;
  }
  const match = page.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{6,})/);
  return match?.[1] ?? null;
}

const YT_CLIENTS = ["IOS", "MWEB", "WEB"] as const;

async function loadInfo(page: URL): Promise<{ info: LooseInfo; player: unknown }> {
  const id = youtubeId(page);
  if (!id) throw new VideoError("没有在链接里找到 YouTube 视频编号");
  const yt = await session();
  let last = "这个 YouTube 视频现在不能播放，可能有地区限制或需要登录";
  for (const client of YT_CLIENTS) {
    try {
      const info = (await yt.getInfo(id, { client })) as unknown as LooseInfo;
      if (info.basic_info.is_live) throw new VideoError("这是正在进行的直播，没有完整文件可保存");
      const status = info.playability_status?.status;
      if (status && status !== "OK") continue;
      if (allFormats(info).length === 0) {
        last = "这个 YouTube 视频没有可保存的文件";
        continue;
      }
      return { info, player: yt.session.player };
    } catch (error) {
      if (error instanceof VideoError) throw error;
      const message = error instanceof Error ? error.message : "";
      if (/sign in|login|bot|confirm you're not a bot/i.test(message)) {
        last = "YouTube 拒绝了这次解析，可能是站点的访问限制";
      } else if (message) {
        last = `YouTube 解析失败：${message.slice(0, 140)}`;
      }
    }
  }
  throw new VideoError(last);
}

function allFormats(info: LooseInfo): LooseFormat[] {
  const list = [...(info.streaming_data?.formats ?? []), ...(info.streaming_data?.adaptive_formats ?? [])];
  const byItag = new Map<number, LooseFormat>();
  for (const format of list) {
    if (!format?.itag || !format.mime_type) continue;
    const prev = byItag.get(format.itag);
    if (!prev || (format.content_length ?? 0) > (prev.content_length ?? 0)) byItag.set(format.itag, format);
  }
  return [...byItag.values()];
}

async function resolvedUrl(format: LooseFormat, player: unknown): Promise<string> {
  try {
    const url = await format.decipher(player);
    if (url) return url;
  } catch (error) {
    if (format.url) return format.url;
    const message = error instanceof Error ? error.message : "";
    throw new VideoError(message ? `YouTube 地址解析失败：${message}` : "YouTube 地址解析失败");
  }
  if (format.url) return format.url;
  throw new VideoError("YouTube 没有给出视频地址");
}

function ffmpegBin(): string | null {
  for (const candidate of ["/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function pickProgressive(formats: LooseFormat[]): LooseFormat | null {
  const list = formats
    .filter((format) => format.has_audio && format.has_video)
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
  return list[0] ?? null;
}

function pickVideo(formats: LooseFormat[]): LooseFormat | null {
  const avc = formats
    .filter((format) => format.has_video && !format.has_audio && format.mime_type.includes("avc1"))
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
  return avc[0] ?? null;
}

function pickAudio(formats: LooseFormat[]): LooseFormat | null {
  const aac = formats
    .filter((format) => format.has_audio && !format.has_video && format.mime_type.includes("mp4a"))
    .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
  return aac[0] ?? null;
}

export async function inspectYouTube(page: URL): Promise<InspectResult> {
  const { info } = await loadInfo(page);
  const formats = allFormats(info);
  const rows: VideoFormat[] = [];
  const progressive = pickProgressive(formats);
  const video = pickVideo(formats);
  const audio = pickAudio(formats);
  if (progressive) {
    rows.push({
      id: `yt:p:${progressive.itag}`,
      label: `${progressive.quality_label ?? "视频"} · 含声音`,
      ext: "mp4",
      size: progressive.content_length ?? null,
      hasAudio: true,
      hasVideo: true,
    });
  } else if (video && audio && ffmpegBin()) {
    rows.push({
      id: "yt:mux",
      label: `${video.quality_label ?? "视频"} · 含声音`,
      ext: "mp4",
      size: (video.content_length ?? 0) + (audio.content_length ?? 0) || null,
      hasAudio: true,
      hasVideo: true,
    });
  }
  if (video) {
    rows.push({
      id: `yt:v:${video.itag}`,
      label: `${video.quality_label ?? "画面"} · 仅画面`,
      ext: "mp4",
      size: video.content_length ?? null,
      hasAudio: false,
      hasVideo: true,
    });
  }
  if (audio) {
    rows.push({
      id: `yt:a:${audio.itag}`,
      label: "音频",
      ext: "m4a",
      size: audio.content_length ?? null,
      hasAudio: true,
      hasVideo: false,
    });
  }
  if (rows.length === 0) throw new VideoError("这个 YouTube 视频没有可保存的文件");
  const thumbs = info.basic_info.thumbnail ?? [];
  const thumb = thumbs.find((item) => (item.width ?? 0) >= 320) ?? thumbs.at(-1);
  return {
    title: info.basic_info.title || "YouTube 视频",
    author: info.basic_info.author ?? null,
    thumbnail: thumb?.url ?? null,
    duration: info.basic_info.duration ?? null,
    source: "YouTube",
    pageUrl: page.toString(),
    formats: rows,
  };
}

async function fetchMedia(url: string): Promise<Response> {
  const response = await safeFetch(url, { headers: mediaHeaders("https://www.youtube.com/") });
  assertMediaResponse(response, url);
  return response;
}

function muxStream(videoUrl: string, audioUrl: string): ReadableStream<Uint8Array> {
  const bin = ffmpegBin();
  if (!bin) throw new VideoError("当前环境不能把画面和声音合成一个文件");
  const child = spawn(
    bin,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-user_agent",
      BROWSER_UA,
      "-i",
      videoUrl,
      "-user_agent",
      BROWSER_UA,
      "-i",
      audioUrl,
      "-c",
      "copy",
      "-movflags",
      "frag_keyframe+empty_moov+default_base_moof",
      "-f",
      "mp4",
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stderr?.resume();
  if (!child.stdout) throw new VideoError("合成视频失败");
  return Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
}

export async function openYouTube(
  page: URL,
  formatId: string,
): Promise<{ filename: string; contentType: string; size: number | null; body: ReadableStream<Uint8Array> }> {
  const { info, player } = await loadInfo(page);
  const formats = allFormats(info);
  const title = info.basic_info.title || "youtube";
  if (formatId === "yt:mux") {
    const video = pickVideo(formats);
    const audio = pickAudio(formats);
    if (!video || !audio) throw new VideoError("没有可合成的画面和声音");
    const [videoUrl, audioUrl] = await Promise.all([
      resolvedUrl(video, player),
      resolvedUrl(audio, player),
    ]);
    await Promise.all([
      fetchMedia(videoUrl).then((response) => response.body?.cancel()),
      fetchMedia(audioUrl).then((response) => response.body?.cancel()),
    ]);
    return {
      filename: `${fileStem(title)}.mp4`,
      contentType: "video/mp4",
      size: null,
      body: muxStream(videoUrl, audioUrl),
    };
  }
  const itag = Number(formatId.split(":").pop());
  const format = formats.find((item) => item.itag === itag);
  if (!format) throw new VideoError("这个清晰度已经失效，请重新解析");
  const url = await resolvedUrl(format, player);
  const upstream = await fetchMedia(url);
  if (!upstream.body) throw new VideoError("视频内容是空的");
  const audioOnly = formatId.startsWith("yt:a:");
  return {
    filename: `${fileStem(title)}.${audioOnly ? "m4a" : "mp4"}`,
    contentType: audioOnly ? "audio/mp4" : "video/mp4",
    size: headerSize(upstream.headers) ?? format.content_length ?? null,
    body: upstream.body,
  };
}
