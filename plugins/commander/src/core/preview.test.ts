import { describe, expect, it } from "vitest";
import { parsePosix } from "./path.ts";
import {
  assembleImage, detectKind, fromWire, hexLines, MAX_IMAGE_BYTES, MAX_RESPONSE_BYTES, MAX_VIEW_BYTES,
  readForView, replyFor, responseBytes, type ViewWindow, type WireView,
} from "./preview.ts";
import type { FileProvider } from "./provider.ts";
import { FakeProvider } from "./testing/fake-provider.ts";

const PNG_HEAD = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const text = (value: string) => new TextEncoder().encode(value);
const signal = () => new AbortController().signal;
const path = (name: string) => parsePosix("/" + name);
const version = (size: string) => ({ size, mtimeNs: "1" });

/** A window of a whole file, built by hand; readForView covers the provider path. */
function window(overrides: Partial<ViewWindow> & Pick<ViewWindow, "kind" | "bytes">): ViewWindow {
  return {
    text: false, offset: 0n, size: BigInt(overrides.bytes.byteLength), truncated: false, version: version(String(overrides.bytes.byteLength)),
    ...overrides,
  };
}

describe("hexLines", () => {
  it("prints a full line with an ASCII column and two 8-byte halves", () => {
    expect(hexLines(PNG_HEAD, 0n)).toEqual([
      "00000000  89 50 4E 47 0D 0A 1A 0A  00 00 00 0D 49 48 44 52  |.PNG........IHDR|",
    ]);
  });

  it("continues the offset on the next line", () => {
    const bytes = Uint8Array.from({ length: 17 }, (_, index) => index);
    const lines = hexLines(bytes, 0n);
    expect(lines[0]).toBe("00000000  00 01 02 03 04 05 06 07  08 09 0A 0B 0C 0D 0E 0F  |................|");
    expect(lines[1]).toBe("00000010  10" + " ".repeat(48) + "|.|");
  });

  it("pads a short last line so the ASCII column stays aligned", () => {
    expect(hexLines(Uint8Array.from([0, 1, 2]), 0n)).toEqual(["00000000  00 01 02" + " ".repeat(42) + "|...|"]);
  });

  it("shows printable bytes in the ASCII column", () => {
    expect(hexLines(text("Hi"), 0n)).toEqual(["00000000  48 69" + " ".repeat(45) + "|Hi|"]);
  });
});

describe("detectKind", () => {
  it("recognizes PNG by its signature", () => {
    expect(detectKind(PNG_HEAD, true)).toBe("image");
  });

  it("treats a .svg file with an <svg> root as an image", () => {
    expect(detectKind(text("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"), true)).toBe("image");
  });

  it("does not take page.svg for an image when its root is HTML", () => {
    const html = text("<!doctype html><html><body><script>alert(1)</script></body></html>");
    expect(detectKind(html, true)).toBe("text");
    const view = window({ kind: "text", text: true, bytes: html });
    expect(replyFor(view, "auto", "owner").modes).toEqual(["text", "binary"]);
  });

  it("treats an XML root <svg> as an image even without the extension", () => {
    expect(detectKind(text("<?xml version=\"1.0\"?>\n<!-- made by hand -->\n<svg width=\"1\"/>"), true)).toBe("image");
  });

  it("does not treat the substring <svg inside text as an image", () => {
    expect(detectKind(text("write <svg> tags in the docs"), true)).toBe("text");
  });

  it("keeps HTML as text, so it is shown as source and never rendered", () => {
    expect(detectKind(text("<html><script>alert(1)</script></html>"), true)).toBe("text");
  });

  it("classifies a NUL byte as binary", () => {
    expect(detectKind(Uint8Array.from([0x41, 0x00, 0x42]), true)).toBe("binary");
  });

  it("classifies bytes that are not valid UTF-8 as binary", () => {
    expect(detectKind(Uint8Array.from([0xff, 0xfe, 0x41]), true)).toBe("binary");
  });

  it("treats an incomplete sequence at the end of the file as binary", () => {
    expect(detectKind(Uint8Array.from([0x41, 0xc3]), true)).toBe("binary");
  });

  it("holds back an incomplete sequence at the end of a middle window", () => {
    expect(detectKind(Uint8Array.from([0x41, 0xc3]), false)).toBe("text");
  });

  it("classifies a control character as binary, while tab, newline and carriage return stay text", () => {
    expect(detectKind(Uint8Array.from([0x41, 0x01]), true)).toBe("binary");
    expect(detectKind(Uint8Array.from([0x41, 0x09, 0x0a, 0x0d, 0x42]), true)).toBe("text");
  });
});

