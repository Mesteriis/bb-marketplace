// Attachments of a draft: the file picker, a chip per file (name, size,
// remove) and the upload over the owner-only RPC: strictly sequential base64
// chunks of at most UPLOAD_CHUNK_BYTES, then the SHA-256 the server checks.
import { useRef } from "react";
import type { ComposeAttachment } from "../core/model.ts";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/**
 * Largest decoded chunk the server takes (core contract UPLOAD_CHUNK_BYTES).
 * Repeated here because a value import of the contract would bundle zod;
 * a test checks the two agree.
 */
export const CHUNK_BYTES = 512 * 1024;

/** The upload RPCs, injected. */
export interface UploadPort {
  begin(input: { draftId: string; fileName: string; mimeType: string; size: number }): Promise<{ uploadId: string }>;
  chunk(input: { uploadId: string; offset: number; dataBase64: string }): Promise<unknown>;
  finish(input: { uploadId: string; sha256: string }): Promise<ComposeAttachment>;
}

/** Base64 of bytes, in slices so a large chunk does not overflow the call stack. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Lowercase hex SHA-256 through Web Crypto. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function bytesOf(file: Blob): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === "function") return new Uint8Array(await file.arrayBuffer());
  return new Uint8Array(
    await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error ?? new Error("The file could not be read"));
      reader.readAsArrayBuffer(file);
    }),
  );
}

/**
 * Uploads one file to the draft and resolves with the server's record (its
 * sanitized name and type are the ones to show). `onProgress` gets the bytes
 * sent so far.
 */
export async function uploadFile(
  port: UploadPort,
  draftId: string,
  file: File,
  onProgress?: (sent: number, total: number) => void,
): Promise<ComposeAttachment> {
  const bytes = await bytesOf(file);
  const { uploadId } = await port.begin({
    draftId,
    fileName: file.name.trim() === "" ? "attachment" : file.name.slice(0, 255),
    mimeType: file.type === "" ? "application/octet-stream" : file.type.slice(0, 127),
    size: bytes.length,
  });
  for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
    const slice = bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.length));
    await port.chunk({ uploadId, offset, dataBase64: toBase64(slice) });
    onProgress?.(offset + slice.length, bytes.length);
  }
  return port.finish({ uploadId, sha256: await sha256Hex(bytes) });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A file on its way up, or one that failed. */
export interface PendingUpload {
  key: string;
  fileName: string;
  size: number;
  sent: number;
  error: string | null;
}

/** Where a BB file came from (slice 3g): "from a BB project" or "from a BB thread"; null for uploads. */
export function originLabel(origin: string | null | undefined): string | null {
  if (origin === null || origin === undefined) return null;
  if (origin.startsWith("bb:project:")) return "from a BB project";
  if (origin.startsWith("bb:thread:")) return "from a BB thread";
  return "from BB";
}

export interface AttachmentsInputProps {
  attachments: readonly ComposeAttachment[];
  uploads: readonly PendingUpload[];
  onAdd: (files: File[]) => void;
  onRemove: (attachmentId: string) => void;
  onDismissUpload: (key: string) => void;
  disabled?: boolean;
}

/** The "Attach files" button; the chips render in AttachmentChips. */
export function AttachButton({ onAdd, disabled }: Pick<AttachmentsInputProps, "onAdd" | "disabled">) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        aria-hidden
        tabIndex={-1}
        data-testid="compose-file-input"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length > 0) onAdd(files);
        }}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8"
        aria-label="Attach files"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        <Icon name="Paperclip" aria-hidden />
      </Button>
    </>
  );
}

export function AttachmentChips({
  attachments,
  uploads,
  onRemove,
  onDismissUpload,
}: Omit<AttachmentsInputProps, "onAdd">) {
  if (attachments.length === 0 && uploads.length === 0) return null;
  return (
    <ul aria-label="Attachments" className="flex flex-wrap gap-2 px-3 py-2">
      {attachments.map((attachment) => (
        <li
          key={attachment.id}
          className="flex h-7 max-w-72 items-center gap-1.5 rounded-md border border-border pl-2 text-xs text-muted-foreground"
        >
          <Icon name="Paperclip" className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 truncate text-foreground">{attachment.fileName}</span>
          {originLabel(attachment.origin) !== null ? <span className="shrink-0">{originLabel(attachment.origin)}</span> : null}
          <span className="shrink-0">{formatBytes(attachment.size)}</span>
          <button
            type="button"
            aria-label={`Remove ${attachment.fileName}`}
            onClick={() => onRemove(attachment.id)}
            className="flex size-6 shrink-0 items-center justify-center rounded-sm hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Icon name="X" fallback="Plus" className="size-3" aria-hidden />
          </button>
        </li>
      ))}
      {uploads.map((upload) => (
        <li
          key={upload.key}
          className={cn(
            "flex h-7 max-w-72 items-center gap-1.5 rounded-md border pl-2 text-xs",
            upload.error === null ? "border-dashed border-border text-muted-foreground" : "border-destructive/60 text-destructive",
            upload.error === null ? "pr-2" : "",
          )}
        >
          <span className="min-w-0 truncate">{upload.fileName}</span>
          {upload.error === null ? (
            <span className="shrink-0" role="status">
              {upload.size === 0 ? "Uploading…" : `${Math.floor((upload.sent / upload.size) * 100)}%`}
            </span>
          ) : (
            <>
              <span className="shrink-0" role="alert">
                {upload.error}
              </span>
              <button
                type="button"
                aria-label={`Dismiss ${upload.fileName}`}
                onClick={() => onDismissUpload(upload.key)}
                className="flex size-6 shrink-0 items-center justify-center rounded-sm hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <Icon name="X" fallback="Plus" className="size-3" aria-hidden />
              </button>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
