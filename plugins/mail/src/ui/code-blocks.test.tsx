// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BodyParts, HtmlCodeBlocks } from "./code-blocks.tsx";
import { MessageFrame } from "./message-frame.tsx";

installTestPluginRuntime();
afterEach(cleanup);

const FENCE = "```";
const TEXT = ["Hi,", "", `${FENCE}ts`, "const a = <b>1</b>;", FENCE, "", "Thanks"].join("\n");
const DIFF = ["See:", "diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@", "-a", "+b"].join("\n");

describe("BodyParts", () => {
  it("draws code through the injected highlighter and text as before", () => {
    const renderCode = vi.fn((content: string, path: string) => <div data-testid="host-code" data-path={path}>{content}</div>);
    render(<BodyParts text={TEXT} renderers={{ renderCode }} />);
    expect(screen.getByTestId("host-code").dataset.path).toBe("snippet.ts");
    expect(renderCode).toHaveBeenCalledWith("const a = <b>1</b>;", "snippet.ts");
    expect(screen.getByText("Hi,")).toBeTruthy();
    expect(document.querySelector("b")).toBeNull();
  });

  it("draws a diff per file through the injected viewer", () => {
    const renderDiff = vi.fn((patch: string, path: string) => <div data-testid={`diff-${path}`}>{patch}</div>);
    render(<BodyParts text={DIFF} renderers={{ renderDiff }} />);
    expect(screen.getByTestId("diff-src/a.ts")).toBeTruthy();
  });

  it("falls back to <pre> without host components, and Copy uses the injected clipboard", () => {
    const copy = vi.fn();
    render(<BodyParts text={TEXT} renderers={{ copy }} />);
    const pre = screen.getByText("const a = <b>1</b>;");
    expect(pre.tagName).toBe("PRE");
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(copy).toHaveBeenCalledWith("const a = <b>1</b>;");
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("plain text without code stays one text block", () => {
    const { container } = render(<BodyParts text="Just words" renderers={{}} />);
    expect(container.querySelectorAll("pre")).toHaveLength(1);
    expect(container.querySelector("figure")).toBeNull();
  });
});

describe("HtmlCodeBlocks and the frame", () => {
  it("shows Code (N) under an HTML message", () => {
    render(<HtmlCodeBlocks blocks={["ls -la", "echo hi"]} renderers={{}} />);
    expect(screen.getByText("Code (2)")).toBeTruthy();
  });

  it("the frame splits a plain body and lists an HTML body's blocks", () => {
    const common = {
      title: "Message",
      onOpenLink: vi.fn(),
      remoteImages: false,
      onShowImages: vi.fn(),
      senderAddress: null,
      onAlwaysShowImages: vi.fn(),
      senderTrusted: false,
      onStopImages: vi.fn(),
    };
    const { unmount } = render(
      <MessageFrame
        {...common}
        body={{ messageId: "m-1", text: TEXT, html: null, htmlTruncated: false, remoteImagesAllowed: false, codeBlocks: [] }}
      />,
    );
    expect(screen.getByRole("figure", { name: "Code (ts)" })).toBeTruthy();
    unmount();
    render(
      <MessageFrame
        {...common}
        body={{ messageId: "m-1", text: null, html: "<p>Hi</p><pre>make test</pre>", htmlTruncated: false, remoteImagesAllowed: false, codeBlocks: ["make test"] }}
      />,
    );
    expect(screen.getByText("Code (1)")).toBeTruthy();
  });
});
