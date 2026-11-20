import type { ZodType } from "zod";
import { documentDeliveryTimeoutMs, pollUploadResult, quickReplyDocumentResult, schemas, telegramUploadProgress, type DocumentSender, type TelegramUploadProgress } from "../../core/contract.ts";

type UploadProgress = Parameters<DocumentSender>[3];
type Cancellation = { signal: AbortSignal; request: () => Promise<boolean> };

export function waitForDocumentDelivery(url: string, onProgress?: (progress: TelegramUploadProgress | undefined, canCancel: boolean) => void, cancel?: Cancellation) {
  return waitForDelivery(schemas.sendDocument.output, url, onProgress, cancel);
}

async function waitForDelivery<Result extends { state: string }>(schema: ZodType<Result>, url: string,
  onProgress?: (progress: TelegramUploadProgress | undefined, canCancel: boolean) => void, cancel?: Cancellation,
): Promise<Result | { state: "cancelled" | "unknown" }> {
  const deadline = Date.now() + documentDeliveryTimeoutMs + 45_000;
  let failures = 0;
  let cancellationTried = false;
  while (Date.now() < deadline) {
    try {
      if (cancel?.signal.aborted && !cancellationTried) {
        cancellationTried = true;
        if (await cancel.request()) return { state: "cancelled" };
      }
      const response = await fetch(url, {
        credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        const state: unknown = await response.json();
        const result = schema.safeParse(state);
        if (result.success) return result.data;
        if (!state || typeof state !== "object" || !("state" in state) || state.state !== "pending") break;
        const progress = telegramUploadProgress.safeParse("progress" in state ? state.progress : undefined);
        onProgress?.(progress.success ? progress.data : undefined, !cancellationTried && "canCancel" in state && state.canCancel === true);
        failures = 0;
      } else {
        if (response.status !== 408 && response.status !== 429 && response.status < 500) break;
        failures++;
      }
    } catch {
      failures++;
    }
    if (failures >= 5) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 2000));
  }
  return { state: "unknown" };
}

export function uploadDocument(url: string, file: Blob, progress: UploadProgress, signal: AbortSignal) {
  return uploadFile(schemas.sendDocument.output, url, file, progress, signal);
}

export function uploadPollFiles(url: string, file: Blob, progress: UploadProgress, signal: AbortSignal) {
  return uploadFile(pollUploadResult, url, file, progress, signal);
}

export function uploadQuickReplyDocument(url: string, file: Blob, progress: UploadProgress, signal: AbortSignal) {
  return uploadFile(quickReplyDocumentResult, url, file, progress, signal);
}

async function uploadFile<Result extends { state: string }>(schema: ZodType<Result>, url: string, file: Blob, progress: UploadProgress,
  signal: AbortSignal): Promise<Result | { state: "cancelled" | "unknown" }> {
  async function requestCancellation() {
    const response = await fetch(url, {
      method: "DELETE", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    return response.ok && (await response.json()).cancelled === true;
  }
  async function cancelUpload() {
    return await requestCancellation().catch(() => false)
      ? { state: "cancelled" as const } : { state: "unknown" as const };
  }
  for (let offset = 0; offset < file.size;) {
    if (signal.aborted) return cancelUpload();
    const slice = file.slice(offset, offset + 512 * 1024);
    const bytes = new Uint8Array(await slice.arrayBuffer());
    let binary = "";
    for (let start = 0; start < bytes.length; start += 8192) {
      binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
    }
    const body = JSON.stringify({ offset, base64: btoa(binary) });
    const finalChunk = offset + slice.size === file.size;
    if (signal.aborted) return cancelUpload();
    if (finalChunk) progress(offset, false);
    const post = async () => {
      const response = await fetch(url, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body,
      });
      return { ok: response.ok, payload: await response.json() };
    };
    let reply = await post().catch(() => undefined);
    if (!reply || reply.payload?.retry === true) {
      await new Promise((resolve) => setTimeout(resolve, 350));
      if (signal.aborted && !finalChunk) return cancelUpload();
      reply = await post().catch(() => undefined);
    }
    if (!reply) return { state: "unknown" as const };
    const { ok, payload } = reply;
    const result = schema.safeParse(payload);
    if (result.success) {
      if (result.data.state === "sent" || result.data.state === "submitted") progress(file.size);
      return result.data;
    }
    offset += slice.size;
    if (!ok || payload?.received !== offset) return { state: "unknown" as const };
    progress(offset, !finalChunk);
  }
  return waitForDelivery(schema, url, (telegram, canCancel) => progress(file.size, canCancel, telegram), { signal, request: requestCancellation });
}
