// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { EMAIL_CSP, isAllowedLinkUrl, sanitizeEmailHtml } from "./sanitize.ts";

const HOSTILE = `<!doctype html>
<html>
<head>
  <meta http-equiv="refresh" content="0; url=https://tracker.example.org/r">
  <base href="https://tracker.example.org/">
  <link rel="stylesheet" href="https://tracker.example.org/s.css">
  <script>alert(1)</script>
</head>
<body onload="alert(2)">
  <p>Hello from example.org</p>
  <img src="https://tracker.example.org/pixel.gif" onerror="alert(3)" alt="pixel">
  <img srcset="https://tracker.example.org/a.png 1x" alt="set">
  <table background="https://tracker.example.org/bg.png"><tr><td>cell</td></tr></table>
  <a href="javascript:alert(4)">bad link</a>
  <a href="https://example.org/link">good link</a>
  <a href="mailto:someone@example.org">mail link</a>
  <form action="https://tracker.example.org/collect"><input name="q"><button>Go</button></form>
  <iframe src="https://tracker.example.org/frame"></iframe>
  <svg><a href="javascript:alert(5)"><text>svg link</text></a></svg>
</body>
</html>`;

describe("sanitizeEmailHtml", () => {
  it("strips scripts, handlers, forms, base, meta refresh and remote images", () => {
    const out = sanitizeEmailHtml(HOSTILE);

    for (const banned of [
      "<script",
      "onload",
      "onerror",
      "javascript:",
      "<form",
      "<input",
      "<button",
      "<base",
      "<link",
      "<iframe",
      'http-equiv="refresh"',
      "https://tracker.example.org",
    ]) {
      expect(out).not.toContain(banned);
    }
    expect(out).toContain('href="https://example.org/link"');
    expect(out).toContain('href="mailto:someone@example.org"');
    expect(out).toContain("Hello from example.org");
    expect(out).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${EMAIL_CSP}">`,
    );
    expect(EMAIL_CSP).toBe("default-src 'none'; img-src data:; style-src 'unsafe-inline'");
  });

  it("keeps data: images and inline styles", () => {
    const out = sanitizeEmailHtml(
      `<style>.note { color: green; }</style>` +
        `<p class="note" style="font-weight: bold">styled</p>` +
        `<img src="data:image/png;base64,iVBORw0KGgo=" alt="inline">`,
    );

    expect(out).toContain(".note { color: green; }");
    expect(out).toContain('style="font-weight: bold"');
    expect(out).toContain('src="data:image/png;base64,iVBORw0KGgo="');
  });

  it("keeps a style element from the head of a full document", () => {
    const out = sanitizeEmailHtml(
      `<html><head><style>h1 { margin: 0; }</style></head><body><h1>Hi</h1></body></html>`,
    );

    expect(out).toContain("h1 { margin: 0; }");
    expect(out).toContain("<h1>Hi</h1>");
  });

  it("drops remote url() and @import from style elements and style attributes", () => {
    const out = sanitizeEmailHtml(
      `<style>@import url("https://tracker.example.org/i.css");` +
        `.a { background: url(https://tracker.example.org/x.png) no-repeat; }` +
        `.b { background-image: url('data:image/png;base64,AAAA'); }` +
        `.c { background: \\75 rl(https://tracker.example.org/escaped.png); }` +
        `.d { background: image-set("https://tracker.example.org/set.png" 1x); }` +
        `@\\69mport "https://tracker.example.org/escaped.css";</style>` +
        `<div style="background-image: url(https://tracker.example.org/x.png); color: red">x</div>`,
    );

    expect(out).not.toContain("tracker.example.org");
    expect(out).not.toContain("@import");
    expect(out).toContain("url('data:image/png;base64,AAAA')");
    expect(out).toContain("no-repeat");
    expect(out).toContain("color: red");
  });
});

describe("isAllowedLinkUrl", () => {
  it("allows only absolute http, https and mailto URLs", () => {
    expect(isAllowedLinkUrl("https://example.org/a")).toBe(true);
    expect(isAllowedLinkUrl("http://example.org/a")).toBe(true);
    expect(isAllowedLinkUrl("MAILTO:someone@example.org")).toBe(true);
    expect(isAllowedLinkUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedLinkUrl(" javascript:alert(1)")).toBe(false);
    expect(isAllowedLinkUrl("data:text/html,hi")).toBe(false);
    expect(isAllowedLinkUrl("/relative")).toBe(false);
    expect(isAllowedLinkUrl("#top")).toBe(false);
  });
});