describe("readForView", () => {
  it("returns at most 1 MiB of a 2 MiB file and reports truncation", async () => {
    const provider = new FakeProvider("local");
    provider.put(path("big.txt"), new Uint8Array(2 * 1024 * 1024).fill(0x41));

    const view = await readForView(provider, path("big.txt"), { offset: 0n, length: 2 * 1024 * 1024 }, signal());

    expect(MAX_VIEW_BYTES).toBe(1048576);
    expect(view.bytes.byteLength).toBe(1048576);
    expect(view.truncated).toBe(true);
    expect(view.size).toBe(2097152n);
    expect(view.version).toEqual({ size: "2097152", mtimeNs: expect.any(String) });
  });

  it("does not mark a file that fits in the window as truncated", async () => {
    const provider = new FakeProvider("local");
    provider.put(path("short.txt"), text("hello"));

    const view = await readForView(provider, path("short.txt"), { offset: 0n, length: 4096 }, signal());

    expect(view.kind).toBe("text");
    expect(view.bytes.byteLength).toBe(5);
    expect(view.truncated).toBe(false);
  });

  it("fails with changed_since_plan when the file changes between stat and read", async () => {
    const provider = new FakeProvider("local");
    provider.put(path("moving.txt"), text("first version"));
    const racing: FileProvider = Object.assign(Object.create(provider) as FileProvider, {
      stat: async (target: Parameters<FileProvider["stat"]>[0], s: AbortSignal) => {
        const entry = await provider.stat(target, s);
        provider.put(path("moving.txt"), text("second, longer version"));
        return entry;
      },
    });

    await expect(readForView(racing, path("moving.txt"), { offset: 0n, length: 4096 }, signal()))
      .rejects.toMatchObject({ code: "changed_since_plan" });
  });

  it("fails with changed_since_plan when the file changes after the read (final stat)", async () => {
    const provider = new FakeProvider("local");
    provider.put(path("late.txt"), text("first version"));
    const racing: FileProvider = Object.assign(Object.create(provider) as FileProvider, {
      read: async (target: Parameters<FileProvider["read"]>[0], offset: bigint, length: number, expect: Parameters<FileProvider["read"]>[3], s: AbortSignal) => {
        const bytes = await provider.read(target, offset, length, expect, s);
        provider.put(path("late.txt"), text("second, longer version"));
        return bytes;
      },
    });

    await expect(readForView(racing, path("late.txt"), { offset: 0n, length: 4096 }, signal()))
      .rejects.toMatchObject({ code: "changed_since_plan" });
  });

  it("fails a later window whose version is no longer the first window's version", async () => {
    const provider = new FakeProvider("local");
    provider.put(path("parts.txt"), text("0123456789"));
    const first = await readForView(provider, path("parts.txt"), { offset: 0n, length: 4, expect: undefined }, signal());
    provider.put(path("parts.txt"), text("0123456789ABCDEF"));

    await expect(readForView(provider, path("parts.txt"), { offset: 4n, length: 4, expect: first.version }, signal()))
      .rejects.toMatchObject({ code: "changed_since_plan" });
  });
});

