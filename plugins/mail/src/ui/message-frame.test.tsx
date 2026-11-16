// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageBody } from "../core/index.ts";
import { applyQuotesShown, MessageFrame, SHOW_QUOTES_TEXT } from "./message-frame.tsx";
import { EMAIL_CSP } from "./sanitize.ts";

installTestPluginRuntime();
afterEach(cleanup);

const body = (overrides: Partial<MessageBody>): MessageBody => ({
  messageId: "m-1",
  text: null,
  html: null,
  htmlTruncated: false,
  remoteImagesAllowed: false,
  codeBlocks: [],
  ...overrides,
});

function frame(props: Partial<Parameters<typeof MessageFrame>[0]> & { body: MessageBody }) {
  return render(
    <MessageFrame
      title="Message from Ada"
      onOpenLink={vi.fn()}
      remoteImages={false}
      onShowImages={vi.fn()}
      senderAddress={null}
      onAlwaysShowImages={vi.fn()}
      senderTrusted={false}
      onStopImages={vi.fn()}
      {...props}
    />,
  );
}

describe("MessageFrame slice 3h", () => {
  it("folds quoted plain text behind Show quoted text", () => {
    const onToggleQuotes = vi.fn();
    frame({ body: body({ text: "My answer\n\nOn Mon, Ada wrote:\n> old line\n" }), quotesShown: false, onToggleQuotes });
    expect(screen.getByText("My answer")).toBeTruthy();
    expect(screen.queryByText(/old line/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: SHOW_QUOTES_TEXT }));
    expect(onToggleQuotes).toHaveBeenCalled();
  });

  it("shows plain text of an HTML mail on Show plain text", () => {
    frame({ body: body({ html: '<p>Hello</p><p><a href="https://example.org/x">site</a></p>' }), view: "plain" });
    expect(screen.queryByTitle("Message from Ada")).toBeNull();
    expect(screen.getByText(/site <https:\/\/example.org\/x>/)).toBeTruthy();
  });

  it("marks quotes in the HTML frame and adds the dark style with the same CSP", () => {
    frame({
      body: body({ html: '<p>Reply</p><blockquote type="cite">old</blockquote>' }),
      dark: true,
      quotesShown: false,
      onToggleQuotes: vi.fn(),
    });
    const iframe = screen.getByTitle("Message from Ada") as HTMLIFrameElement;
    const doc = iframe.getAttribute("srcdoc") ?? "";
    expect(doc).toContain("data-mk-quote");
    expect(doc).toContain(`content="${EMAIL_CSP}"`);
    expect(doc).toContain("color-scheme: dark");
    expect(iframe.getAttribute("sandbox")).toBe("allow-same-origin");
    expect(screen.getByRole("button", { name: SHOW_QUOTES_TEXT })).toBeTruthy();
  });

  it("a mail that declares dark support keeps its own colors", () => {
    frame({ body: body({ html: '<meta name="color-scheme" content="light dark"><p>x</p>' }), dark: true });
    const doc = (screen.getByTitle("Message from Ada") as HTMLIFrameElement).getAttribute("srcdoc") ?? "";
    expect(doc).toContain("color-scheme: dark");
    expect(doc).not.toContain("invert(");
  });

  it("toggles the quotes through the frame's document", () => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    applyQuotesShown(iframe, true);
    expect(iframe.contentDocument?.documentElement.getAttribute("data-mk-quotes")).toBe("shown");
    applyQuotesShown(iframe, false);
    expect(iframe.contentDocument?.documentElement.hasAttribute("data-mk-quotes")).toBe(false);
    iframe.remove();
  });
});

