import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { unsupportedPageMessage, videoHostKind } from "./resolve.server.ts";

const page = (href: string) => new URL(href);

describe("video host contract", () => {
  it("accepts bilibili pages and short links", () => {
    for (const href of [
      "https://www.bilibili.com/video/BV1xx411c7mD",
      "https://m.bilibili.com/video/BV1xx411c7mD",
      "https://b23.tv/abc",
      "http://bilibili.com/video/av1",
    ]) {
      assert.equal(videoHostKind(page(href)), "bilibili", href);
      assert.equal(unsupportedPageMessage(page(href)), null, href);
    }
  });

  it("rejects YouTube with the short message and other sites with the detail message", () => {
    for (const href of [
      "https://youtu.be/dQw4w9WgXcQ",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    ]) {
      assert.equal(videoHostKind(page(href)), "youtube", href);
      assert.equal(unsupportedPageMessage(page(href)), "目前只支持哔哩哔哩", href);
    }
    assert.equal(videoHostKind(page("https://example.com/video.mp4")), "other");
    assert.equal(unsupportedPageMessage(page("https://vimeo.com/1")), "目前只支持哔哩哔哩视频详情页");
  });
});
