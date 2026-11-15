// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UPLOAD_CHUNK_BYTES } from "../core/contract.ts";
import {
  AttachButton,
  AttachmentChips,
  CHUNK_BYTES,
  formatBytes,
  sha256Hex,
  toBase64,
  uploadFile,
  type UploadPort,
} from "./attachments-input.tsx";

installTestPluginRuntime();
afterEach(cleanup);

function recordingPort() {
  const calls: { method: string; input: Record<string, unknown> }[] = [];
  const port: UploadPort = {
    begin: async (input) => {
      calls.push({ method: "begin", input });
      return { uploadId: "up-1" };
    },
    chunk: async (input) => {
      calls.push({ method: "chunk", input });
      return { received: 0 };
    },
    finish: async (input) => {
      calls.push({ method: "finish", input });
      return { id: "att-1", fileName: "report_.pdf", mimeType: "application/pdf", size: 3 };
    },
  };
  return { port, calls };
}

describe("uploadFile", () => {
  it("uses the server's chunk size", () => {
    expect(CHUNK_BYTES).toBe(UPLOAD_CHUNK_BYTES);
  });

  it("sends strictly sequential base64 chunks of at most 512 KiB, then the SHA-256", async () => {
    const bytes = new Uint8Array(CHUNK_BYTES * 2 + 1000);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 31) % 256;
    const file = new File([bytes], "report.pdf", { type: "application/pdf" });
    const { port, calls } = recordingPort();
    const progress: number[] = [];

    const record = await uploadFile(port, "draft-1", file, (sent) => progress.push(sent));

    expect(calls[0]).toEqual({
      method: "begin",
      input: { draftId: "draft-1", fileName: "report.pdf", mimeType: "application/pdf", size: bytes.length },
    });
    const chunks = calls.filter((c) => c.method === "chunk").map((c) => c.input);
    expect(chunks.map((c) => c.offset)).toEqual([0, CHUNK_BYTES, CHUNK_BYTES * 2]);
    expect(chunks.every((c) => c.uploadId === "up-1")).toBe(true);
    const decoded = Buffer.concat(chunks.map((c) => Buffer.from(c.dataBase64 as string, "base64")));
    expect(decoded.equals(Buffer.from(bytes))).toBe(true);
    expect(chunks.every((c) => Buffer.from(c.dataBase64 as string, "base64").length <= CHUNK_BYTES)).toBe(true);
    expect(calls.at(-1)).toEqual({
      method: "finish",
      input: { uploadId: "up-1", sha256: createHash("sha256").update(bytes).digest("hex") },
    });
    expect(progress).toEqual([CHUNK_BYTES, CHUNK_BYTES * 2, bytes.length]);
    expect(record.fileName).toBe("report_.pdf");
  });

  it("uploads an empty file with no chunk and a generic type", async () => {
    const { port, calls } = recordingPort();
    await uploadFile(port, "draft-1", new File([], "empty"), undefined);
    expect(calls.map((c) => c.method)).toEqual(["begin", "finish"]);
    expect(calls[0]!.input.mimeType).toBe("application/octet-stream");
    expect(calls[1]!.input.sha256).toBe(createHash("sha256").update(Buffer.alloc(0)).digest("hex"));
  });

  it("stops at the first refused chunk", async () => {
    const { port, calls } = recordingPort();
    port.chunk = vi.fn(async () => {
      throw new Error("Upload refused");
    });
    await expect(uploadFile(port, "d", new File([new Uint8Array(10)], "a.bin"))).rejects.toThrow("Upload refused");
    expect(calls.map((c) => c.method)).toEqual(["begin"]);
  });

  it("encodes and hashes like Node", async () => {
    const bytes = new TextEncoder().encode("made-up text ✓");
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    expect(await sha256Hex(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
  });
});

describe("attachment chips", () => {
  it("shows the server's name and size, removes by id, and shows upload state", () => {
    const onRemove = vi.fn();
    const onDismiss = vi.fn();
    render(
      <AttachmentChips
        attachments={[{ id: "att-1", fileName: "plan.pdf", mimeType: "application/pdf", size: 2048 }]}
        uploads={[
          { key: "u1", fileName: "big.zip", size: 100, sent: 50, error: null },
          { key: "u2", fileName: "bad.exe", size: 10, sent: 0, error: "Upload refused" },
        ]}
        onRemove={onRemove}
        onDismissUpload={onDismiss}
      />,
    );
    expect(screen.getByText("plan.pdf")).toBeTruthy();
    expect(screen.getByText("2 KB")).toBeTruthy();
    expect(screen.getByText("50%")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Upload refused");
    fireEvent.click(screen.getByRole("button", { name: "Remove plan.pdf" }));
    expect(onRemove).toHaveBeenCalledWith("att-1");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss bad.exe" }));
    expect(onDismiss).toHaveBeenCalledWith("u2");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });

  it("hands picked files to onAdd", () => {
    const onAdd = vi.fn();
    render(<AttachButton onAdd={onAdd} />);
    const file = new File(["x"], "a.txt", { type: "text/plain" });
    fireEvent.change(screen.getByTestId("compose-file-input"), { target: { files: [file] } });
    expect(onAdd).toHaveBeenCalledWith([file]);
  });
});
