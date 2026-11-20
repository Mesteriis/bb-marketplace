import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useRef, useState } from "react";
import { privateCallVideo } from "../core/contract.ts";

const frameInterval = 1000 / privateCallVideo.frameRate;

async function encodeCameraFrame(frame: Blob) {
  const bytes = new Uint8Array(await frame.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return JSON.stringify({ jpeg: btoa(binary) });
}

export function CallVideo({ route, ticket }: { route: string; ticket: string }) {
  const { t: tr } = useTelegramLocale();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hasFrame, setHasFrame] = useState(false);

  useEffect(() => {
    const abort = new AbortController();
    const params = new URLSearchParams({ ticket });
    let timer: ReturnType<typeof setTimeout>;
    let received = false;
    setHasFrame(false);

    function empty() {
      params.delete("after");
      if (received) {
        received = false;
        setHasFrame(false);
      }
    }

    async function refresh() {
      const nextPoll = performance.now() + frameInterval;
      try {
        const result = await fetch(`${route}?${params}`, { cache: "no-store", referrerPolicy: "no-referrer", signal: abort.signal });
        if (abort.signal.aborted) return;
        const sequence = result.headers.get("x-frame-sequence");
        if (result.status === 204 && sequence) return;
        if (result.status !== 200 || !sequence || result.headers.get("content-type") !== "image/jpeg") {
          empty();
          return;
        }
        const bitmap = await createImageBitmap(await result.blob());
        try {
          const target = canvas.current;
          if (abort.signal.aborted || !target) return;
          if (target.width !== bitmap.width || target.height !== bitmap.height) {
            target.width = bitmap.width;
            target.height = bitmap.height;
          }
          target.getContext("2d")?.drawImage(bitmap, 0, 0);
        } finally { bitmap.close(); }
        if (abort.signal.aborted) return;
        params.set("after", sequence);
        if (!received) {
          received = true;
          setHasFrame(true);
        }
      } catch {
        if (!abort.signal.aborted) empty();
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(() => void refresh(), Math.max(0, nextPoll - performance.now()));
      }
    }
    void refresh();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [route, ticket]);

  return <div className="mtg-call-camera mtg-call-remote">
    <canvas ref={canvas} aria-label={tr("Remote camera")} role="img" hidden={!hasFrame} data-call-frame="remote" />
    {!hasFrame && <span>{tr("Waiting for remote video…")}</span>}
  </div>;
}

export function LocalCallCamera({ route, ticket }: { route: string; ticket: string }) {
  const { t: tr } = useTelegramLocale();
  const preview = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<"starting" | "preview" | "sending" | "permission" | "failed" | "delivery">("starting");

  useEffect(() => {
    const abort = new AbortController();
    const video = preview.current;
    const address = `${route}?${new URLSearchParams({ ticket })}`;
    let stream: MediaStream | undefined;
    let timer: ReturnType<typeof setTimeout>;
    setStatus("starting");
    if (!video) return;

    async function capture(target: HTMLVideoElement) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
          width: { ideal: privateCallVideo.width }, height: { ideal: privateCallVideo.height },
          frameRate: { ideal: privateCallVideo.frameRate, max: 30 }, facingMode: "user",
        } });
        if (abort.signal.aborted) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        target.srcObject = stream;
        setStatus("preview");
        await target.play();
      } catch (error) {
        if (!abort.signal.aborted) {
          const permission = error instanceof DOMException && ["NotAllowedError", "SecurityError"].includes(error.name);
          setStatus(permission ? "permission" : "failed");
          stream?.getTracks().forEach((track) => track.stop());
        }
        return;
      }
      if (abort.signal.aborted) return;
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) {
        stream.getTracks().forEach((track) => track.stop());
        setStatus("failed");
        return;
      }
      let errors = 0;
      let lastFrame = -1;
      async function sendFrame() {
        const nextPoll = performance.now() + (errors ? 200 : frameInterval);
        try {
          if (!context || target.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || lastFrame === target.currentTime) return;
          lastFrame = target.currentTime;
          const scale = Math.min(1, privateCallVideo.width / target.videoWidth, privateCallVideo.height / target.videoHeight);
          const width = 2 * Math.floor(scale * target.videoWidth / 2);
          const height = 2 * Math.floor(scale * target.videoHeight / 2);
          if (width < 2 || height < 2) return;
          if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
          }
          context.drawImage(target, 0, 0, width, height);
          let frame = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.86));
          if (frame && frame.size > privateCallVideo.maxJpegBytes) {
            frame = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.72));
          }
          if (frame && frame.size > privateCallVideo.maxJpegBytes) return;
          if (!frame || abort.signal.aborted) return;
          const result = await fetch(address, { method: "POST", body: await encodeCameraFrame(frame), cache: "no-store",
            headers: { "content-type": "application/json" },
            referrerPolicy: "no-referrer", signal: abort.signal });
          if (!result.ok) throw new Error("Camera frame was rejected.");
          errors = 0;
          if (!abort.signal.aborted) setStatus("sending");
        } catch {
          if (!abort.signal.aborted && ++errors >= 3) {
            stream?.getTracks().forEach((track) => track.stop());
            setStatus("delivery");
          }
        } finally {
          if (!abort.signal.aborted && errors < 3) timer = setTimeout(() => void sendFrame(), Math.max(0, nextPoll - performance.now()));
        }
      }
      void sendFrame();
    }
    void capture(video);
    return () => {
      abort.abort();
      clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
      video.srcObject = null;
    };
  }, [route, ticket]);

  return <div className="mtg-call-camera mtg-call-self" data-camera-status={status}>
    <video ref={preview} aria-label={tr("Your camera")} autoPlay playsInline muted
      hidden={status !== "preview" && status !== "sending"} data-call-frame="local" />
    {status !== "preview" && status !== "sending" && <span role="status">{status === "permission" ? tr("Allow camera access in BB")
      : status === "failed" ? tr("Camera could not start") : status === "delivery" ? tr("Video could not be sent") : tr("Starting camera…")}</span>}
  </div>;
}