describe("MessageFrame slice 3i", () => {
  const loaded = (onLinkHover = vi.fn(), onOpenLink = vi.fn()) => {
    frame({ body: body({ html: "<p>x</p>" }), onLinkHover, onOpenLink });
    const iframe = screen.getByTitle("Message from Ada") as HTMLIFrameElement;
    const doc = iframe.contentDocument!;
    fireEvent.load(iframe);
    doc.body.innerHTML =
      '<p><a id="l" href="https://shop.example.com/sale" data-mk-cleaned="2"> Big   sale </a> <span id="s">text</span></p>';
    return { iframe, doc, anchor: doc.getElementById("l")!, span: doc.getElementById("s")!, onLinkHover, onOpenLink };
  };

  it("reports the hovered link with its text and marks, and clears on mouseout", () => {
    const { doc, anchor, span, onLinkHover } = loaded();
    anchor.dispatchEvent(new (doc.defaultView as Window & typeof globalThis).MouseEvent("mouseover", { bubbles: true }));
    expect(onLinkHover).toHaveBeenLastCalledWith({ href: "https://shop.example.com/sale", text: "Big sale", removed: 2, unwrapped: false });
    anchor.dispatchEvent(new (doc.defaultView as Window & typeof globalThis).MouseEvent("mouseout", { bubbles: true, relatedTarget: span }));
    expect(onLinkHover).toHaveBeenLastCalledWith(null);
  });

  it("reports focus too, and a click opens with the visible text", () => {
    const { doc, anchor, onLinkHover, onOpenLink } = loaded();
    anchor.dispatchEvent(new (doc.defaultView as Window & typeof globalThis).FocusEvent("focusin", { bubbles: true }));
    expect(onLinkHover).toHaveBeenLastCalledWith(expect.objectContaining({ href: "https://shop.example.com/sale" }));
    anchor.dispatchEvent(new (doc.defaultView as Window & typeof globalThis).FocusEvent("focusout", { bubbles: true }));
    expect(onLinkHover).toHaveBeenLastCalledWith(null);
    anchor.dispatchEvent(new (doc.defaultView as Window & typeof globalThis).MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onOpenLink).toHaveBeenCalledWith("https://shop.example.com/sale", "Big sale");
  });

  it("a new load clears the status line and leaves one listener of each kind", () => {
    const onLinkHover = vi.fn();
    frame({ body: body({ html: "<p>x</p>" }), onLinkHover });
    const iframe = screen.getByTitle("Message from Ada") as HTMLIFrameElement;
    const doc = iframe.contentDocument!;
    const live = new Map<string, number>();
    const add = doc.addEventListener.bind(doc);
    const remove = doc.removeEventListener.bind(doc);
    doc.addEventListener = ((type: string, ...rest: unknown[]) => {
      live.set(type, (live.get(type) ?? 0) + 1);
      return (add as (...args: unknown[]) => void)(type, ...rest);
    }) as typeof doc.addEventListener;
    doc.removeEventListener = ((type: string, ...rest: unknown[]) => {
      live.set(type, (live.get(type) ?? 0) - 1);
      return (remove as (...args: unknown[]) => void)(type, ...rest);
    }) as typeof doc.removeEventListener;
    fireEvent.load(iframe);
    fireEvent.load(iframe);
    fireEvent.load(iframe);
    expect(onLinkHover).toHaveBeenLastCalledWith(null);
    for (const type of ["click", "auxclick", "mouseover", "mouseout", "focusin", "focusout"]) expect(live.get(type)).toBe(1);
  });

  it("counts trackers: allowed mode says how many were blocked", () => {
    frame({ body: body({ html: '<p>x</p><img src="https://mailtrack.io/t/o.png">', remoteImagesAllowed: true }) });
    expect(screen.getByText("Images shown \u00b7 1 tracker blocked")).toBeTruthy();
  });

  it("trackers only: the count and no Show images", () => {
    frame({ body: body({ html: '<p>x</p><img src="https://mailtrack.io/t/o.png"><img src="https://mailtrack.io/t/p.png">' }), senderAddress: "ada@example.org" });
    expect(screen.getByText("Remote images: this message has 2 trackers; they stay blocked.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show images" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Always show/ })).toBeNull();
  });

  it("a held sender's bar says why and offers no Always show", () => {
    frame({
      body: body({ html: '<img src="https://images.example.org/a.png">' }),
      senderAddress: "ada@example.org",
      imagesHeld: "the sender check failed",
    });
    expect(screen.getByText("Images from this sender are not loaded automatically because the sender check failed.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show images" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Always show/ })).toBeNull();
  });

  it("cleans links in the frame unless cleanLinks is off", () => {
    const html = '<a href="https://shop.example.com/?utm_source=x&amp;id=1">s</a>';
    const { unmount } = frame({ body: body({ html }) });
    expect(screen.getByTitle("Message from Ada").getAttribute("srcdoc")).not.toContain("utm_source");
    unmount();
    frame({ body: body({ html }), cleanLinks: false });
    expect(screen.getByTitle("Message from Ada").getAttribute("srcdoc")).toContain("utm_source");
  });
});
