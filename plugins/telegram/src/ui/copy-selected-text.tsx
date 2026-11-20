import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import type { SelectedText } from "../core/contract.ts";
import { downloadBlob } from "./download-blob.ts";

export function CopySelectedText({ load, allowHtml, label = "Copy selected text", icon: Icon }: {
  load: (format?: "portable") => Promise<SelectedText | null>; allowHtml?: boolean; label?: string; icon?: LucideIcon;
}) {
  const { t: tr } = useTelegramLocale();
  const request = useRef<AbortController>(undefined);
  const [status, setStatus] = useState<"loading" | "copied" | "unavailable" | "saving" | "saved" | "saveFailed">();
  const [text, setText] = useState("");
  useEffect(() => () => request.current?.abort(), []);

  async function copy() {
    if (status === "loading" || status === "saving") return;
    const controller = new AbortController();
    request.current = controller;
    setText("");
    setStatus("loading");
    const pending = load().catch(() => null);
    const clipboard = navigator.clipboard;
    let richWrite: Promise<boolean> | undefined;
    if (typeof clipboard?.write === "function" && typeof ClipboardItem === "function") {
      const payload = (type: "text/plain" | "text/html") => pending.then((value) => {
        if (!value || controller.signal.aborted) throw new Error("Copy is unavailable.");
        const data = type === "text/plain" ? typeof value === "string" ? value : value.text
          : typeof value === "string" ? undefined : value.html;
        if (data === undefined) throw new Error("Formatted text is unavailable.");
        return new Blob([data], { type });
      });
      const plain = payload("text/plain");
      const html = payload("text/html");
      // Keep the clipboard call in the click's user activation, including in Safari.
      void plain.catch(() => {});
      void html.catch(() => {});
      try {
        richWrite = clipboard.write([new ClipboardItem({ "text/plain": plain, "text/html": html })]).then(() => true, () => false);
      } catch {
        // Older hosts may expose ClipboardItem but reject promised representations.
      }
    }
    const value = await pending;
    if (controller.signal.aborted) return;
    if (!value) { setStatus("unavailable"); return; }
    const plain = typeof value === "string" ? value : value.text;
    try {
      if (!await richWrite) {
        if (controller.signal.aborted) return;
        await clipboard.writeText(plain);
      }
      if (!controller.signal.aborted) setStatus("copied");
    } catch {
      if (controller.signal.aborted) return;
      setText(plain);
      setStatus(undefined);
    }
  }

  async function save() {
    if (status === "loading" || status === "saving") return;
    const controller = new AbortController();
    request.current = controller;
    setText("");
    setStatus("saving");
    const value = await load("portable").catch(() => null);
    if (controller.signal.aborted) return;
    try {
      if (!value || typeof value === "string" || !value.html) { setStatus("saveFailed"); return; }
      const html = '<!doctype html><html><head><meta charset="utf-8">'
        + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">'
        + '<title>Telegram messages</title></head><body>' + value.html + '</body></html>';
      downloadBlob(new Blob([html], { type: "text/html;charset=utf-8" }), "telegram-messages.html");
      setStatus("saved");
    } catch {
      setStatus("saveFailed");
    }
  }

  return <>
    <button type="button" className="mtg-action" disabled={status === "loading" || status === "saving"} onClick={() => void copy()}>
      {Icon && <Icon size={15} aria-hidden="true" />}{label}
    </button>
    {allowHtml && <button type="button" className="mtg-action" disabled={status === "loading" || status === "saving"}
      onClick={() => void save()}>{tr("Save as HTML")}</button>}
    {status === "copied" && <span role="status">{tr("Selected text copied.")}</span>}
    {status === "unavailable" && <span role="status">{tr("No copyable text is available for this selection.")}</span>}
    {status === "saved" && <span role="status">{tr("HTML download started.")}</span>}
    {status === "saveFailed" && <span role="status">{tr("HTML is unavailable for this selection.")}</span>}
    {text && <textarea aria-label={tr("Selected message text")} readOnly value={text} onFocus={(event) => event.currentTarget.select()} />}
  </>;
}
