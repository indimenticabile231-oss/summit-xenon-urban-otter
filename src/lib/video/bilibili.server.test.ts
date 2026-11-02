import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { VideoError } from "./errors.ts";
import {
  bilibiliIdentity,
  bilibiliUnsupportedReason,
  bilibiliViewQuery,
  formatsFromPlayResponses,
  qualityFromFormatId,
  selectBilibiliPart,
} from "./bilibili.server.ts";

const page = (href: string) => new URL(href);

describe("bilibili identity", () => {
  it("reads a BV id and prefers it over aid in the view query", () => {
    const id = bilibiliIdentity(page("https://www.bilibili.com/video/BV1xx411c7mD?aid=9&p=2"));
    assert.equal(id.bvid, "BV1xx411c7mD");
    assert.equal(id.aid, "9");
    assert.equal(bilibiliViewQuery(id), "bvid=BV1xx411c7mD");
  });

  it("reads an av path and an aid query", () => {
    assert.equal(bilibiliIdentity(page("https://www.bilibili.com/video/av12345")).aid, "12345");
    assert.equal(bilibiliViewQuery(bilibiliIdentity(page("https://www.bilibili.com/video/av12345"))), "aid=12345");
    assert.equal(bilibiliIdentity(page("https://www.bilibili.com/?aid=77")).aid, "77");
  });

  it("refuses a page with neither id", () => {
    assert.throws(
      () => bilibiliViewQuery(bilibiliIdentity(page("https://www.bilibili.com/"))),
      new VideoError("没有在链接里找到 BV 号或 av 号"),
    );
  });
});

describe("selectBilibiliPart", () => {
  const view = {
    cid: 1,
    pages: [
      { cid: 10, page: 1, part: " 正片 " },
      { cid: 20, page: 2, part: "花絮" },
    ],
  };

  it("defaults to the first part and lists every part", () => {
    const selected = selectBilibiliPart(view, null);
    assert.equal(selected.cid, 10);
    assert.equal(selected.page, 1);
    assert.equal(selected.part, "正片");
    assert.deepEqual(selected.parts, [
      { page: 1, title: "正片" },
      { page: 2, title: "花絮" },
    ]);
  });

  it("selects ?p= and falls back when the page is missing", () => {
    assert.equal(selectBilibiliPart(view, "2").cid, 20);
    assert.equal(selectBilibiliPart(view, "9").cid, 10);
    assert.equal(selectBilibiliPart(view, "nope").cid, 10);
  });

  it("hides the part title when there is only one page", () => {
    const selected = selectBilibiliPart({ cid: 5, pages: [{ cid: 5, page: 1, part: "仅一集" }] }, "1");
    assert.equal(selected.part, null);
    assert.equal(selected.parts[0]?.title, "仅一集");
  });

  it("uses a fallback title and the view cid", () => {
    const selected = selectBilibiliPart({ cid: 8, pages: [{ cid: 8, page: 3, part: "  " }] }, "3");
    assert.equal(selected.parts[0]?.title, "第 3 P");
    assert.throws(() => selectBilibiliPart({ pages: [] }, "1"), /分片信息/);
  });
});

describe("play formats", () => {
  it("dedupes qualities and labels known qn values", () => {
    const formats = formatsFromPlayResponses([
      { quality: 80, durl: [{ size: 100 }, { size: 50 }] },
      { quality: 80, durl: [{ size: 150 }] },
      { quality: 64, durl: [{ size: 40 }] },
      { quality: 999, durl: [{ size: 1 }] },
      null,
      { quality: 16, durl: [] },
    ]);
    assert.deepEqual(
      formats.map((item) => [item.id, item.label, item.size, item.ext]),
      [
        ["bili:80", "1080P", 150, "mp4"],
        ["bili:64", "720P", 40, "mp4"],
        ["bili:999", "999P", 1, "mp4"],
      ],
    );
    assert.equal(formats.every((item) => item.hasAudio && item.hasVideo), true);
  });

  it("reads the quality from a format id", () => {
    assert.equal(qualityFromFormatId("bili:112"), 112);
    assert.equal(qualityFromFormatId(""), 80);
    assert.equal(qualityFromFormatId("bili:nope"), 80);
  });
});

describe("bilibiliUnsupportedReason", () => {
  it("blocks live rooms and bangumi, and allows a normal video", () => {
    assert.match(bilibiliUnsupportedReason(page("https://live.bilibili.com/6")) ?? "", /直播/);
    assert.match(bilibiliUnsupportedReason(page("https://www.bilibili.com/bangumi/play/ep1")) ?? "", /番剧/);
    assert.equal(bilibiliUnsupportedReason(page("https://www.bilibili.com/video/BV1xx411c7mD")), null);
  });
});