describe("replies for the owner and the agent", () => {
  it("offers text and binary for a text file, and the agent gets the same modes", () => {
    const view = window({ kind: "text", text: true, bytes: text("hi") });

    expect(replyFor(view, "auto", "owner").modes).toEqual(["text", "binary"]);
    expect(replyFor(view, "auto", "agent").modes).toEqual(["text", "binary"]);
    expect(fromWire(replyFor(view, "auto", "owner")).model).toEqual({ kind: "text", text: "hi", truncated: false });
  });

  it("offers text for an SVG source and image for the owner, while the agent gets text and hex only", () => {
    const svg = text("<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
    const view = window({ kind: "image", mime: "image/svg+xml", text: true, bytes: svg });

    expect(replyFor(view, "auto", "owner").modes).toEqual(["text", "image", "binary"]);
    expect(replyFor(view, "auto", "agent").modes).toEqual(["text", "binary"]);
  });

  it("gives the agent hex for a PNG, never image bytes", () => {
    const view = window({ kind: "image", mime: "image/png", bytes: PNG_HEAD });

    const reply = replyFor(view, "image", "agent");

    expect(reply.modes).toEqual(["binary"]);
    expect(reply.view).toEqual({
      kind: "binary", lines: hexLines(PNG_HEAD, 0n), truncated: false, shown: 16, total: "16",
    });
  });

  it("gives the owner a PNG as base64 under image/png, offering hex too", () => {
    const view = window({ kind: "image", mime: "image/png", bytes: PNG_HEAD });

    expect(replyFor(view, "auto", "owner")).toEqual({
      version: { size: "16", mtimeNs: "1" },
      modes: ["image", "binary"],
      view: { kind: "image", mime: "image/png", base64: "iVBORw0KGgoAAAANSUhEUg==", truncated: false },
    });
  });

  it("cuts 2 MiB of ASCII so the owner's JSON reply is at most 1048576 bytes and truncated", () => {
    const view = window({ kind: "text", text: true, bytes: new Uint8Array(MAX_VIEW_BYTES).fill(0x41), size: 2n * 1024n * 1024n, truncated: true });

    const reply = replyFor(view, "text", "owner");

    expect(responseBytes(reply, "owner")).toBeLessThanOrEqual(1048576);
    expect(reply.view).toMatchObject({ kind: "text", truncated: true });
  });

  it("measures the agent's tool result with the escaped text, and keeps it within 1 MiB", () => {
    const bytes = new Uint8Array(2 * 1024 * 1024).fill(0x22);
    const view = window({ kind: "text", text: true, bytes: bytes.subarray(0, MAX_VIEW_BYTES), size: 2n * 1024n * 1024n, truncated: true });

    const reply = replyFor(view, "auto", "agent");

    expect(MAX_RESPONSE_BYTES).toBe(1048576);
    expect(responseBytes(reply, "agent")).toBeLessThanOrEqual(1048576);
    expect(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(reply) }] }).length).toBeLessThanOrEqual(1048576);
  });

  it("shows 600 KiB of 0x01 bytes as binary with the shown and total counts", () => {
    const bytes = new Uint8Array(600 * 1024).fill(0x01);
    const view = window({ kind: "binary", text: false, bytes: bytes.subarray(0, MAX_VIEW_BYTES) });

    const reply = replyFor(view, "auto", "agent");

    expect(reply.modes).toEqual(["binary"]);
    // Hex with the ASCII column is several times the size of the bytes, so the reply is cut.
    expect(reply.view).toMatchObject({ kind: "binary", truncated: true, total: "614400" });
    expect(reply.view.kind === "binary" && reply.view.shown).toBeLessThan(614400);
    expect(responseBytes(reply, "agent")).toBeLessThanOrEqual(1048576);
  });

  it("offers no image above 32 MiB", () => {
    const view = window({ kind: "image", mime: "image/png", bytes: PNG_HEAD, size: BigInt(MAX_IMAGE_BYTES) + 1n, truncated: true });

    expect(replyFor(view, "auto", "owner").modes).toEqual(["binary"]);
  });
});

