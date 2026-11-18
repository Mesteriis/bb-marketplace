// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageBody } from "../core/index.ts";
import { escapeHtml, PRINT_CSP, PRINT_SANDBOX, printDocument, printFileName, printHtml, REMOTE_NOT_PRINTED_TEXT } from "./print.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

const body = (overrides: Partial<MessageBody>): MessageBody => ({
  messageId: "m-1",
  text: null,
  html: null,
  htmlTruncated: false,
  remoteImagesAllowed: true,
  codeBlocks: [],
  ...overrides,
});

const header = {
  from: { name: "Ada <Example>", address: "ada@example.org" },
  to: [{ name: null, address: "owner@example.org" }],
  cc: [],
  date: "2026-11-16T08:00:00.000Z",
  subject: "Plan <b>bold</b> & more",
};

describe("printDocument", () => {
  it("escapes the headers and keeps the mail's sanitized body", () => {
    const html = printDocument([{ header, body: body({ html: "<p>Hello</p><script>alert(1)</script>" }) }], header.subject);
    expect(html).toContain("Plan &lt;b&gt;bold&lt;/b&gt; &amp; more");
    expect(html).toContain("Ada &lt;Example&gt; &lt;ada@example.org&gt;");
    expect(html).not.toContain("<b>bold</b>");
    expect(html).not.toContain("<script");
    expect(html).toContain("<p>Hello</p>");
  });

  it("never loads remote images, even when the sender is allowed", () => {
    const html = printDocument([{ header, body: body({ html: '<img src="https://tracker.example.org/p.gif"><p>x</p>' }) }], "x");
    expect(html).toContain(`content="${PRINT_CSP}"`);
    expect(PRINT_CSP).not.toContain("https:");
    expect(html).not.toContain("tracker.example.org");
    expect(html).toContain(REMOTE_NOT_PRINTED_TEXT);
  });

  it("prints plain text in a pre, escaped", () => {
    const html = printDocument([{ header, body: body({ text: "a < b" }) }], "x");
    expect(html).toContain("<pre>a &lt; b</pre>");
    expect(escapeHtml(`"'`)).toBe("&quot;&#39;");
  });

  it("slice 3i: prints cleaned links, and no remote-image note for trackers only", () => {
    const html = printDocument(
      [{ header, body: body({ html: '<p><a href="https://shop.example.com/sale?utm_source=x&amp;id=7">sale</a></p><img src="https://mailtrack.io/trace/o.png">' }) }],
      "x",
    );
    expect(html).toContain('href="https://shop.example.com/sale?id=7"');
    expect(html).not.toContain("utm_source");
    expect(html).not.toContain("mailtrack.io");
    expect(html).not.toContain(REMOTE_NOT_PRINTED_TEXT);
    const kept = printDocument([{ header, body: body({ html: '<a href="https://shop.example.com/?utm_source=x">s</a>' }) }], "x", { cleanLinks: false });
    expect(kept).toContain("utm_source=x");
  });

  it("names the saved file by date and subject", () => {
    const name = printFileName(new Date(2026, 10, 16), "Plan Q4/Q1");
    expect(name).toBe("2026-11-16 Plan Q4 Q1.html");
    expect(printFileName(new Date(2026, 10, 16), "  ")).toBe("2026-11-16 Message.html");
  });
});

describe("printHtml", () => {
  it("prints from a frame sandboxed with exactly allow-same-origin allow-modals", async () => {
    const pending = printHtml("<!doctype html><p>x</p>");
    const frame = document.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe(PRINT_SANDBOX);
    expect(PRINT_SANDBOX).toBe("allow-same-origin allow-modals");
    const print = vi.fn();
    Object.defineProperty(frame, "contentWindow", { value: { print, addEventListener: vi.fn() } });
    frame.dispatchEvent(new Event("load"));
    expect(await pending).toBe(true);
    expect(print).toHaveBeenCalled();
  });

  it("answers false when print throws, so the page offers the file", async () => {
    const pending = printHtml("<!doctype html><p>x</p>");
    const frame = document.querySelector("iframe")!;
    Object.defineProperty(frame, "contentWindow", {
      value: {
        print: () => {
          throw new Error("no print here");
        },
        addEventListener: vi.fn(),
      },
    });
    frame.dispatchEvent(new Event("load"));
    expect(await pending).toBe(false);
    expect(document.querySelector("iframe")).toBeNull();
  });
});
