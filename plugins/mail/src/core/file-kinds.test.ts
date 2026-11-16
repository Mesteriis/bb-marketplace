import { describe, expect, it } from "vitest";
import { VIEW_CAPS, fileKindOf, isViewable, sniffKind, sniffType, viewableAs } from "./file-kinds.ts";

const bytes = (...parts: (string | number[])[]) =>
  new Uint8Array(parts.flatMap((part) => (typeof part === "string" ? [...new TextEncoder().encode(part)] : part)));

describe("fileKindOf", () => {
  it.each([
    ["application/pdf", "a.bin", "pdf"],
    ["application/octet-stream", "Report.PDF", "pdf"],
    ["image/png", "a.png", "image"],
    ["image/svg+xml", "a.svg", "image"],
    ["text/calendar", "invite", "calendar"],
    ["application/octet-stream", "invite.ICS", "calendar"],
    ["text/plain", "a.txt", "text"],
    ["text/html", "a.html", "text"],
    ["application/json", "a.json", "text"],
    ["application/xml", null, "text"],
    ["application/x-patch", "a.patch", "text"],
    ["application/x-diff", "a.diff", "text"],
    ["application/zip", "a.zip", "archive"],
    ["application/gzip", "a.gz", "archive"],
    ["application/x-7z-compressed", "a.7z", "archive"],
    ["application/x-rar-compressed", "a.rar", "archive"],
    ["application/vnd.rar", "a.rar", "archive"],
    ["application/x-tar", "a.tar", "archive"],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.docx", "document"],
    ["application/vnd.oasis.opendocument.text", "a.odt", "document"],
    ["application/msword", "a.doc", "document"],
    ["application/vnd.ms-excel", "a.xls", "document"],
    ["application/vnd.ms-powerpoint", "a.ppt", "document"],
    ["application/rtf", "a.rtf", "document"],
    ["APPLICATION/PDF", null, "pdf"],
    ["application/octet-stream", "a.exe", "other"],
  ] as const)("%s %s -> %s", (mime, name, kind) => {
    expect(fileKindOf(mime, name)).toBe(kind);
  });

  it("checks the pdf arm before the image arm, as the migration does", () => {
    expect(fileKindOf("image/png", "scan.pdf")).toBe("pdf");
  });
});

describe("isViewable", () => {
  it("allows images except SVG, PDF, text and calendar", () => {
    expect(isViewable("image", "image/png")).toBe(true);
    expect(isViewable("image", "image/svg+xml")).toBe(false);
    expect(isViewable("image", "IMAGE/SVG+XML; charset=utf-8")).toBe(false);
    expect(isViewable("pdf", "application/pdf")).toBe(true);
    expect(isViewable("text", "text/plain")).toBe(true);
    expect(isViewable("calendar", "text/calendar")).toBe(true);
    expect(isViewable("document", "application/msword")).toBe(false);
    expect(isViewable("archive", "application/zip")).toBe(false);
    expect(isViewable("other", "application/octet-stream")).toBe(false);
  });
});

describe("sniffType", () => {
  it("reads each magic number", () => {
    expect(sniffType(bytes("%PDF-1.7\n"), "application/pdf")).toEqual({ kind: "pdf", mimeType: "application/pdf" });
    expect(sniffType(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]), "")).toEqual({
      kind: "image",
      mimeType: "image/png",
    });
    expect(sniffType(bytes([0xff, 0xd8, 0xff, 0xe0]), "")).toEqual({ kind: "image", mimeType: "image/jpeg" });
    expect(sniffType(bytes("GIF89a", [1, 0]), "")).toEqual({ kind: "image", mimeType: "image/gif" });
    expect(sniffType(bytes("GIF87a", [1, 0]), "")).toEqual({ kind: "image", mimeType: "image/gif" });
    expect(sniffType(bytes("RIFF", [0, 0, 0, 0], "WEBPVP8 "), "")).toEqual({ kind: "image", mimeType: "image/webp" });
    expect(sniffType(bytes([0, 0, 0, 0x1c], "ftypavif", [0, 0]), "")).toEqual({ kind: "image", mimeType: "image/avif" });
    const bmp = new Uint8Array(30);
    bmp.set([0x42, 0x4d]);
    bmp[14] = 40;
    expect(sniffType(bmp, "")).toEqual({ kind: "image", mimeType: "image/bmp" });
  });

  it("does not read text starting with BM as a bitmap", () => {
    expect(sniffKind(bytes("BMW service report, invented text"), "text/plain")).toBe("text");
  });

  it("finds SVG behind a BOM and an XML declaration", () => {
    expect(sniffKind(bytes([0xef, 0xbb, 0xbf], '<?xml version="1.0"?>\n<!-- c -->\n<svg xmlns="x"/>'), "image/png")).toBe(
      "svg",
    );
    expect(sniffKind(bytes("  <SVG/>"), "")).toBe("svg");
  });

  it("finds HTML", () => {
    expect(sniffKind(bytes("<!DOCTYPE html><html></html>"), "text/plain")).toBe("html");
    expect(sniffKind(bytes("\n<html><body>x</body></html>"), "text/plain")).toBe("html");
  });

  it("reads NUL-free UTF-8 as text and binary with NUL as nothing", () => {
    expect(sniffKind(bytes("Invented notes \u00e9\u4e2d"), "text/plain")).toBe("text");
    expect(sniffKind(bytes("abc", [0], "def"), "text/plain")).toBeNull();
    expect(sniffKind(bytes([0xc3]), "text/plain")).toBe("text"); // a cut multibyte character at the end
  });

  it("reads non-UTF-8 bytes as text only with a declared charset", () => {
    const latin = bytes("caf", [0xe9], " notes");
    expect(sniffKind(latin, "text/plain")).toBeNull();
    expect(sniffKind(latin, "text/plain; charset=iso-8859-1")).toBe("text");
    expect(sniffKind(latin, "text/plain; charset=utf-8")).toBeNull();
  });
});

describe("viewableAs", () => {
  it("serves the stored kind only when the sniffed kind agrees", () => {
    expect(viewableAs("pdf", "application/pdf", { kind: "pdf", mimeType: "application/pdf" })).toBe("pdf");
    expect(viewableAs("image", "image/png", { kind: "image", mimeType: "image/png" })).toBe("image");
    expect(viewableAs("calendar", "text/calendar", { kind: "text", mimeType: "text/plain" })).toBe("calendar");
    expect(viewableAs("text", "text/plain", { kind: "text", mimeType: "text/plain" })).toBe("text");
  });

  it("refuses a mismatch between declared and sniffed", () => {
    expect(viewableAs("image", "image/png", { kind: "svg", mimeType: "image/svg+xml" })).toBeNull();
    expect(viewableAs("image", "image/png", { kind: "pdf", mimeType: "application/pdf" })).toBeNull();
    expect(viewableAs("pdf", "application/pdf", { kind: "html", mimeType: "text/html" })).toBeNull();
    expect(viewableAs("text", "text/plain", { kind: "html", mimeType: "text/html" })).toBeNull();
    expect(viewableAs("text", "text/plain", null)).toBeNull();
    expect(viewableAs("image", "image/svg+xml", { kind: "svg", mimeType: "image/svg+xml" })).toBeNull();
    expect(viewableAs("other", "application/octet-stream", { kind: "text", mimeType: "text/plain" })).toBeNull();
  });
});

describe("VIEW_CAPS", () => {
  it("are the spec's", () => {
    expect(VIEW_CAPS).toEqual({ image: 20 * 1024 * 1024, pdf: 25 * 1024 * 1024, textShown: 2 * 1024 * 1024 });
  });
});
