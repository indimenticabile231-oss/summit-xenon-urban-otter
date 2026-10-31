import { createFileRoute } from "@tanstack/react-router";
import { Download, Film, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";

import { withPreviewPrefix } from "@/lib/api-url";
import { fileStem, formatBytes, formatDuration, type InspectResult, type VideoFormat } from "@/lib/video/format";

export const Route = createFileRoute("/")({ component: Home });

const HISTORY_KEY = "luopian-history";

type HistoryItem = {
  url: string;
  title: string;
  source: string;
  at: number;
};

const STEPS = [
  { name: "复制链接", detail: "哔哩哔哩详情页，或 b23 短链" },
  { name: "粘贴解析", detail: "读出标题和能保存的清晰度" },
  { name: "保存文件", detail: "解析完直接下载，也可以换清晰度" },
];

function Home() {
  const [url, setUrl] = useState("");
  const [phase, setPhase] = useState<"idle" | "working" | "ready" | "error">("idle");
  const [error, setError] = useState("");
  const [result, setResult] = useState<InspectResult | null>(null);
  const [startedId, setStartedId] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as HistoryItem[];
      if (Array.isArray(parsed)) setHistory(parsed.slice(0, 6));
    } catch {
      /* ignore broken local history */
    }
  }, []);

  function remember(item: HistoryItem) {
    const next = [item, ...history.filter((entry) => entry.url !== item.url)].slice(0, 6);
    setHistory(next);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  }

  async function run(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) {
      setPhase("error");
      setError("请先粘贴视频详情页的链接");
      setResult(null);
      return;
    }
    setPhase("working");
    setError("");
    setStartedId(null);
    try {
      const response = await fetch(withPreviewPrefix("/api/inspect"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ url: trimmed }),
      });
      const data = (await response.json()) as InspectResult & { error?: string };
      if (!response.ok || data.error || !data.formats) {
        setPhase("error");
        setResult(null);
        setError(data.error || "这个页面没有解析出视频文件");
        return;
      }
      setResult(data);
      setPhase("ready");
      remember({ url: data.pageUrl || trimmed, title: data.title, source: data.source, at: Date.now() });
      const best = data.formats.find((item) => item.hasVideo && item.hasAudio) ?? data.formats[0];
      if (best) {
        setStartedId(best.id);
        triggerDownload(data.pageUrl, best.id);
      }
    } catch {
      setPhase("error");
      setResult(null);
      setError("网络中断了，稍后再试");
    }
  }

  return (
    <main className="min-h-screen bg-paper text-ink">
      <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col px-5 py-8 sm:px-8 sm:py-14">
        <header>
          <img src="/og.jpg" alt="落片" className="w-full rounded-card border border-line" />
          <h1 className="mt-6 max-w-xl font-serif text-4xl leading-tight text-balance sm:text-5xl">
            把哔哩哔哩详情页，存成视频文件
          </h1>
          <p className="mt-4 max-w-xl text-base leading-relaxed text-pretty text-muted">
            粘贴 BV 链接或 b23 短链。解析成功后会直接开始下载，也可以换一个清晰度再存一份。
          </p>
        </header>

        <form
          className="mt-8"
          onSubmit={(event) => {
            event.preventDefault();
            void run(url);
          }}
        >
          <label htmlFor="video-url" className="text-sm font-medium">
            视频页面链接
          </label>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row">
            <input
              id="video-url"
              name="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              onPaste={(event) => {
                const text = event.clipboardData.getData("text").trim();
                if (!text) return;
                event.preventDefault();
                setUrl(text);
                void run(text);
              }}
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="https://www.bilibili.com/video/BV…"
              className="h-12 min-w-0 flex-1 rounded-full border border-line bg-card px-5 text-base text-ink outline-none placeholder:text-muted focus-visible:ring-2 focus-visible:ring-ember"
            />
            <button
              type="submit"
              disabled={phase === "working"}
              className="inline-flex h-12 shrink-0 items-center justify-center gap-2 rounded-full bg-ember px-6 text-base font-medium text-foam disabled:opacity-60"
            >
              {phase === "working" ? <LoaderCircle className="size-4 animate-spin" /> : <Download className="size-4" />}
              {phase === "working" ? "正在解析" : "解析并下载"}
            </button>
          </div>
        </form>

        {phase === "working" ? (
          <div className="mt-6 overflow-hidden rounded-full bg-line" aria-hidden="true">
            <div className="loading-bar h-1 w-1/3 bg-ember" />
          </div>
        ) : null}

        {phase === "error" ? (
          <p role="alert" className="mt-6 rounded-card border border-line bg-card px-5 py-4 text-sm leading-relaxed">
            {error}
          </p>
        ) : null}

        {phase === "ready" && result ? (
          <Result
            result={result}
            startedId={startedId}
            onDownload={(formatId) => {
              setStartedId(formatId);
              triggerDownload(result.pageUrl, formatId);
            }}
          />
        ) : null}

        {phase === "idle" ? <StepList /> : null}

        {history.length > 0 ? (
          <section className="mt-10">
            <div className="flex items-center justify-between">
              <h2 className="font-serif text-xl">最近解析</h2>
              <button
                type="button"
                className="text-sm text-muted"
                onClick={() => {
                  setHistory([]);
                  localStorage.removeItem(HISTORY_KEY);
                }}
              >
                清空
              </button>
            </div>
            <ul className="mt-3 divide-y divide-line border-y border-line">
              {history.map((item) => (
                <li key={item.url}>
                  <button
                    type="button"
                    className="flex w-full items-baseline justify-between gap-4 py-3 text-left"
                    onClick={() => {
                      setUrl(item.url);
                      void run(item.url);
                    }}
                  >
                    <span className="line-clamp-1 font-medium">{item.title}</span>
                    <span className="shrink-0 text-sm text-muted">{item.source}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <footer className="mt-auto pt-12 text-sm leading-relaxed text-muted">
          <p>只支持哔哩哔哩普通视频。番剧、直播，以及需要登录或大会员的清晰度下不了。</p>
          <p className="mt-2">请只保存你有权使用的视频。</p>
        </footer>
      </div>
    </main>
  );
}

function StepList() {
  return (
    <section className="mt-10">
      <h2 className="font-serif text-xl">怎么用</h2>
      <ul className="mt-3 divide-y divide-line border-y border-line">
        {STEPS.map((item) => (
          <li key={item.name} className="flex items-baseline justify-between gap-4 py-3">
            <span className="font-medium">{item.name}</span>
            <span className="text-right text-sm text-muted">{item.detail}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Result({
  result,
  startedId,
  onDownload,
}: {
  result: InspectResult;
  startedId: string | null;
  onDownload: (formatId: string) => void;
}) {
  const best = result.formats.find((item) => item.hasVideo && item.hasAudio) ?? result.formats[0];
  const rest = result.formats.filter((item) => item.id !== best?.id);
  const meta = [result.source, result.author, formatDuration(result.duration)].filter(Boolean).join(" · ");

  return (
    <section className="mt-8 overflow-hidden rounded-card border border-line border-l-4 border-l-ember bg-card">
      <div className="sm:flex">
        <div className="sm:w-44 sm:shrink-0">
          <Thumb src={result.thumbnail} title={result.title} />
        </div>
        <div className="flex flex-col gap-4 p-5">
          <div>
            <h2 className="font-serif text-2xl leading-snug text-balance">{result.title}</h2>
            {meta ? <p className="mt-2 text-sm text-muted">{meta}</p> : null}
          </div>
          {best ? (
            <FormatButton
              format={best}
              title={result.title}
              pageUrl={result.pageUrl}
              primary
              started={startedId === best.id}
              onDownload={onDownload}
            />
          ) : null}
          {startedId ? (
            <p className="text-sm text-muted">已开始下载。如果浏览器拦住了，再点一次按钮。</p>
          ) : null}
        </div>
      </div>
      {rest.length > 0 ? (
        <div className="border-t border-line px-5 py-4">
          <h3 className="text-sm font-medium">其他文件</h3>
          <ul className="mt-3 flex flex-col gap-2">
            {rest.map((format) => (
              <li key={format.id}>
                <FormatButton
                  format={format}
                  title={result.title}
                  pageUrl={result.pageUrl}
                  started={startedId === format.id}
                  onDownload={onDownload}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function FormatButton({
  format,
  title,
  pageUrl,
  primary,
  started,
  onDownload,
}: {
  format: VideoFormat;
  title: string;
  pageUrl: string;
  primary?: boolean;
  started: boolean;
  onDownload: (formatId: string) => void;
}) {
  const size = formatBytes(format.size);
  const label = primary ? "下载视频" : format.label;
  return (
    <a
      href={downloadHref(pageUrl, format.id)}
      download={`${fileStem(title)}.${format.ext}`}
      onClick={(event) => {
        event.preventDefault();
        onDownload(format.id);
      }}
      className={
        primary
          ? "inline-flex h-12 items-center justify-center gap-2 rounded-full bg-ember px-5 text-base font-medium text-foam"
          : "inline-flex min-h-11 w-full items-center justify-between gap-3 rounded-full border border-line px-4 py-2 text-sm"
      }
    >
      <span className="inline-flex items-center gap-2">
        <Download className="size-4" />
        {started && primary ? "再次下载" : label}
      </span>
      <span className={primary ? "text-sm text-foam" : "text-muted"}>
        {[format.ext.toUpperCase(), size, primary ? format.label : ""].filter(Boolean).join(" · ")}
      </span>
    </a>
  );
}

function Thumb({ src, title }: { src: string | null; title: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div className="flex aspect-video items-center justify-center bg-paper text-ember sm:aspect-auto sm:min-h-full">
        <Film className="size-8" aria-hidden="true" />
        <span className="sr-only">{title}</span>
      </div>
    );
  }
  return (
    <img
      src={src}
      alt=""
      className="aspect-video h-full w-full object-cover"
      onError={() => setFailed(true)}
    />
  );
}

function downloadHref(pageUrl: string, formatId: string): string {
  const params = new URLSearchParams({ url: pageUrl, format: formatId });
  return withPreviewPrefix(`/api/download?${params.toString()}`);
}

function triggerDownload(pageUrl: string, formatId: string) {
  const anchor = document.createElement("a");
  anchor.href = downloadHref(pageUrl, formatId);
  anchor.target = "_blank";
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
