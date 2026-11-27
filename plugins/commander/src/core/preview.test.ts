import { describe, expect, it } from "vitest";
import { parsePosix } from "./path.ts";
import { detectKind, fromWire, hexLines, MAX_VIEW_BYTES, readForView, toWire, viewModel } from "./preview.ts";
import type { FileProvider } from "./provider.ts";
import { FakeProvider } from "./testing/fake-provider.ts";

const PNG_HEAD = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const text = (value: string) => new TextEncoder().encode(value);

describe("detectKind", () => {
  it("recognizes PNG by its signature", () => {
    expect(detectKind("picture.png", PNG_HEAD)).toBe("image");
  });

  it("treats SVG as an image even when the name is the only signal", () => {
    expect(detectKind("logo.svg", text("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"))).toBe("image");
  });

  it("keeps HTML as text, so it is shown as source and never rendered", () => {
    expect(detectKind("page.html", text("<html><script>alert(1)</script></html>"))).toBe("text");
  });

  it("classifies a NUL byte as binary", () => {
    expect(detectKind("data.bin", Uint8Array.from([0x41, 0x00, 0x42]))).toBe("binary");
  });

  it("classifies bytes that are not valid UTF-8 as binary", () => {
    expect(detectKind("legacy.txt", Uint8Array.from([0xff, 0xfe, 0x41]))).toBe("binary");
  });

  it("keeps text whose window ends inside a two-byte character", () => {
    // "A" then the first byte of "é" (U+00E9 = C3 A9); the window cut falls between them.
    expect(detectKind("note.txt", Uint8Array.from([0x41, 0xc3]))).toBe("text");
  });
});

describe("hexLines", () => {
  it("prints 16 bytes per line with an 8-digit offset", () => {
    expect(hexLines(PNG_HEAD, 0n)).toEqual(["00000000  89 50 4e 47 0d 0a 1a 0a 00 00 00 0d 49 48 44 52"]);
  });

  it("continues the offset on the next line", () => {
    const bytes = Uint8Array.from({ length: 17 }, (_, index) => index);
    expect(hexLines(bytes, 0n)).toEqual([
      "00000000  00 01 02 03 04 05 06 07 08 09 0a 0b 0c 0d 0e 0f",
      "00000010  10",
    ]);
  });
});

describe("readForView", () => {
  it("returns at most 1 MiB of a 2 MiB file and reports truncation", async () => {
    const provider = new FakeProvider("local");
    const path = parsePosix("/big.txt");
    provider.put(path, new Uint8Array(2 * 1024 * 1024).fill(0x41));

    const view = await readForView(provider, path, { offset: 0n, length: 2 * 1024 * 1024 }, new AbortController().signal);

    expect(MAX_VIEW_BYTES).toBe(1048576);
    expect(view.bytes.byteLength).toBe(1048576);
    expect(view.truncated).toBe(true);
    expect(view.size).toBe(2097152n);
  });

  it("does not mark a file that fits in the window as truncated", async () => {
    const provider = new FakeProvider("local");
    const path = parsePosix("/short.txt");
    provider.put(path, text("hello"));

    const view = await readForView(provider, path, { offset: 0n, length: 4096 }, new AbortController().signal);

    expect(view.kind).toBe("text");
    expect(view.bytes.byteLength).toBe(5);
    expect(view.truncated).toBe(false);
  });
});

describe("readForView consistency", () => {
  it("fails with changed_since_plan when the file changes between stat and read", async () => {
    const provider = new FakeProvider("local");
    const path = parsePosix("/moving.txt");
    provider.put(path, text("first version"));
    // Changes the file after stat has returned the fingerprint, before the window read.
    const racing: FileProvider = Object.assign(Object.create(provider) as FileProvider, {
      stat: async (target: Parameters<FileProvider["stat"]>[0], signal: AbortSignal) => {
        const entry = await provider.stat(target, signal);
        provider.put(path, text("second, longer version"));
        return entry;
      },
    });

    await expect(readForView(racing, path, { offset: 0n, length: 4096 }, new AbortController().signal))
      .rejects.toMatchObject({ code: "changed_since_plan" });
  });
});

describe("wire form", () => {
  it("carries image bytes as base64 and restores them exactly", () => {
    const model = viewModel("picture.png", { kind: "image", mime: "image/png", bytes: PNG_HEAD, offset: 0n, size: 16n, truncated: false });

    const wire = toWire(model);

    expect(wire).toEqual({ kind: "image", mime: "image/png", base64: "iVBORw0KGgoAAAANSUhEUg==", truncated: false });
    expect(fromWire(wire)).toEqual(model);
  });
});

describe("viewModel", () => {
  it("shows a binary window as hex lines and keeps the truncation flag", () => {
    const model = viewModel("data.bin", { kind: "binary", bytes: PNG_HEAD, offset: 0n, size: 16n, truncated: false });

    expect(model).toEqual({
      kind: "binary",
      lines: ["00000000  89 50 4e 47 0d 0a 1a 0a 00 00 00 0d 49 48 44 52"],
      truncated: false,
    });
  });
});
