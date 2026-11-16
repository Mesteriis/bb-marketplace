// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  cleanEmailCss,
  declaresDarkSupport,
  htmlToPlainText,
  EMAIL_CSP,
  EMAIL_CSP_REMOTE_IMAGES,
  isAllowedLinkUrl,
  sanitizeEmailHtml,
} from "./sanitize.ts";

/** The document in the default mode (no remote images). */
const clean = (html: string) => sanitizeEmailHtml(html, { remoteImages: false }).html;

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
    const out = clean(HOSTILE);

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
    const out = clean(
      `<style>.note { color: green; }</style>` +
        `<p class="note" style="font-weight: bold">styled</p>` +
        `<img src="data:image/png;base64,iVBORw0KGgo=" alt="inline">`,
    );

    expect(out).toContain(".note { color: green; }");
    expect(out).toContain('style="font-weight: bold"');
    expect(out).toContain('src="data:image/png;base64,iVBORw0KGgo="');
  });

  it("keeps a style element from the head of a full document", () => {
    const out = clean(
      `<html><head><style>h1 { margin: 0; }</style></head><body><h1>Hi</h1></body></html>`,
    );

    expect(out).toContain("h1 { margin: 0; }");
    expect(out).toContain("<h1>Hi</h1>");
  });

  it("drops remote url() and @import from style elements and style attributes", () => {
    const out = clean(
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

  it("adds the DNS prefetch opt-out next to the CSP meta", () => {
    expect(clean("<p>x</p>")).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${EMAIL_CSP}">` +
        `<meta http-equiv="x-dns-prefetch-control" content="off">`,
    );
  });
});

const ALLOWED_HOSTILE = `<div>
  <p>Invented newsletter</p>
  <img src="https://images.example.org/kept.png" onerror="alert(1)" alt="kept">
  <img src="http://images.example.org/plain.png" alt="plain">
  <img src="https://images.example.org/base.png" srcset="https://tracker.example.org/set.png 2x" alt="set">
  <picture><source srcset="https://tracker.example.org/source.webp"><img src="https://images.example.org/pic.png" alt="pic"></picture>
  <img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" alt="svg">
  <img src="//tracker.example.org/relative.png" alt="relative">
  <div style="background: url(https://tracker.example.org/bg.png)">styled</div>
  <style>.a { background-image: url("https://tracker.example.org/css.png"); }</style>
  <table background="https://tracker.example.org/table.png"><tr><td>cell</td></tr></table>
  <svg><image href="https://tracker.example.org/svg-image.png"></image></svg>
  <video poster="https://tracker.example.org/poster.png" src="https://tracker.example.org/v.mp4"></video>
</div>`;

