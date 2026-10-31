import { inspectBilibili, openBilibili } from "@/lib/video/bilibili.server";
import { VideoError } from "@/lib/video/errors";
import type { InspectResult } from "@/lib/video/format";
import { BROWSER_UA, assertPublicHttpUrl, normalizeInput, safeFetch } from "@/lib/video/http.server";

type Opened = {
  filename: string;
  contentType: string;
  size: number | null;
  body: ReadableStream<Uint8Array>;
};

function hostOf(page: URL): string {
  return page.hostname.toLowerCase().replace(/^www\./, "");
}

function isYouTube(page: URL): boolean {
  const host = hostOf(page);
  return (
    host === "youtu.be" ||
    host === "youtube.com" ||
    host.endsWith(".youtube.com") ||
    host === "youtube-nocookie.com" ||
    host.endsWith(".youtube-nocookie.com")
  );
}

function isBilibili(page: URL): boolean {
  const host = hostOf(page);
  return host === "b23.tv" || host === "bilibili.com" || host.endsWith(".bilibili.com");
}

function alreadyConcrete(page: URL): boolean {
  return (
    isBilibili(page) && (/BV[0-9A-Za-z]{10}/.test(page.href) || /\/av\d+/i.test(page.pathname))
  );
}

async function settlePage(raw: string): Promise<URL> {
  const start = await assertPublicHttpUrl(normalizeInput(raw));
  if (alreadyConcrete(start)) return start;
  const response = await safeFetch(start.toString(), {
    headers: {
      "User-Agent": BROWSER_UA,
      Accept: "text/html,application/xhtml+xml,video/*,*/*",
    },
  });
  const landed = response.url || start.toString();
  await response.body?.cancel().catch(() => {});
  return assertPublicHttpUrl(new URL(landed, start).toString());
}

async function inspectPage(page: URL): Promise<InspectResult> {
  if (isYouTube(page)) throw new VideoError("目前只支持哔哩哔哩");
  if (!isBilibili(page)) throw new VideoError("目前只支持哔哩哔哩视频详情页");
  try {
    return await inspectBilibili(page);
  } catch (error) {
    if (error instanceof VideoError) throw error;
    const message = error instanceof Error ? error.message.trim() : "";
    throw new VideoError(message ? `解析失败：${message.slice(0, 180)}` : "解析失败");
  }
}

async function openPage(page: URL, formatId: string): Promise<Opened> {
  if (isYouTube(page)) throw new VideoError("目前只支持哔哩哔哩");
  if (!isBilibili(page)) throw new VideoError("目前只支持哔哩哔哩视频详情页");
  try {
    return await openBilibili(page, formatId);
  } catch (error) {
    if (error instanceof VideoError) throw error;
    const message = error instanceof Error ? error.message.trim() : "";
    throw new VideoError(message ? `下载失败：${message.slice(0, 180)}` : "下载失败");
  }
}

export async function inspectUrl(raw: string): Promise<InspectResult> {
  return inspectPage(await settlePage(raw));
}

export async function openUrl(raw: string, formatId: string): Promise<Opened> {
  const page = await settlePage(raw);
  let id = formatId.trim();
  if (!id) {
    const inspected = await inspectPage(page);
    const best =
      inspected.formats.find((item) => item.hasVideo && item.hasAudio) ?? inspected.formats[0];
    if (!best) throw new VideoError("没有可下载的文件");
    id = best.id;
  }
  return openPage(page, id);
}
