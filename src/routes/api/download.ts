import { createFileRoute } from "@tanstack/react-router";

import { VideoError } from "@/lib/video/errors";
import { contentDisposition } from "@/lib/video/format";
import { openUrl } from "@/lib/video/resolve.server";

export const Route = createFileRoute("/api/download")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const query = new URL(request.url).searchParams;
        const page = query.get("url") ?? "";
        const format = query.get("format") ?? "";
        if (!page.trim()) return fail(request, "缺少视频链接", 400);
        if (page.length > 4000) return fail(request, "链接太长了", 400);
        try {
          const file = await withTimeout(openUrl(page, format), 45_000);
          const headers = new Headers();
          headers.set("Content-Type", file.contentType || "application/octet-stream");
          headers.set("Content-Disposition", contentDisposition(file.filename));
          headers.set("Cache-Control", "no-store");
          headers.set("X-Content-Type-Options", "nosniff");
          if (file.size && file.size > 0) headers.set("Content-Length", String(file.size));
          return new Response(file.body, { status: 200, headers });
        } catch (error) {
          const message = error instanceof VideoError ? error.message : "下载失败";
          return fail(request, message, 422);
        }
      },
    },
  },
});

function fail(request: Request, message: string, status: number): Response {
  const accept = request.headers.get("accept") ?? "";
  if (accept.includes("application/json") && !accept.includes("text/html")) {
    return Response.json({ error: message }, { status });
  }
  const safe = message
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">");
  return new Response(
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>落片 · 没能下载</title><body style="margin:0;background:#f3efe6;color:#1b1714;font-family:sans-serif"><main style="max-width:36rem;margin:0 auto;padding:3rem 1.25rem"><p style="letter-spacing:.2em;color:#c4511a">落片</p><h1>没能下载</h1><p>${safe}</p><p><a href="/">返回再试一次</a></p></main></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new VideoError("准备文件超时，请再试一次")), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
