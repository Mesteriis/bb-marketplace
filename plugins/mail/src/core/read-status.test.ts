import { describe, expect, it } from "vitest";
import { openView, parseOpenFeed, pixelHtml, readStatusOrigin, withPixel } from "./read-status.ts";

const TOKEN = "abcdefghijklmnop.Nf8gINmCVZOx9whO";

describe("read statuses: pure parts", () => {
  it("the endpoint must be a plain https origin", () => {
    expect(readStatusOrigin(" https://Makosh.Example.org/ ")).toBe("https://makosh.example.org");
    expect(readStatusOrigin("https://makosh.example.org:8443")).toBe("https://makosh.example.org:8443");
    expect(readStatusOrigin("http://makosh.example.org")).toBeNull();
    expect(readStatusOrigin("https://makosh.example.org/path")).toBeNull();
    expect(readStatusOrigin('https://x.example.org"><script>')).toBeNull();
    expect(readStatusOrigin("")).toBeNull();
  });

  it("the image is one visible pixel at the end of the body", () => {
    const pixel = pixelHtml("https://makosh.example.org", TOKEN);
    expect(pixel).toBe(`<img src="https://makosh.example.org/o/${TOKEN}.gif" width="1" height="1" alt="" style="border:0;width:1px;height:1px">`);
    expect(withPixel("<p>Hello</p>", pixel)).toBe(`<p>Hello</p>${pixel}`);
  });

  it("the feed is read strictly: wrong shapes and wrong tokens are dropped, an unknown kind becomes unknown", () => {
    expect(parseOpenFeed("nope")).toBeNull();
    expect(parseOpenFeed({ events: "x", next: 1 })).toBeNull();
    expect(parseOpenFeed({ events: [], next: -1 })).toBeNull();
    expect(
      parseOpenFeed({
        events: [
          { seq: 1, token: TOKEN, at: "2026-11-20T10:00:00Z", kind: "mobile" },
          { seq: 2, token: "<script>", at: "2026-11-20T10:00:00Z", kind: "mobile" },
          { seq: 3, token: TOKEN, at: "not a date", kind: "mobile" },
          { seq: 0, token: TOKEN, at: "2026-11-20T10:00:00Z", kind: "mobile" },
          { seq: 5, token: TOKEN, at: "2026-11-20T11:00:00Z", kind: "<b>bold</b>" },
          null,
        ],
        next: 5,
      }),
    ).toEqual({
      events: [
        { seq: 1, token: TOKEN, at: "2026-11-20T10:00:00.000Z", kind: "mobile" },
        { seq: 5, token: TOKEN, at: "2026-11-20T11:00:00.000Z", kind: "unknown" },
      ],
      next: 5,
    });
  });

  it("the page counts opens that are not plainly a machine and says the latest", () => {
    expect(openView([])).toEqual({ count: 0, lastAt: null });
    expect(
      openView([
        { at: "2026-11-20T10:00:00.000Z", kind: "gmail-proxy" },
        { at: "2026-11-20T12:00:00.000Z", kind: "machine" },
        { at: "2026-11-20T11:00:00.000Z", kind: "mobile" },
      ]),
    ).toEqual({ count: 2, lastAt: "2026-11-20T11:00:00.000Z" });
  });
});
