// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentViewer, NOT_VIEWABLE_TEXT, TEXT_CUT_TEXT, viewerShows, type ViewerHost, type ViewRequest } from "./attachment-viewer.tsx";
import { PDF_UNAVAILABLE_TEXT, pdfLinks, PdfUnavailable, PdfView, type PdfDocument, type PdfEngine } from "./pdf-view.tsx";

installTestPluginRuntime();
afterEach(cleanup);

const request = (overrides: Partial<ViewRequest> = {}): ViewRequest => ({
  messageId: "m-1",
  partId: "2",
  filename: "photo.png",
  mimeType: "image/png",
  size: 1024,
  kind: "image",
  ...overrides,
});

function host(type: string, body: string | Uint8Array, overrides: Partial<ViewerHost> = {}) {
  const revoked: string[] = [];
  const created: Blob[] = [];
  const h: ViewerHost = {
    getTicket: vi.fn(async (r: ViewRequest) => ({ url: "/plugin/download/view-1", kind: r.kind, mimeType: type, size: r.size })),
    fetch: vi.fn(async () => new Response(typeof body === "string" ? body : new Blob([body as BlobPart]), { status: 200, headers: { "content-type": type } })),
    createObjectUrl: (blob) => {
      created.push(blob);
      return "blob:view-1";
    },
    revokeObjectUrl: (url) => revoked.push(url),
    pdf: null,
    ...overrides,
  };
  return { h, revoked, created };
}

describe("AttachmentViewer", () => {
  it("shows an image from a blob of the server's type and revokes it on close", async () => {
    const { h, revoked, created } = host("image/png", new Uint8Array([137, 80, 78, 71]));
    const onOpenLink = vi.fn();
    const { rerender } = render(<AttachmentViewer request={request()} host={h} onDownload={vi.fn()} onOpenLink={onOpenLink} onClose={vi.fn()} />);
    const img = await screen.findByRole("img", { name: "photo.png" });
    expect(img.getAttribute("src")).toBe("blob:view-1");
    expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(created[0]!.type).toBe("image/png");
    rerender(<AttachmentViewer request={null} host={h} onDownload={vi.fn()} onOpenLink={onOpenLink} onClose={vi.fn()} />);
    await waitFor(() => expect(revoked).toEqual(["blob:view-1"]));
    expect(onOpenLink).not.toHaveBeenCalled();
  });

  it("shows text through the host's code view and says when it was cut", async () => {
    const { h, created } = host("text/plain; charset=utf-8", "line one\nline two");
    const renderCode = vi.fn((content: string) => <pre data-testid="code">{content}</pre>);
    render(
      <AttachmentViewer
        request={request({ filename: "notes.txt", mimeType: "text/plain", kind: "text", size: 3 * 1024 * 1024 })}
        host={{ ...h, renderCode }}
        onDownload={vi.fn()}
        onOpenLink={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect((await screen.findByTestId("code")).textContent).toBe("line one\nline two");
    expect(renderCode).toHaveBeenCalledWith("line one\nline two", "notes.txt");
    expect(screen.getByText((_, el) => el?.tagName === "P" && (el.textContent ?? "").startsWith(TEXT_CUT_TEXT))).toBeTruthy();
    expect(created).toHaveLength(0);
  });

  it("refuses SVG and HTML without asking for a ticket", async () => {
    const { h } = host("image/svg+xml", "<svg/>");
    render(
      <AttachmentViewer request={request({ filename: "x.svg", mimeType: "image/svg+xml" })} host={h} onDownload={vi.fn()} onOpenLink={vi.fn()} onClose={vi.fn()} />,
    );
    expect(await screen.findByText(NOT_VIEWABLE_TEXT)).toBeTruthy();
    expect(h.getTicket).not.toHaveBeenCalled();
    expect(viewerShows("other", "text/html")).toBe(false);
    expect(viewerShows("text", "text/html")).toBe(false);
  });

  it("never builds an SVG blob even when the server answers with one", async () => {
    const { h, created } = host("image/svg+xml", "<svg/>");
    render(<AttachmentViewer request={request()} host={h} onDownload={vi.fn()} onOpenLink={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText(NOT_VIEWABLE_TEXT)).toBeTruthy();
    expect(created).toHaveLength(0);
  });

  it("a 409 from the server is not viewable", async () => {
    const { h } = host("image/png", "", { fetch: vi.fn(async () => new Response("not_viewable", { status: 409 })) });
    render(<AttachmentViewer request={request()} host={h} onDownload={vi.fn()} onOpenLink={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText(NOT_VIEWABLE_TEXT)).toBeTruthy();
  });

  it("shows the ticket's refusal and offers Download", async () => {
    const onDownload = vi.fn();
    const { h } = host("image/png", "", { getTicket: vi.fn(() => Promise.reject(new Error("This file is too large to view"))) });
    render(<AttachmentViewer request={request()} host={h} onDownload={onDownload} onOpenLink={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText("This file is too large to view")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(onDownload).toHaveBeenCalled();
  });
});

function fakeDoc(links: string[] = []) {
  const doc: PdfDocument & { renders: unknown[] } = {
    pages: 12,
    renders: [],
    render: async (page, _canvas, scale) => {
      doc.renders.push({ page, scale });
    },
    links: async () => links,
    close: vi.fn(),
  };
  return doc;
}

describe("PdfView", () => {
  it("null engine means download-only", () => {
    const onDownload = vi.fn();
    render(<PdfView engine={null} bytes={new Uint8Array([1])} onOpenLink={vi.fn()} onDownload={onDownload} />);
    expect(screen.getByText(PDF_UNAVAILABLE_TEXT)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(onDownload).toHaveBeenCalled();
  });

  it("a worker that cannot start means download-only", async () => {
    const engine: PdfEngine = { open: () => Promise.reject(new PdfUnavailable()) };
    render(<PdfView engine={engine} bytes={new Uint8Array([1])} onOpenLink={vi.fn()} onDownload={vi.fn()} />);
    expect(await screen.findByText(PDF_UNAVAILABLE_TEXT)).toBeTruthy();
  });

  it("pages through the document and opens only http(s) and mailto links, by click", async () => {
    const doc = fakeDoc(["https://example.org/a", "javascript:alert(1)", "file:///etc/passwd", "mailto:a@example.org", "https://example.org/a"]);
    const onOpenLink = vi.fn();
    const { unmount } = render(<PdfView engine={{ open: async () => doc }} bytes={new Uint8Array([1])} onOpenLink={onOpenLink} onDownload={vi.fn()} />);
    expect(await screen.findByText("Page 1 of 12")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("Page 2 of 12")).toBeTruthy();
    await waitFor(() => expect(doc.renders).toContainEqual({ page: 2, scale: 1 }));
    expect(await screen.findByText("Links in this PDF (2)")).toBeTruthy();
    expect(onOpenLink).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "mailto:a@example.org" }));
    expect(onOpenLink).toHaveBeenCalledWith("mailto:a@example.org");
    expect(screen.getByText("Some parts of this PDF may not display")).toBeTruthy();
    unmount();
    expect(doc.close).toHaveBeenCalled();
    expect(pdfLinks(["javascript:x", "https://example.org"])).toEqual(["https://example.org"]);
  });
});
