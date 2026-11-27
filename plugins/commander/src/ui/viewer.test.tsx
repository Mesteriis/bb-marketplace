// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Viewer } from "./viewer.tsx";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
const HTML = '<html><script>alert(1)</script><iframe srcdoc="<b>x</b>"></iframe></html>';

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:commander/1");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Viewer", () => {
  it("renders SVG only as an img with a blob URL, never as svg or script in the DOM", () => {
    const bytes = new TextEncoder().encode(SVG);
    const { container } = render(
      <Viewer name="logo.svg" model={{ kind: "image", mime: "image/svg+xml", bytes, truncated: false }} />,
    );

    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:commander/1");
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });

  it("revokes the blob URL when the viewer closes", () => {
    const bytes = new TextEncoder().encode(SVG);
    const { unmount } = render(
      <Viewer name="logo.svg" model={{ kind: "image", mime: "image/svg+xml", bytes, truncated: false }} />,
    );

    unmount();

    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:commander/1");
  });

  it("shows HTML as its source text, with no iframe or script element", () => {
    const { container } = render(
      <Viewer name="page.html" model={{ kind: "text", text: HTML, truncated: false }} />,
    );

    expect(container.querySelector("pre")?.textContent).toBe(HTML);
    expect(container.querySelector("iframe, script")).toBeNull();
  });

  it("shows binary content as hex lines", () => {
    const { container } = render(
      <Viewer name="data.bin" model={{
        kind: "binary",
        lines: ["00000000  89 50 4e 47 0d 0a 1a 0a  00 00 00 0d 49 48 44 52  |.PNG........IHDR|"],
        truncated: false, shown: 16, total: "16",
      }} />,
    );

    expect(container.querySelector("pre")?.textContent)
      .toBe("00000000  89 50 4e 47 0d 0a 1a 0a  00 00 00 0d 49 48 44 52  |.PNG........IHDR|");
    expect(container.querySelector(".commander-viewer-count")?.textContent).toBe("Показано 16 из 16 байт");
  });
});