describe("sanitizeEmailHtml modes", () => {
  it("default mode reports blocked remote images and uses the data:-only CSP", () => {
    const result = sanitizeEmailHtml(
      `<p>x</p><img src="https://images.example.org/a.png" alt="a">`,
      { remoteImages: false },
    );

    expect(result.blockedRemoteImages).toBe(true);
    expect(result.html).not.toContain("images.example.org");
    expect(result.html).toContain(`content="${EMAIL_CSP}"`);
  });

  it("reports nothing blocked for a message without remote images", () => {
    const result = sanitizeEmailHtml(
      `<p>x</p><img src="data:image/png;base64,iVBORw0KGgo=" alt="inline">` +
        `<a href="https://example.org/link">link</a>`,
      { remoteImages: false },
    );

    expect(result.blockedRemoteImages).toBe(false);
    expect(result.html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
  });

  it("reports only what Show images would reveal: an https img src", () => {
    for (const html of [
      // http: stays blocked even when images are allowed.
      `<img src="http://tracker.example.org/plain.png" alt="plain">`,
      // CSS url() stays blocked in both modes.
      `<div style="background: url(https://tracker.example.org/x.png)">x</div>`,
      `<style>.a { background: url('https://tracker.example.org/x.png') }</style>`,
      // srcset and background attributes stay blocked in both modes.
      `<img srcset="https://tracker.example.org/a.png 1x" alt="set">`,
      `<table background="https://tracker.example.org/bg.png"><tr><td>c</td></tr></table>`,
      `<img src="//tracker.example.org/relative.png" alt="relative">`,
    ]) {
      expect(sanitizeEmailHtml(html, { remoteImages: false }).blockedRemoteImages, html).toBe(false);
    }
  });

  it("treats https: without slashes the same in both modes", () => {
    const html = `<img src="https:tracker.example.org/x.png" alt="odd">`;
    const blocked = sanitizeEmailHtml(html, { remoteImages: false });
    const allowed = sanitizeEmailHtml(html, { remoteImages: true });

    expect(blocked.blockedRemoteImages).toBe(false);
    expect(blocked.html).not.toContain("tracker.example.org");
    expect(allowed.html).not.toContain("tracker.example.org");
  });

  it("drops svg data: images in both modes and keeps raster ones", () => {
    for (const remoteImages of [false, true]) {
      const { html } = sanitizeEmailHtml(
        `<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" alt="svg">` +
          `<img src="data:image/gif;base64,R0lGODlh" alt="gif">`,
        { remoteImages },
      );
      expect(html).not.toContain("image/svg+xml");
      expect(html).toContain('src="data:image/gif;base64,R0lGODlh"');
    }
  });

  it("the slice-1 hostile fixture stays clean in allowed mode except its https image", () => {
    const { html, blockedRemoteImages } = sanitizeEmailHtml(HOSTILE, { remoteImages: true });

    expect(html).toContain('src="https://tracker.example.org/pixel.gif"');
    const rest = html.replace('src="https://tracker.example.org/pixel.gif"', "");
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
      "srcset",
    ]) {
      expect(rest).not.toContain(banned);
    }
    // Allowed mode never reports blocked images: Show images has nothing more to show.
    expect(blockedRemoteImages).toBe(false);
  });

  it("allowed mode keeps only https img src", () => {
    const { html, blockedRemoteImages } = sanitizeEmailHtml(ALLOWED_HOSTILE, { remoteImages: true });

    expect(html).toContain('src="https://images.example.org/kept.png"');
    expect(html).toContain('src="https://images.example.org/base.png"');
    expect(html).toContain('src="https://images.example.org/pic.png"');
    for (const banned of [
      "onerror",
      "http://images.example.org",
      "srcset",
      "<picture",
      "<source",
      "image/svg+xml",
      "tracker.example.org",
      "<video",
      "poster",
      "background=",
    ]) {
      expect(html).not.toContain(banned);
    }
    expect(html).toContain("styled");
    expect(html).toContain("cell");
    expect(html).toContain(`content="${EMAIL_CSP_REMOTE_IMAGES}"`);
    expect(html).not.toContain(`content="${EMAIL_CSP}"`);
    expect(EMAIL_CSP_REMOTE_IMAGES).toBe(
      "default-src 'none'; img-src data: https:; style-src 'unsafe-inline'",
    );
    expect(blockedRemoteImages).toBe(false);
  });

  it("allowed mode still drops escaped, unterminated and image-set CSS urls", () => {
    // cleanEmailCss is the only barrier here: the allowed CSP permits https: images.
    const { html } = sanitizeEmailHtml(
      `<style>.c { background: \\75 rl(https://tracker.example.org/escaped.png); }` +
        `.d { background: image-set("https://tracker.example.org/set.png" 1x); }` +
        `@\\69mport "https://tracker.example.org/escaped.css";</style>` +
        `<div style="background: url(https://tracker.example.org/open">x</div>`,
      { remoteImages: true },
    );

    expect(html).not.toContain("tracker.example.org");
    expect(html).not.toContain("@import");
  });

  it("allowed mode sends no referrer with the images it loads", () => {
    const { html } = sanitizeEmailHtml(`<img src="https://images.example.org/a.png" alt="a">`, {
      remoteImages: true,
    });

    expect(html).toContain('<meta name="referrer" content="no-referrer">');
    expect(html).toMatch(/<img[^>]*referrerpolicy="no-referrer"/);
  });

  it("allowed mode with only https images reports nothing blocked", () => {
    const result = sanitizeEmailHtml(`<img src="https://images.example.org/a.png" alt="a">`, {
      remoteImages: true,
    });
    expect(result.blockedRemoteImages).toBe(false);
  });
});

