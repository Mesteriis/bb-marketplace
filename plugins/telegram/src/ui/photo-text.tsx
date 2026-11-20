import { useTelegramLocale } from "./i18n/index.tsx";
import { Check, Copy, ScanText } from "lucide-react";
import { createContext, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { PhotoSize, PhotoTextResult } from "../core/contract.ts";

export const PhotoTextRecognition = createContext<((chatId: string, messageId: string, size: PhotoSize, sha256: string) =>
  Promise<PhotoTextResult | null>) | undefined>(undefined);

export function PhotoText({ recognize, input, onResult }: {
  recognize: () => Promise<PhotoTextResult | null>;
  input: RefObject<HTMLTextAreaElement | null>;
  onResult: (result: PhotoTextResult) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const busy = useRef(false);
  const active = useRef(false);
  const [status, setStatus] = useState<"reading" | "empty" | "unavailable" | "copied" | "copyFailed">();
  const [text, setText] = useState("");
  useLayoutEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  async function read() {
    if (busy.current) return;
    busy.current = true;
    setStatus("reading");
    try {
      const result = await recognize();
      if (!active.current) return;
      if (result?.lines.length) {
        setText(result.lines.map(({ text }) => text).join("\n"));
        onResult(result);
        setStatus(undefined);
      } else setStatus(result ? "empty" : "unavailable");
    } catch {
      if (active.current) setStatus("unavailable");
    } finally {
      busy.current = false;
    }
  }

  return <section className="mtg-photo-recognized-text" aria-label={tr("Photo text recognition")}>
    {!text && <button type="button" className="mtg-viewer-detail-action" disabled={status === "reading"} onClick={() => void read()}>
      <ScanText size={16} aria-hidden="true" />
      {status === "reading" ? tr("Recognizing text…") : tr("Recognize text")}
    </button>}
    {text && <div className="mtg-photo-text-result">
      <div className="mtg-photo-text-result-header">
        <span>{tr("Recognized text")}</span>
        <button type="button" className="mtg-photo-text-copy" aria-label={tr("Copy recognized text")} title={tr("Copy recognized text")}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setStatus("copied");
            } catch {
              setStatus("copyFailed");
            }
          }}>
          {status === "copied" ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
        </button>
      </div>
      <textarea ref={input} readOnly aria-label={tr("Recognized text")} dir="auto"
        rows={Math.min(6, text.split("\n").length)} value={text} />
    </div>}
    {status === "empty" && <p role="status">{tr("No text found in this photo.")}</p>}
    {status === "copied" && <p role="status">{tr("Recognized text copied.")}</p>}
    {status === "unavailable" && <p role="alert">{tr("Text recognition is unavailable for this photo.")}</p>}
    {status === "copyFailed" && <p role="alert">{tr("Could not copy recognized text.")}</p>}
  </section>;
}
