import { useTelegramLocale } from "./i18n/index.tsx";
import { useLayoutEffect, useRef, useState } from "react";
import jsQR from "jsqr";

type QrDetector = {
  detect: (image: HTMLVideoElement) => Promise<{ rawValue: string }[]>;
};
type QrDetectorConstructor = {
  new (options: { formats: string[] }): QrDetector;
  getSupportedFormats: () => Promise<string[]>;
};

async function nativeQrDetector(): Promise<QrDetector | undefined> {
  const Detector = (window as Window & { BarcodeDetector?: QrDetectorConstructor }).BarcodeDetector;
  if (!Detector) return;
  try {
    if ((await Detector.getSupportedFormats()).includes("qr_code")) return new Detector({ formats: ["qr_code"] });
  } catch {
    // Some browsers expose the API without a working platform backend.
  }
}

function localQrReader() {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Local QR recognition is unavailable.");
  return (image: CanvasImageSource, sourceWidth: number, sourceHeight: number) => {
    if (!sourceWidth || !sourceHeight) return [];
    const scale = Math.min(1, 768 / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.drawImage(image, 0, 0, width, height);
    const code = jsQR(context.getImageData(0, 0, width, height).data, width, height);
    return code ? [code.data] : [];
  };
}

function isQrText(value: string) {
  return value.length > 0 && value.length <= 8192;
}

export function MiniAppQrDialog({ label, bot, scanned, close }: {
  label: string;
  bot: string;
  scanned: (text: string) => void;
  close: () => void;
}) {
  const { t: tr } = useTelegramLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const request = useRef<AbortController>(null);
  const imageRequest = useRef<AbortController>(null);
  const [status, setStatus] = useState<"idle" | "requesting" | "scanning">("idle");
  const [imageStatus, setImageStatus] = useState<"reading" | "sent" | "unreadable" | "invalid">();
  const canReadImage = typeof createImageBitmap === "function";

  useLayoutEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
    return () => {
      request.current?.abort();
      imageRequest.current?.abort();
    };
  }, []);

  async function readImage(file: File) {
    if (request.current || imageRequest.current) return;
    if (!/^(image\/png|image\/jpeg|image\/webp)$/.test(file.type) || !file.size || file.size > 16 * 1024 * 1024) {
      setImageStatus("invalid");
      return;
    }
    const controller = new AbortController();
    imageRequest.current = controller;
    setImageStatus("reading");
    let image: ImageBitmap | undefined;
    try {
      image = await createImageBitmap(file);
      if (controller.signal.aborted) return;
      const [value] = localQrReader()(image, image.width, image.height);
      if (value && isQrText(value)) {
        scanned(value);
        setImageStatus("sent");
      } else setImageStatus("unreadable");
    } catch {
      if (!controller.signal.aborted) setImageStatus("unreadable");
    } finally {
      image?.close();
      imageRequest.current = null;
    }
  }

  async function start() {
    const preview = video.current;
    if (request.current || imageRequest.current || !preview) return;
    setImageStatus(undefined);
    setStatus("requesting");
    const controller = new AbortController();
    request.current = controller;
    const { signal } = controller;
    let stream: MediaStream | undefined;
    let timer: number | undefined;
    let last = new Set<string>();
    signal.addEventListener("abort", () => {
      window.clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
      preview.srcObject = null;
    }, { once: true });

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        if (!signal.aborted) close();
        return;
      }
      let detector = await nativeQrDetector();
      if (signal.aborted) return;
      let readLocal = detector ? undefined : localQrReader();
      const camera = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" } } });
      if (signal.aborted) {
        camera.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = camera;
      preview.srcObject = camera;
      await preview.play();
      if (signal.aborted) return;
      setStatus("scanning");

      async function readFrame(frame: HTMLVideoElement) {
        if (detector) {
          try {
            return (await detector.detect(frame)).map(({ rawValue }) => rawValue);
          } catch {
            if (signal.aborted) return [];
            detector = undefined;
            readLocal = localQrReader();
          }
        }
        return readLocal?.(frame, frame.videoWidth, frame.videoHeight) ?? [];
      }

      async function scan() {
        if (signal.aborted) return;
        try {
          if (preview && preview.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
            const codes = await readFrame(preview);
            if (signal.aborted) return;
            const current = new Set(codes.filter(isQrText));
            for (const value of current) {
              if (!last.has(value)) scanned(value);
            }
            last = current;
          }
          timer = window.setTimeout(() => void scan(), 250);
        } catch {
          if (!signal.aborted) close();
        }
      }
      void scan();
    } catch {
      if (!signal.aborted) close();
    }
  }

  return <dialog ref={dialog} className="mtg-mini-app-popup" aria-label={tr("Scan QR code")}
    onCancel={(event) => { event.preventDefault(); event.stopPropagation(); close(); }}>
    <strong>{tr("Scan QR code")}</strong>
    {label && <p><bdi>{label}</bdi></p>}
    <p>{tr("QR codes you scan will be shared with ")}<bdi>{bot}</bdi>.</p>
    <video ref={video} hidden={status !== "scanning"} muted playsInline aria-label={tr("Camera preview")} />
    <div className="mtg-mini-app-popup-buttons">
      {status !== "scanning" && <button disabled={status === "requesting" || imageStatus === "reading"}
        type="button" className="mtg-action" onClick={() => void start()}>{tr("Use camera")}</button>}
      <button type="button" className="mtg-action" onClick={close}>{tr("Close scanner")}</button>
    </div>
    {canReadImage && status === "idle" && <label className="mtg-mini-app-qr-image">{tr("Scan QR from image")}<input type="file" accept="image/png,image/jpeg,image/webp" disabled={imageStatus === "reading"} onChange={(event) => {
        const input = event.currentTarget;
        const file = input.files?.[0];
        input.value = "";
        if (file) void readImage(file);
      }} />
    </label>}
    {imageStatus === "reading" && <p role="status">{tr("Reading QR image…")}</p>}
    {imageStatus === "sent" && <p role="status">{tr("QR text shared.")}</p>}
    {imageStatus === "unreadable" && <p role="status">{tr("No readable QR code found in this image.")}</p>}
    {imageStatus === "invalid" && <p role="alert">{tr("Choose a PNG, JPEG or WebP image up to 16 MiB.")}</p>}
  </dialog>;
}