describe("sanitizeEmailHtml url() in attributes", () => {
  const SVG =
    `<svg><defs><linearGradient id="g"></linearGradient></defs>` +
    `<rect fill="url(https://tracker.example.org/fill.svg#p)" width="1"></rect>` +
    `<rect mask="url( 'https://tracker.example.org/mask.svg' )"></rect>` +
    `<rect filter="URL(&quot;https://tracker.example.org/filter.svg&quot;)"></rect>` +
    `<path marker-start="u\\72l(https://tracker.example.org/marker.svg)" d="M0 0"></path>` +
    `<rect clip-path="url(//tracker.example.org/clip.svg)"></rect>` +
    `<rect stroke="url(#g)" fill="url( '#g' )" id="kept"></rect>` +
    `</svg>`;

  for (const remoteImages of [false, true]) {
    it(`drops presentation attributes that load a URL (${remoteImages ? "allowed" : "default"} mode)`, () => {
      const { html } = sanitizeEmailHtml(SVG, { remoteImages });

      expect(html).not.toContain("tracker.example.org");
      // Same-document references (gradients, clip paths) stay.
      expect(html).toMatch(/<rect[^>]*stroke="url\(#g\)"/);
      expect(html).toMatch(/<rect[^>]*fill="url\( '#g' \)"/);
    });
  }
});

