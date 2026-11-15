import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ATTACHMENT_CAP_BYTES } from "../../core/index.ts";
import { FixedClock } from "../../core/testing/fakes.ts";
import {
  UPLOADS_MAX,
  UPLOAD_CHUNK_MAX_BYTES,
  UPLOAD_IDLE_MS,
  UPLOAD_TOTAL_MAX_BYTES,
  UploadBook,
  UploadError,
} from "./uploads.ts";

const T0 = new Date("2026-11-15T10:00:00.000Z");
const MB = 1024 * 1024;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const meta = (size: number) => ({ fileName: "plan.pdf", mimeType: "application/pdf", size });

function book() {
  const clock = new FixedClock(T0);
  let n = 0;
  return { clock, uploads: new UploadBook(clock, () => `up${++n}`) };
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(UploadError);
    return (error as UploadError).code;
  }
  throw new Error("expected an UploadError");
}

describe("UploadBook", () => {
  it("takes sequential chunks and returns the file when the SHA-256 matches", () => {
    const { uploads } = book();
    const bytes = new Uint8Array(1000).map((_, i) => i % 251);
    const id = uploads.begin("d1", meta(1000), ATTACHMENT_CAP_BYTES);
    expect(uploads.chunk(id, 0, bytes.slice(0, 600))).toBe(600);
    expect(uploads.chunk(id, 600, bytes.slice(600))).toBe(1000);
    const file = uploads.finish(id, sha(bytes));
    expect(file).toMatchObject({ draftId: "d1", fileName: "plan.pdf", mimeType: "application/pdf", size: 1000 });
    expect(file.data).toEqual(bytes);
    expect(file.sha256).toBe(sha(bytes));
    expect(code(() => uploads.finish(id, sha(bytes)))).toBe("not_found");
  });

  it("an empty file needs no chunk", () => {
    const { uploads } = book();
    const id = uploads.begin("d1", meta(0), ATTACHMENT_CAP_BYTES);
    expect(uploads.finish(id, sha(new Uint8Array())).size).toBe(0);
  });

  it.each([
    ["a gap", 5],
    ["an overlap", 0],
  ])("refuses %s and drops the upload", (_label, offset) => {
    const { uploads } = book();
    const id = uploads.begin("d1", meta(10), ATTACHMENT_CAP_BYTES);
    uploads.chunk(id, 0, new Uint8Array(3));
    expect(code(() => uploads.chunk(id, offset, new Uint8Array(3)))).toBe("invalid");
    expect(code(() => uploads.chunk(id, 3, new Uint8Array(3)))).toBe("not_found");
  });

  it("refuses a chunk over 512 KiB and bytes past the declared size", () => {
    const { uploads } = book();
    const big = uploads.begin("d1", meta(2 * MB), ATTACHMENT_CAP_BYTES);
    expect(code(() => uploads.chunk(big, 0, new Uint8Array(UPLOAD_CHUNK_MAX_BYTES + 1)))).toBe("invalid");
    const small = uploads.begin("d1", meta(4), ATTACHMENT_CAP_BYTES);
    expect(code(() => uploads.chunk(small, 0, new Uint8Array(5)))).toBe("invalid");
  });

  it("refuses finishing early and a SHA mismatch", () => {
    const { uploads } = book();
    const early = uploads.begin("d1", meta(4), ATTACHMENT_CAP_BYTES);
    uploads.chunk(early, 0, new Uint8Array(2));
    expect(code(() => uploads.finish(early, sha(new Uint8Array(2))))).toBe("invalid");
    const wrong = uploads.begin("d1", meta(2), ATTACHMENT_CAP_BYTES);
    uploads.chunk(wrong, 0, new Uint8Array([1, 2]));
    expect(code(() => uploads.finish(wrong, sha(new Uint8Array([2, 1]))))).toBe("invalid");
    expect(uploads.usage().uploads).toBe(0);
  });

  it("checks the per-file cap and the draft's room, other open uploads included", () => {
    const { uploads } = book();
    expect(code(() => uploads.begin("d1", meta(ATTACHMENT_CAP_BYTES + 1), ATTACHMENT_CAP_BYTES * 2))).toBe("too_large");
    expect(code(() => uploads.begin("d1", meta(10 * MB), 5 * MB))).toBe("too_large");
    uploads.begin("d1", meta(15 * MB), ATTACHMENT_CAP_BYTES);
    expect(code(() => uploads.begin("d1", meta(11 * MB), ATTACHMENT_CAP_BYTES))).toBe("too_large");
    expect(() => uploads.begin("d2", meta(11 * MB), ATTACHMENT_CAP_BYTES)).not.toThrow();
  });

  it("bounds the count and the reserved bytes", () => {
    const { uploads } = book();
    for (let i = 0; i < UPLOADS_MAX; i++) uploads.begin(`d${i}`, meta(1), ATTACHMENT_CAP_BYTES);
    expect(code(() => uploads.begin("dx", meta(1), ATTACHMENT_CAP_BYTES))).toBe("busy");

    const other = book().uploads;
    other.begin("a", meta(25 * MB), ATTACHMENT_CAP_BYTES);
    other.begin("b", meta(25 * MB), ATTACHMENT_CAP_BYTES);
    expect(code(() => other.begin("c", meta(UPLOAD_TOTAL_MAX_BYTES - 50 * MB + 1), ATTACHMENT_CAP_BYTES))).toBe(
      "busy",
    );
    expect(other.usage()).toEqual({ uploads: 2, reservedBytes: 50 * MB });
  });

  it("forgets an upload idle for 5 minutes; activity keeps it", () => {
    const { uploads, clock } = book();
    const active = uploads.begin("d1", meta(4), ATTACHMENT_CAP_BYTES);
    const idle = uploads.begin("d2", meta(4), ATTACHMENT_CAP_BYTES);
    clock.set(new Date(T0.getTime() + UPLOAD_IDLE_MS - 1));
    uploads.chunk(active, 0, new Uint8Array(2));
    clock.set(new Date(T0.getTime() + UPLOAD_IDLE_MS));
    expect(code(() => uploads.chunk(idle, 0, new Uint8Array(2)))).toBe("not_found");
    expect(uploads.chunk(active, 2, new Uint8Array(2))).toBe(4);
  });

  it("dropDraft removes only that draft's uploads", () => {
    const { uploads } = book();
    const a = uploads.begin("d1", meta(1), ATTACHMENT_CAP_BYTES);
    const b = uploads.begin("d2", meta(1), ATTACHMENT_CAP_BYTES);
    uploads.dropDraft("d1");
    expect(code(() => uploads.chunk(a, 0, new Uint8Array(1)))).toBe("not_found");
    expect(uploads.chunk(b, 0, new Uint8Array(1))).toBe(1);
  });

  it("error texts never carry the file name", () => {
    for (const c of ["not_found", "invalid", "too_large", "busy"] as const) {
      expect(new UploadError(c).message).not.toContain("plan.pdf");
    }
  });
});
