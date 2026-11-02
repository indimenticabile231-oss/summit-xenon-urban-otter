export type VideoFormat = {
  id: string;
  label: string;
  ext: string;
  size: number | null;
  hasAudio: boolean;
  hasVideo: boolean;
};

export type VideoPart = {
  page: number;
  title: string;
};

export type InspectResult = {
  title: string;
  author: string | null;
  thumbnail: string | null;
  duration: number | null;
  source: string;
  pageUrl: string;
  formats: VideoFormat[];
  /** 分P 列表。单集视频为空或只有一项。 */
  parts: VideoPart[];
  /** 当前选中的分P，从 1 开始。 */
  page: number;
};

export function formatBytes(size: number | null): string {
  if (size == null || !Number.isFinite(size) || size <= 0) return "";
  if (size < 1024) return `${Math.round(size)} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatDuration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function fileStem(title: string): string {
  const cleaned = title
    // eslint-disable-next-line no-control-regex -- strip ASCII controls from file names
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || "video";
}

export function contentDisposition(filename: string): string {
  const safe = filename.replace(/[\r\n"]/g, "").slice(0, 160);
  const ascii = safe.replace(/[^\x20-\x7e]/g, "_") || "video.mp4";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 把分P序号写进详情页链接，供再次解析和下载使用。 */
export function urlWithPart(pageUrl: string, page: number): string {
  const url = new URL(pageUrl);
  url.searchParams.set("p", String(page));
  return url.toString();
}
