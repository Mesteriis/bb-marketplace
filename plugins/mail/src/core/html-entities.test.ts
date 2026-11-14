import { describe, expect, it } from "vitest";
import { collapseForSnippet, decodeHtmlEntities, removeInvisible } from "./html-entities.ts";

describe("decodeHtmlEntities", () => {
  it("decodes named entities seen in real mail", () => {
    expect(decodeHtmlEntities("&amp;&lt;&gt;&quot;&apos;")).toBe("&<>\"'");
    expect(decodeHtmlEntities("&nbsp;&zwnj;&zwj;&shy;")).toBe(" ‌‍­");
    expect(decodeHtmlEntities("&ensp;&emsp;&thinsp;")).toBe("   ");
    expect(decodeHtmlEntities("&ndash;&mdash;&hellip;&laquo;&raquo;")).toBe("–—…«»");
    expect(decodeHtmlEntities("&lsquo;&rsquo;&ldquo;&rdquo;&bull;&middot;")).toBe("‘’“”•·");
    expect(decodeHtmlEntities("&copy;&reg;&trade;&euro;&rarr;&larr;&times;&deg;")).toBe("©®™€→←×°");
  });

  it("decodes decimal and hex references", () => {
    expect(decodeHtmlEntities("&#39;&#8204;&#x27;&#X200C;&#x1F600;")).toBe("'‌'‌😀");
  });

  it("turns invalid code points into U+FFFD", () => {
    expect(decodeHtmlEntities("&#0;|&#xD800;|&#x110000;|&#9999999;")).toBe("�|�|�|�");
  });

  it("keeps unknown and malformed references as-is", () => {
    expect(decodeHtmlEntities("&bogus; &amp &; &#; &#x; AT&T")).toBe("&bogus; &amp &; &#; &#x; AT&T");
  });

  it("decodes once, so double-encoded text keeps one level", () => {
    expect(decodeHtmlEntities("&amp;zwnj; &amp;amp;")).toBe("&zwnj; &amp;");
  });

  it("stays linear on long runs of & and &#", () => {
    for (const input of ["&".repeat(300_000), "&#".repeat(150_000), "&#x".repeat(100_000)]) {
      const started = performance.now();
      expect(decodeHtmlEntities(input)).toBe(input);
      expect(performance.now() - started).toBeLessThan(200);
    }
  });
});

describe("removeInvisible / collapseForSnippet", () => {
  it("drops zero-width and soft-hyphen characters", () => {
    expect(removeInvisible("a​‌‍⁠﻿­͏b")).toBe("ab");
  });

  it("collapses preheader padding to single spaces", () => {
    const padding = "‌ ".repeat(50);
    expect(collapseForSnippet(`  Sale → ${padding} now\n\tlive `)).toBe("Sale → now live");
  });
});
