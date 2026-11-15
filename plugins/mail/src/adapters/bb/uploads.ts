// Chunked attachment uploads (resolution 20): the page sends a file in
// sequential base64 chunks of at most 512 KiB, then its SHA-256. Uploads live
// in memory only (gone on restart) and are bounded: 16 at a time, 64 MB
// reserved in all (by declared size, so memory never exceeds it), 5 minutes
// idle. The per-file and per-message 25 MB caps are checked at begin against
// the draft's stored attachments and its other open uploads. Nothing here
// logs: names, types and bytes stay with the upload.
import { createHash, randomUUID } from "node:crypto";
import { ATTACHMENT_CAP_BYTES, UPLOAD_CHUNK_BYTES, type Clock } from "../../core/index.ts";

export const UPLOAD_CHUNK_MAX_BYTES = UPLOAD_CHUNK_BYTES;
export const UPLOAD_TOTAL_MAX_BYTES = 64 * 1024 * 1024;
export const UPLOADS_MAX = 16;
export const UPLOAD_IDLE_MS = 5 * 60_000;

export type UploadErrorCode = "not_found" | "invalid" | "too_large" | "busy";

const UPLOAD_ERROR_TEXT: Record<UploadErrorCode, string> = {
  not_found: "This upload is gone; add the file again",
  invalid: "The upload is out of order or damaged; add the file again",
  too_large: "Attachments are over the size limit",
  busy: "Too many uploads at once; try again shortly",
};

/** A refused upload step, with fixed text. */
export class UploadError extends Error {
  constructor(readonly code: UploadErrorCode) {
    super(UPLOAD_ERROR_TEXT[code]);
    this.name = "UploadError";
  }
}

export type FinishedUpload = {
  draftId: string;
  fileName: string;
  mimeType: string;
  size: number;
  sha256: string;
  data: Uint8Array;
};

type Upload = {
  draftId: string;
  fileName: string;
  mimeType: string;
  size: number;
  chunks: Buffer[];
  received: number;
  touchedAt: number;
};

export class UploadBook {
  private readonly uploads = new Map<string, Upload>();

  constructor(
    private readonly clock: Clock,
    private readonly newId: () => string = randomUUID,
  ) {}

  /**
   * Opens an upload of `size` bytes for the draft. `room` is what the draft's
   * stored attachments leave under the per-message cap.
   */
  begin(draftId: string, meta: { fileName: string; mimeType: string; size: number }, room: number): string {
    this.sweep();
    if (!Number.isInteger(meta.size) || meta.size < 0) throw new UploadError("invalid");
    const open = [...this.uploads.values()];
    const pendingForDraft = open.filter((u) => u.draftId === draftId).reduce((sum, u) => sum + u.size, 0);
    if (meta.size > ATTACHMENT_CAP_BYTES || meta.size > room - pendingForDraft) throw new UploadError("too_large");
    const reserved = open.reduce((sum, u) => sum + u.size, 0);
    if (open.length >= UPLOADS_MAX || reserved + meta.size > UPLOAD_TOTAL_MAX_BYTES) throw new UploadError("busy");
    const id = this.newId();
    this.uploads.set(id, {
      draftId,
      fileName: meta.fileName,
      mimeType: meta.mimeType,
      size: meta.size,
      chunks: [],
      received: 0,
      touchedAt: this.now(),
    });
    return id;
  }

  /** Adds the next chunk; `offset` must be exactly what was received so far. Returns the bytes received. */
  chunk(uploadId: string, offset: number, bytes: Uint8Array): number {
    this.sweep();
    const upload = this.uploads.get(uploadId);
    if (upload === undefined) throw new UploadError("not_found");
    if (
      offset !== upload.received ||
      bytes.byteLength > UPLOAD_CHUNK_MAX_BYTES ||
      upload.received + bytes.byteLength > upload.size
    ) {
      this.uploads.delete(uploadId);
      throw new UploadError("invalid");
    }
    upload.chunks.push(Buffer.from(bytes));
    upload.received += bytes.byteLength;
    upload.touchedAt = this.now();
    return upload.received;
  }

  /** Closes the upload: every byte received and the SHA-256 (lowercase hex) matching. */
  finish(uploadId: string, sha256: string): FinishedUpload {
    this.sweep();
    const upload = this.uploads.get(uploadId);
    if (upload === undefined) throw new UploadError("not_found");
    this.uploads.delete(uploadId);
    if (upload.received !== upload.size) throw new UploadError("invalid");
    const data = Buffer.concat(upload.chunks, upload.size);
    const digest = createHash("sha256").update(data).digest("hex");
    if (digest !== sha256) throw new UploadError("invalid");
    return {
      draftId: upload.draftId,
      fileName: upload.fileName,
      mimeType: upload.mimeType,
      size: upload.size,
      sha256: digest,
      data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    };
  }

  /** Drops the draft's open uploads (it was sent or discarded). */
  dropDraft(draftId: string): void {
    for (const [id, upload] of this.uploads) if (upload.draftId === draftId) this.uploads.delete(id);
  }

  /** Open uploads and the bytes they reserve. */
  usage(): { uploads: number; reservedBytes: number } {
    this.sweep();
    const open = [...this.uploads.values()];
    return { uploads: open.length, reservedBytes: open.reduce((sum, u) => sum + u.size, 0) };
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, upload] of this.uploads) {
      if (now - upload.touchedAt >= UPLOAD_IDLE_MS) this.uploads.delete(id);
    }
  }

  private now(): number {
    return this.clock.now().getTime();
  }
}
