import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { escapeHtml, urlWithPart } from "./format.ts";

describe("escapeHtml", () => {
  it("escapes text that would otherwise break the download error page", () => {
    assert.equal(escapeHtml(`<script>"&'</script>`), "&lt;script&gt;&quot;&amp;&#39;&lt;/script&gt;");
  });
});

describe("urlWithPart", () => {
  it("sets the p query used for 分P", () => {
    assert.equal(
      urlWithPart("https://www.bilibili.com/video/BV1xx411c7mD?p=1&t=3", 4),
      "https://www.bilibili.com/video/BV1xx411c7mD?p=4&t=3",
    );
  });
});
