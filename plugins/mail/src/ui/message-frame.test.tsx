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
