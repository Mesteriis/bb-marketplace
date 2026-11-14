import { describe, expect, it } from "vitest";
import { collapseForSnippet, decodeHtmlEntities, removeInvisible } from "./html-entities.ts";

describe("decodeHtmlEntities", () => {
  it("decodes named entities seen in real mail", () => {
    expect(decodeHtmlEntities("&amp;&lt;&gt;&quot;&apos;")).toBe("&<>\"'");
    expect(decodeHtmlEntities("&nbsp;&zwnj;&zwj;&shy;")).toBe("\u00a0\u200c\u200d\u00ad");
    expect(decodeHtmlEntities("&ensp;&emsp;&thinsp;")).toBe("\u2002\u2003\u2009");
    expect(decodeHtmlEntities("&ndash;&mdash;&hellip;&laquo;&raquo;")).toBe("–—…«»");
    expect(decodeHtmlEntities("&lsquo;&rsquo;&ldquo;&rdquo;&bull;&middot;")).toBe("‘’“”•·");
    expect(decodeHtmlEntities("&copy;&reg;&trade;&euro;&rarr;&larr;&times;&deg;")).toBe("©®™€→←×°");
  });

  it("decodes decimal and hex references", () => {
    expect(decodeHtmlEntities("&#39;&#8204;&#x27;&#X200C;&#x1F600;")).toBe("'\u200c'\u200c😀");
  });

  it("turns invalid code points into U+FFFD", () => {
    expect(decodeHtmlEntities("&#0;|&#xD800;|&#x110000;|&#9999999;")).toBe("�|�|�|�");
  });

  it("keeps unknown and malformed references as-is", () => {
    expect(decodeHtmlEntities("&bogus; &amp &; &#; &#x; AT&T")).toBe("&bogus; &amp &; &#; &#x; AT&T");
  });

  it("keeps names of inherited object members as written", () => {
    const input = "&constructor; &toString; &valueOf; &hasOwnProperty; &__proto__; &prototype;";
    expect(decodeHtmlEntities(input)).toBe(input);
  });

  it("decodes direction marks and named zero-width entities", () => {
    expect(decodeHtmlEntities("&lrm;&rlm;&hairsp;&NoBreak;&ZeroWidthSpace;")).toBe(
      "\u200e\u200f\u200a\u2060\u200b",
    );
  });

  it("reads references 128-159 as windows-1252, like browsers", () => {
    expect(decodeHtmlEntities("&#128;&#130;&#133;&#146;&#147;&#148;&#150;&#151;&#153;&#159;")).toBe(
      "\u20ac\u201a\u2026\u2019\u201c\u201d\u2013\u2014\u2122\u0178",
    );
    expect(decodeHtmlEntities("&#x81;&#x9d;")).toBe("\u0081\u009d");
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
    expect(removeInvisible("a\u200b\u200c\u200d\u2060\ufeff\u00ad\u034fb")).toBe("ab");
  });

  it("collapses preheader padding to single spaces", () => {
    const padding = "\u200c\u00a0".repeat(50);
    expect(collapseForSnippet(`  Sale → ${padding} now\n\tlive `)).toBe("Sale → now live");
  });
});