describe("owner image assembly", () => {
  const PNG_3MIB = (() => {
    const bytes = new Uint8Array(3 * 1024 * 1024);
    bytes.set(PNG_HEAD, 0);
    for (let index = PNG_HEAD.length; index < bytes.length; index++) bytes[index] = index % 251;
    return bytes;
  })();

  it("joins a 3 MiB PNG from chunks with one version and returns the same bytes", async () => {
    const provider = new FakeProvider("local");
    provider.put(path("big.png"), PNG_3MIB);
    const fetchChunk = async (offset: bigint, expect: { size: string; mtimeNs: string | null }) => {
      const view = await readForView(provider, path("big.png"), { offset, length: MAX_VIEW_BYTES, expect }, signal());
      return replyFor(view, "image", "owner");
    };
    const first = replyFor(await readForView(provider, path("big.png"), { offset: 0n, length: MAX_VIEW_BYTES }, signal()), "image", "owner");

    const result = await assembleImage(first, fetchChunk);

    expect(result.model.kind).toBe("image");
    expect(result.model.kind === "image" && result.model.mime).toBe("image/png");
    expect(result.model.kind === "image" && result.model.bytes.byteLength).toBe(3145728);
    expect(result.model.kind === "image" && Buffer.from(result.model.bytes).equals(Buffer.from(PNG_3MIB))).toBe(true);
  });

  it("fails with changed_since_plan when the file changes between chunks", async () => {
    const provider = new FakeProvider("local");
    provider.put(path("moving.png"), PNG_3MIB);
    const first = replyFor(await readForView(provider, path("moving.png"), { offset: 0n, length: MAX_VIEW_BYTES }, signal()), "image", "owner");
    provider.put(path("moving.png"), PNG_3MIB.subarray(0, 2 * 1024 * 1024));

    const fetchChunk = async (offset: bigint, expect: { size: string; mtimeNs: string | null }) =>
      replyFor(await readForView(provider, path("moving.png"), { offset, length: MAX_VIEW_BYTES, expect }, signal()), "image", "owner");

    await expect(assembleImage(first, fetchChunk)).rejects.toMatchObject({ code: "changed_since_plan" });
  });

  it("returns a whole small image without chunks", async () => {
    const provider = new FakeProvider("local");
    provider.put(path("small.png"), PNG_HEAD);
    const first = replyFor(await readForView(provider, path("small.png"), { offset: 0n, length: MAX_VIEW_BYTES }, signal()), "image", "owner");

    const result = await assembleImage(first, async () => { throw new Error("no chunk expected"); });

    expect(result.model).toEqual({ kind: "image", mime: "image/png", bytes: PNG_HEAD, truncated: false });
  });
});

describe("wire form", () => {
  it("round-trips a reply through fromWire", () => {
    const view = window({ kind: "image", mime: "image/png", bytes: PNG_HEAD });
    const reply: WireView = replyFor(view, "auto", "owner");

    expect(fromWire(reply)).toEqual({
      model: { kind: "image", mime: "image/png", bytes: PNG_HEAD, truncated: false },
      modes: ["image", "binary"],
      version: { size: "16", mtimeNs: "1" },
    });
  });
});

describe("owner chunk size", () => {
  // A chunk of a file: `bytes` from `offset` of a `size`-byte file, mtimeNs "111".
  const chunkAt = (size: number, offset: number, bytes: number) => window({
    kind: "image", mime: "image/png", bytes: new Uint8Array(bytes).fill(0x41), offset: BigInt(offset),
    size: BigInt(size), truncated: offset + bytes < size, version: { size: String(size), mtimeNs: "111" },
  });

  it("keeps the whole owner reply within 1 MiB for a chunk from offset 786 327 of a 1 572 657-byte file", () => {
    const reply = replyFor(chunkAt(1572657, 786327, 786330), "image", "owner");

    expect(reply.view).toMatchObject({ kind: "chunk", offset: "786327" });
    expect(responseBytes(reply, "owner")).toBeLessThanOrEqual(1048576);
  });

  it("keeps a final chunk within 1 MiB when its remainder is one character longer than the fitted length", () => {
    // Remainder 786 328 bytes, one longer than the chunk that fits (786 327): taken whole, the reply
    // would be 1 048 577 bytes with truncated: false.
    const reply = replyFor(chunkAt(1572655, 786327, 786328), "image", "owner");

    expect(reply.view).toMatchObject({ kind: "chunk", truncated: true });
    expect(responseBytes(reply, "owner")).toBeLessThanOrEqual(1048576);
  });
});

describe("owner image assembly checks", () => {
  const png = (bytes: number) => {
    const data = new Uint8Array(bytes);
    data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    return data;
  };

  it("refuses a chunk that does not start where it was requested", async () => {
    const first = replyFor(window({ kind: "image", mime: "image/png", bytes: png(MAX_VIEW_BYTES), size: 3145728n, truncated: true, version: version("3145728") }), "image", "owner");
    // The second request is for the end of the first chunk; the reply repeats offset 0.
    await expect(assembleImage(first, async () => first)).rejects.toMatchObject({ code: "internal" });
  });

  it("refuses chunks that do not add up to the file size", async () => {
    const short: WireView = {
      version: version("1000"), modes: ["image", "binary"],
      view: { kind: "chunk", offset: "0", base64: Buffer.from(png(1024)).toString("base64"), truncated: false },
    };

    await expect(assembleImage(short, async () => { throw new Error("no second chunk expected"); }))
      .rejects.toMatchObject({ code: "internal" });
  });
});
