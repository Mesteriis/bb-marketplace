import { describe, expect, it } from "vitest";
import { parsePosix } from "./path.ts";
import { detectKind, fromWire, hexLines, MAX_RESPONSE_BYTES, MAX_VIEW_BYTES, readForView, responseBytes, toWire, viewFor, viewModel } from "./preview.ts";
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
    const result = viewFor("picture.png", { kind: "image", mime: "image/png", bytes: PNG_HEAD, offset: 0n, size: 16n, truncated: false });

    const wire = toWire(result);

    expect(wire).toEqual({
      modes: ["image", "binary"],
      view: { kind: "image", mime: "image/png", base64: "iVBORw0KGgoAAAANSUhEUg==", truncated: false },
    });
    expect(fromWire(wire)).toEqual(result);
  });
});

describe("control characters and response size", () => {
  it("classifies text with a control character as binary, while tab, newline and CR stay text", () => {
    expect(detectKind("notes.txt", Uint8Array.from([0x41, 0x01]))).toBe("binary");
    expect(detectKind("notes.txt", Uint8Array.from([0x41, 0x09, 0x0a, 0x0d, 0x42]))).toBe("text");
  });

  it("shows 600 KiB of 0x01 bytes as binary within the response limit", async () => {
    const provider = new FakeProvider("local");
    const path = parsePosix("/controls.dat");
    provider.put(path, new Uint8Array(600 * 1024).fill(0x01));
    const window = await readForView(provider, path, { offset: 0n, length: MAX_VIEW_BYTES }, new AbortController().signal);

    const result = viewFor("controls.dat", window);

    expect(result.model.kind).toBe("binary");
    expect(result.modes).toEqual(["binary"]);
    expect(responseBytes(toWire(result))).toBeLessThanOrEqual(1048576);
    expect(MAX_RESPONSE_BYTES).toBe(1048576);
  });

  it("cuts 2 MiB of ASCII so the whole JSON response is at most 1048576 bytes and marks it truncated", async () => {
    const provider = new FakeProvider("local");
    const path = parsePosix("/ascii.txt");
    provider.put(path, new Uint8Array(2 * 1024 * 1024).fill(0x41));
    const window = await readForView(provider, path, { offset: 0n, length: 2 * 1024 * 1024 }, new AbortController().signal);

    const result = viewFor("ascii.txt", window);

    expect(result.model.kind).toBe("text");
    expect(responseBytes(toWire(result))).toBeLessThanOrEqual(1048576);
    expect(result.model.truncated).toBe(true);
  });

  it("offers hex instead of an image that does not fit the response whole", () => {
    const big = new Uint8Array(900 * 1024);
    big.set(PNG_HEAD, 0);
    const window = { kind: "image" as const, mime: "image/png" as const, bytes: big, offset: 0n, size: BigInt(big.byteLength), truncated: false };

    const result = viewFor("huge.png", window);

    expect(result.modes).toEqual(["binary"]);
    expect(result.model.kind).toBe("binary");
    expect(responseBytes(toWire(result))).toBeLessThanOrEqual(1048576);
  });

  it("offers text and hex for a text file and honours a requested hex mode", () => {
    const window = { kind: "text" as const, bytes: text("hi"), offset: 0n, size: 2n, truncated: false };

    expect(viewFor("a.txt", window).modes).toEqual(["text", "binary"]);
    expect(viewFor("a.txt", window, "binary").model).toEqual({ kind: "binary", lines: ["00000000  68 69"], truncated: false });
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
