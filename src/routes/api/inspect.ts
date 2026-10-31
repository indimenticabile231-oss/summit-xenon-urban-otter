import { createFileRoute } from "@tanstack/react-router";

import { VideoError } from "@/lib/video/errors";
import { inspectUrl } from "@/lib/video/resolve.server";

export const Route = createFileRoute("/api/inspect")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let url = "";
        try {
          const body = (await request.json()) as { url?: unknown };
          url = typeof body.url === "string" ? body.url : "";
        } catch {
          return Response.json({ error: "请提交视频页面链接" }, { status: 400 });
        }
        if (!url.trim()) return Response.json({ error: "请先粘贴视频页面链接" }, { status: 400 });
        if (url.length > 4000) return Response.json({ error: "链接太长了" }, { status: 400 });
        try {
          const result = await withTimeout(inspectUrl(url), 40_000);
          return Response.json(result);
        } catch (error) {
          const message = error instanceof VideoError ? error.message : "解析失败";
          return Response.json({ error: message }, { status: 422 });
        }
      },
    },
  },
});

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new VideoError("解析超时，换一个链接再试")), ms);
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
