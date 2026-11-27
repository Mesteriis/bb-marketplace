import { cleanLog, logTail } from "../../../core/ci/log.ts";
import type { JobLog } from "../../../core/ci/pipelines.ts";

const maxBytes = 2 * 1024 * 1024;

async function tail(response: Response) {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let dropped = false;
  if (reader) {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
      while (size - chunks[0].length >= maxBytes) { size -= chunks.shift()!.length; dropped = true; }
    }
  }
  let bytes = Buffer.concat(chunks);
  if (bytes.length > maxBytes) { bytes = bytes.subarray(bytes.length - maxBytes); dropped = true; }
  return {text: bytes.toString("utf8"), dropped};
}

/**
 * Reads the tail of a job log. A redirect to signed storage (GitHub) is followed once, over HTTPS and without the
 * forge credential. 404 means the forge has not published the log yet.
 */
export async function fetchLog(url: URL, authorization: string, send: typeof fetch): Promise<JobLog> {
  const signal = AbortSignal.timeout(30_000);
  let response = await send(url, {headers: {authorization, accept: "text/plain, */*"}, redirect: "manual", signal});
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    const next = new URL(response.headers.get("location") ?? "", url);
    if (next.protocol !== "https:" || next.username || next.password) throw new Error("PROVIDER_REJECTED");
    response = await send(next, {redirect: "error", signal});
  }
  if (response.status === 404) { await response.body?.cancel(); return null; }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(response.status === 401 || response.status === 403 ? "PROVIDER_DENIED" : "PROVIDER_UNAVAILABLE");
  }
  const {text, dropped} = await tail(response);
  const cleaned = cleanLog(text);
  if (!dropped) return {text: cleaned, truncated: false};
  const cut = logTail(cleaned, cleaned.length - 1);
  return {text: cut.text, truncated: true};
}
