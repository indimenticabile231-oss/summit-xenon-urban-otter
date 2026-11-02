import { createFileRoute } from "@tanstack/react-router";

import { VideoError } from "@/lib/video/errors";
import { takeRequestQuota } from "@/lib/video/quota.server";
import { inspectUrl } from "@/lib/video/resolve.server";

// 不看登录态。额度按 IP 计，避免把解析接口当公开代理。见 quota.server.ts。
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
        const quota = takeRequestQuota(request, "inspect");
        if (quota.denial) {
          return Response.json(
            { error: quota.denial.message },
            {
              status: 429,
              headers: {
                "Retry-After": String(quota.denial.retryAfterSec),
                "Cache-Control": "no-store",
              },
            },
          );
        }
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
