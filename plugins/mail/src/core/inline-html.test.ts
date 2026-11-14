import { describe, expect, it } from "vitest";
import { base64Encode, inlineCidImages } from "./inline-html.ts";
import type { InlinePart } from "./model.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const PNG_URL = "data:image/png;base64,iVBORw==";

function part(contentId: string, mimeType: string, data: Uint8Array = PNG): InlinePart {
  return { contentId, mimeType, data };
}

describe("base64Encode", () => {
  it("matches the standard encoding with padding", () => {
    for (const text of ["", "f", "fo", "foo", "foob", "fooba", "foobar"]) {
      const bytes = new TextEncoder().encode(text);
      expect(base64Encode(bytes)).toBe(Buffer.from(text).toString("base64"));
    }
    const all = new Uint8Array(256).map((_, i) => i);
    expect(base64Encode(all)).toBe(Buffer.from(all).toString("base64"));
  });
});

describe("inlineCidImages", () => {
  it("replaces cid references in src attributes", () => {
    const parts = [part("logo@x", "image/png")];
    expect(inlineCidImages('<img src="cid:logo@x">', parts)).toBe(`<img src="${PNG_URL}">`);
    expect(inlineCidImages("<img src='cid:logo@x'>", parts)).toBe(`<img src='${PNG_URL}'>`);
    expect(inlineCidImages("<img SRC = cid:logo@x alt=a>", parts)).toBe(
      `<img SRC = ${PNG_URL} alt=a>`,
    );
  });

  it("replaces cid references in CSS url()", () => {
    const parts = [part("bg", "image/gif")];
    const gif = "data:image/gif;base64,iVBORw==";
    expect(inlineCidImages('<td style="background:url(cid:bg)">', parts)).toBe(
      `<td style="background:url(${gif})">`,
    );
    expect(inlineCidImages("<style>a{background:url( 'cid:bg' )}</style>", parts)).toBe(
      `<style>a{background:url( '${gif}' )}</style>`,
    );
    expect(inlineCidImages('<td style="background:url(&quot;cid:bg&quot;)">', parts)).toBe(
      `<td style="background:url(&quot;${gif}&quot;)">`,
    );
  });

  it("matches percent-encoded and differently cased content ids", () => {
    const parts = [part("Image 1@Mail", "image/jpeg")];
    expect(inlineCidImages('<img src="cid:image%201@mail">', parts)).toBe(
      '<img src="data:image/jpeg;base64,iVBORw==">',
    );
  });

  it("never inlines other mime types, svg included", () => {
    const parts = [
      part("vector", "image/svg+xml"),
      part("doc", "application/pdf"),
      part("page", "text/html"),
    ];
    const html = '<img src="cid:vector"><img src="cid:doc"><img src="cid:page">';
    expect(inlineCidImages(html, parts)).toBe(html);
  });

  it("accepts the allowed image types with parameters and in any case", () => {
    for (const type of ["image/png", "IMAGE/JPEG", "image/gif; name=a.gif", "image/webp", "image/bmp"]) {
      const out = inlineCidImages('<img src="cid:a">', [part("a", type)]);
      expect(out).toMatch(/^<img src="data:image\/[a-z]+;base64,/);
    }
  });

  it("leaves unmatched cid references and cid text outside src or url() as written", () => {
    const parts = [part("known", "image/png")];
    const html = '<img src="cid:unknown"><p>see cid:known</p>';
    expect(inlineCidImages(html, parts)).toBe(html);
  });

  it("stops inlining once the size budget is spent", () => {
    const big = new Uint8Array(3000);
    const parts = [part("big", "image/png", big)];
    const html = '<img src="cid:big"><img src="cid:big">';
    const out = inlineCidImages(html, parts, 5000);
    expect(out.match(/data:image\/png/g)).toHaveLength(1);
    expect(out).toContain('<img src="cid:big">');
  });

  it("returns the html unchanged without parts", () => {
    expect(inlineCidImages('<img src="cid:a">', [])).toBe('<img src="cid:a">');
  });
});
