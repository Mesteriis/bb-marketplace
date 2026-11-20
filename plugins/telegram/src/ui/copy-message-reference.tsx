import { useTelegramLocale } from "./i18n/index.tsx";
import { useRef, useState, type ReactNode } from "react";
import { Hash } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { downloadBlob } from "./download-blob.ts";

export function CopyMessageReference({ chatId, messageId, forumTopicId }: {
  chatId: string;
  messageId: string;
  forumTopicId?: number;
}) {
  const { t: tr } = useTelegramLocale();
  if (!/^[1-9]\d{0,15}$/.test(messageId)) return null;
  const reference = JSON.stringify({ chatId, ...(forumTopicId === undefined ? {} : { forumTopicId }), messageId });
  return <CopyReference label={tr("Message reference")} value={reference}>#</CopyReference>;
}

export function CopyRecipientReference({ chatId, forumTopicId }: { chatId: string; forumTopicId?: number }) {
  const { t: tr } = useTelegramLocale();
  if (!/^-?[1-9]\d{0,15}$/.test(chatId)) return null;
  const label = forumTopicId === undefined ? tr("Chat reference") : tr("Topic reference");
  const reference = JSON.stringify({ recipientId: chatId, ...(forumTopicId === undefined ? {} : { forumTopicId }) });
  return <CopyReference label={label} value={reference} buttonClass={forumTopicId === undefined ? "mtg-reply-action" : "mtg-action"}>
    {forumTopicId === undefined ? <Hash size={15} aria-hidden="true" /> : tr("Copy {0}", [label.toLowerCase()])}
  </CopyReference>;
}

export function CopyTelegramPublicLink({ name }: { name: string }) {
  const { t: tr } = useTelegramLocale();
  if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) return null;
  const url = `https://t.me/${name}`;
  return <>
    <CopyReference label={tr("Public link for @{0}", [name])} value={url} buttonClass="mtg-action">{tr("Copy link")}</CopyReference>
    <TelegramLinkQr key={url} url={url} label={tr("QR code for @{0}", [name])} imageLabel={tr("Telegram public link QR code for @{0}", [name])}
      filename={`telegram-${name}-qr.png`} />
  </>;
}

const qrColors = { Black: "#111827", Blue: "#174f92", Violet: "#553794", Green: "#155346" } as const;

async function qrPng(svg: SVGSVGElement) {
  const image = new Image();
  image.src = "data:image/svg+xml," + encodeURIComponent(new XMLSerializer().serializeToString(svg));
  await image.decode();
  const canvas = svg.ownerDocument.createElement("canvas");
  canvas.width = canvas.height = 768;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not create a QR image.");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not encode the QR image.")), "image/png");
  });
}

export function TelegramLinkQr({ url, label, imageLabel, filename = "telegram-link-qr.png" }: {
  url: string; label: string; imageLabel: string; filename?: string;
}) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const svg = useRef<SVGSVGElement>(null);
  const [color, setColor] = useState<keyof typeof qrColors>("Black");
  const [status, setStatus] = useState<"working" | "saved" | "copied" | "saveFailed" | "copyFailed">();
  const canCopy = typeof ClipboardItem !== "undefined" && typeof navigator.clipboard?.write === "function";

  async function exportImage(action: "save" | "copy") {
    if (!svg.current || status === "working") return;
    setStatus("working");
    try {
      const image = qrPng(svg.current);
      if (action === "copy") {
        // Start the write in the click handler and let the browser wait for PNG encoding.
        await navigator.clipboard.write([new ClipboardItem({ "image/png": image })]);
        setStatus("copied");
      } else {
        downloadBlob(await image, filename);
        setStatus("saved");
      }
    } catch {
      setStatus(action === "copy" ? "copyFailed" : "saveFailed");
    }
  }

  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary aria-label={label}>{tr("QR code")}</summary>
    {open && <div className="mtg-link-qr">
      <QRCodeSVG ref={svg} value={url} size={192} level="M" marginSize={4} fgColor={qrColors[color]} role="img" aria-label={imageLabel} />
      <div className="mtg-link-qr-controls">
        <label>{tr("QR color ")}<select value={color} onChange={(event) => {
          const value = event.currentTarget.value;
          if (Object.prototype.hasOwnProperty.call(qrColors, value)) setColor(value as keyof typeof qrColors);
          setStatus(undefined);
        }} disabled={status === "working"}>
          {Object.keys(qrColors).map((name) => <option key={name}>{name}</option>)}
        </select></label>
        <button type="button" className="mtg-action" disabled={status === "working"} onClick={() => void exportImage("save")}>{tr("Save QR as PNG")}</button>
        {canCopy && <button type="button" className="mtg-action" disabled={status === "working"} onClick={() => void exportImage("copy")}>{tr("Copy QR image")}</button>}
      </div>
      {status === "saved" && <span role="status">{tr("QR download started.")}</span>}
      {status === "copied" && <span role="status">{tr("QR image copied.")}</span>}
      {status === "saveFailed" && <span role="alert">{tr("Could not save the QR image.")}</span>}
      {status === "copyFailed" && <span role="alert">{tr("Could not copy the QR image.")}</span>}
    </div>}
  </details>;
}

export function CopyReference({ label, value, buttonClass = "mtg-reply-action", children }: {
  label: string;
  value: string;
  buttonClass?: string;
  children: ReactNode;
}) {
  const { t: tr } = useTelegramLocale();
  const [status, setStatus] = useState<"copied" | "unavailable">();
  const copyLabel = tr("Copy {0}", [label.toLowerCase()]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setStatus("copied");
    } catch {
      setStatus("unavailable");
    }
  }

  return <>
    <button type="button" className={buttonClass} aria-label={copyLabel} title={copyLabel}
      onClick={() => void copy()}>{children}</button>
    {status === "copied" && <span role="status">{label}{tr(" copied")}</span>}
    {status === "unavailable" && <input aria-label={label} value={value} readOnly
      onFocus={(event) => event.currentTarget.select()} />}
  </>;
}
