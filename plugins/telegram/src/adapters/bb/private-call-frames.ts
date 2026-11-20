import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { privateCallVideo } from "../../core/contract.ts";
import type { createPrivateCalls } from "./private-calls.ts";

export const privateCallFrameRoute = "/private-call-frame";
const ticketPattern = /^[A-Za-z0-9_-]{43}$/;
const maxEncodedFrame = Math.ceil(privateCallVideo.maxJpegBytes / 3) * 4;
const maxRequestBytes = maxEncodedFrame + 32;

async function readCameraFrame(request: Request) {
  if (!request.body || !request.headers.get("content-type")?.startsWith("application/json")
    || Number(request.headers.get("content-length")) > maxRequestBytes) return;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxRequestBytes) {
        await reader.cancel();
        return;
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const parsed = JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as { jpeg?: unknown } | null;
  const encoded = parsed?.jpeg;
  if (typeof encoded !== "string" || encoded.length > maxEncodedFrame || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return;
  const jpeg = Buffer.from(encoded, "base64");
  if (jpeg[0] === 255 && jpeg[1] === 216 && jpeg.at(-2) === 255 && jpeg.at(-1) === 217 && jpeg.toString("base64") === encoded) return jpeg;
}

export function registerPrivateCallFrames(bb: { http: Pick<BbPluginApi["http"], "route"> },
  calls: () => ReturnType<typeof createPrivateCalls> | undefined) {
  bb.http.route("GET", privateCallFrameRoute, ({ req }) => {
    const ticket = req.query("ticket");
    const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
    if (!ticket || !ticketPattern.test(ticket)) {
      return new Response(null, { status: 404, headers });
    }
    const frame = calls()?.frame(ticket);
    if (frame === undefined) return new Response(null, { status: 404, headers });
    if (frame === null) return new Response(null, { status: 204, headers });
    if (String(frame.seq) === req.query("after")) {
      return new Response(null, { status: 204, headers: { ...headers, "x-frame-sequence": String(frame.seq) } });
    }
    return new Response(frame.jpeg, { headers: { ...headers, "content-type": "image/jpeg", "x-frame-sequence": String(frame.seq) } });
  }, { auth: "local" });

  bb.http.route("POST", privateCallFrameRoute, async ({ req }) => {
    const ticket = req.query("ticket");
    const current = calls();
    const headers = { "cache-control": "no-store" };
    if (!ticket || !ticketPattern.test(ticket) || !current?.authorizesCamera(ticket)) return new Response(null, { status: 404, headers });
    const jpeg = await readCameraFrame(req.raw).catch(() => undefined);
    if (!jpeg) return new Response(null, { status: 400, headers });
    const active = !req.raw.signal.aborted && calls() === current && await current.uploadCamera(ticket, jpeg);
    return new Response(null, { status: active ? 204 : 409, headers });
  }, { auth: "local" });
}
