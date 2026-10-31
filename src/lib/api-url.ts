import { previewPathPrefix } from "@/lib/preview-path-prefix";

/** Preview hosts serve the app under a path prefix that raw fetch() would miss. */
export function withPreviewPrefix(path: string): string {
  if (typeof window === "undefined") return path;
  const prefix = previewPathPrefix(window.location.hostname, window.location.pathname);
  return `${prefix ?? ""}${path}`;
}