describe("cleanEmailCss", () => {
  const SIZE = 300_000;
  const repeated = (unit: string) => unit.repeat(Math.ceil(SIZE / unit.length));

  for (const unit of ["url(", 'url("', "@import", "image-set(", "/*", "url(x)"]) {
    it(`cleans 300 KB of ${JSON.stringify(unit)} in linear time`, () => {
      const started = performance.now();
      const out = cleanEmailCss(repeated(unit));
      const elapsed = performance.now() - started;

      expect(elapsed).toBeLessThan(250);
      expect(out).not.toMatch(/url\(|@import/i);
    });
  }

  it("cleans a 300 KB unterminated style attribute and element quickly", () => {
    const hostile = repeated('url("');
    const started = performance.now();
    const out = clean(`<style>${hostile}</style><div style='${hostile}'>x</div>`);
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(1000);
    expect(out).not.toContain("url(");
    expect(out).toContain(">x</div>");
  });

  it("keeps data: urls and removes remote ones, quoted or not", () => {
    expect(cleanEmailCss(`a { background: url( "data:image/png;base64,AAAA" ) }`)).toBe(
      `a { background: url( "data:image/png;base64,AAAA" ) }`,
    );
    expect(cleanEmailCss(`a { background: URL(https://example.org/x.png) red }`)).toBe(
      `a { background: none red }`,
    );
    expect(cleanEmailCss(`a { b: url('https://example.org/x.png') }`)).toBe(`a { b: none }`);
    expect(cleanEmailCss(`@import "https://example.org/a.css"; p { c: d }`)).toBe(` p { c: d }`);
    expect(cleanEmailCss(`p { c: d } /* note */ q { e: f }`)).toBe(`p { c: d }  q { e: f }`);
    expect(
      cleanEmailCss(`a { b: image-set(url(data:image/png;base64,AA) 1x, "data:image/png;base64,BB" 2x) }`),
    ).toBe(`a { b: image-set(url(data:image/png;base64,AA) 1x, "data:image/png;base64,BB" 2x) }`);
    expect(cleanEmailCss(`a { b: -webkit-image-set(url(data:a) 1x, "https://example.org/b" 2x) }`)).toBe(
      `a { b: none }`,
    );
    // An unterminated remote url() or comment drops the rest of the block.
    expect(cleanEmailCss(`p { c: d } a { b: url(https://example.org/x`)).toBe(`p { c: d } a { b: none`);
    expect(cleanEmailCss(`p { c: d } /* open`)).toBe(`p { c: d } `);
  });

  it("caps a style block at 100,000 characters", () => {
    const out = cleanEmailCss("a".repeat(150_000));
    expect(out).toHaveLength(100_000);
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

describe("sanitizeEmailHtml and the signature class (slice 3d)", () => {
  it("keeps the makosh-signature class, so a reply to own mail can find the block to leave out", () => {
    const { html } = sanitizeEmailHtml(
      '<p>Text</p><div class="makosh-signature" onclick="x()"><p>Made-up Name</p></div>',
      { remoteImages: false },
    );
    expect(html).toContain('<div class="makosh-signature"><p>Made-up Name</p></div>');
    expect(html).not.toContain("onclick");
  });
});

describe("slice 3h: quotes, own marks and dark mail", () => {
  const body = (html: string) => new DOMParser().parseFromString(html, "text/html");

  it("strips an incoming data-mk-quote, so the mail cannot hide its own text", () => {
    const result = sanitizeEmailHtml("<div data-mk-quote>Shown text</div><p data-mk-x='1'>more</p>", { remoteImages: false });
    expect(result.html).toContain("<body><div>Shown text</div><p>more</p></body>");
    expect(result.quotes).toBe(0);
  });

  it("marks quote blocks and the attribution above a plain blockquote", () => {
    const result = sanitizeEmailHtml(
      "<p>My answer</p><div class=\"gmail_quote\">On Mon, Ada wrote:<blockquote>old</blockquote></div>" +
        "<p>On Tue, Bo wrote:</p><blockquote>older</blockquote>",
      { remoteImages: false },
    );
    const doc = body(result.html);
    expect(result.quotes).toBe(3);
    expect(doc.querySelector("div.gmail_quote")?.hasAttribute("data-mk-quote")).toBe(true);
    expect(doc.querySelectorAll("[data-mk-quote]")).toHaveLength(3);
    expect(doc.querySelector("p")?.hasAttribute("data-mk-quote")).toBe(false);
    expect(result.html).toContain('html:not([data-mk-quotes="shown"]) [data-mk-quote] { display: none !important; }');
  });

  it("marks Outlook's reply header and everything after it", () => {
    const result = sanitizeEmailHtml('<p>Reply</p><div id="divRplyFwdMsg">From: Ada</div><p>Old text</p>', { remoteImages: false });
    const marked = Array.from(body(result.html).querySelectorAll("[data-mk-quote]")).map((e) => e.textContent);
    expect(marked).toEqual(["From: Ada", "Old text"]);
  });

  it("hides nothing when everything would be hidden", () => {
    const result = sanitizeEmailHtml('<blockquote type="cite">Forwarded text only</blockquote>', { remoteImages: false });
    expect(result.quotes).toBe(0);
    expect(result.html).toContain('<body><blockquote type="cite">Forwarded text only</blockquote></body>');
  });

  it("reads dark support from the raw HTML", () => {
    expect(declaresDarkSupport('<meta name="color-scheme" content="light dark">')).toBe(true);
    expect(declaresDarkSupport("<meta name='supported-color-schemes' content='dark'>")).toBe(true);
    expect(declaresDarkSupport("<style>@media (prefers-color-scheme: dark) { body { color: #fff } }</style>")).toBe(true);
    expect(declaresDarkSupport('<meta name="color-scheme" content="light">')).toBe(false);
    expect(declaresDarkSupport("<p>prefers-color-scheme: dark</p>")).toBe(false);
    expect(declaresDarkSupport("<p>Hello</p>")).toBe(false);
  });

  it("adds the dark style only with dark set and no dark styles in the mail; the CSP is the same", () => {
    const light = sanitizeEmailHtml("<p>x</p>", { remoteImages: false });
    expect(light.html).not.toContain("color-scheme: dark");
    const adapted = sanitizeEmailHtml("<p>x</p>", { remoteImages: false, dark: true });
    expect(adapted.html).toContain(":root { color-scheme: dark; }");
    expect(adapted.html).toContain("filter: invert(0.9) hue-rotate(180deg)");
    const own = sanitizeEmailHtml("<p>x</p>", { remoteImages: false, dark: true, darkSupported: true });
    expect(own.html).toContain(":root { color-scheme: dark; }");
    expect(own.html).not.toContain("invert(");
    for (const result of [light, adapted, own]) expect(result.html).toContain(`content="${EMAIL_CSP}"`);
  });

  it("turns HTML into plain text with links", () => {
    expect(htmlToPlainText('<p>Hello</p><p>See <a href="https://example.org/a">the page</a><br>bye</p>')).toBe(
      "Hello\n\nSee the page <https://example.org/a>\nbye",
    );
  });
});
