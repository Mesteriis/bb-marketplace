import { useTelegramLocale } from "./i18n/index.tsx";
import { createContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { RichBankCardMode, RichBankCardResult } from "../core/contract.ts";
import { webLink } from "../core/message-links.ts";

export const LoadRichBankCard = createContext<((chatId: string, messageId: string, reference: string, mode: RichBankCardMode)
  => Promise<RichBankCardResult>) | undefined>(undefined);

export function RichBankCardAction({ children, load }: {
  children: ReactNode; load: (mode: RichBankCardMode) => Promise<RichBankCardResult>;
}) {
  const { t: tr } = useTelegramLocale();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const generation = useRef(0);
  const copyPending = useRef(false);
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<Exclude<RichBankCardResult, { kind: "copy" }>>();
  const [copyStatus, setCopyStatus] = useState("");
  useEffect(() => () => { generation.current++; }, []);

  function close(restoreFocus = false) {
    generation.current++;
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }

  async function show() {
    if (open) { close(); return; }
    const request = ++generation.current;
    setOpen(true);
    setInfo(undefined);
    setCopyStatus("");
    const result = await load("info").catch(() => ({ kind: "unavailable" as const }));
    if (request === generation.current) setInfo(result.kind === "copy" ? { kind: "unavailable" } : result);
  }

  async function copy() {
    if (copyPending.current) return;
    const request = generation.current;
    copyPending.current = true;
    try {
      const result = await load("copy");
      if (request !== generation.current) return;
      if (result.kind !== "copy") throw new Error("Card unavailable");
      await navigator.clipboard.writeText(result.number);
      if (request === generation.current) setCopyStatus("Card number copied.");
    } catch {
      if (request === generation.current) setCopyStatus("Could not copy the card number.");
    } finally {
      copyPending.current = false;
    }
  }

  return <span className="mtg-rich-bank-card" onKeyDown={(event) => {
    if (!open || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  }}>
    <button ref={trigger} type="button" className="mtg-instant-view-reference" aria-expanded={open}
      aria-controls={open ? id : undefined} onClick={() => void show()}>{children}</button>
    {open && <span id={id} className="mtg-rich-bank-card-actions" role="group" aria-label={tr("Bank card actions")}>
      <button type="button" className="mtg-action" onClick={() => void copy()}>{tr("Copy card number")}</button>
      {!info && <span role="status">{tr("Loading card information…")}</span>}
      {info?.kind === "unavailable" && <span role="status">{tr("Card information unavailable.")}</span>}
      {info?.kind === "info" && <>
        {info.title && <span>{info.title}</span>}
        {info.links.map(({ url, text }, index) => {
          const target = webLink(url);
          return target?.protocol === "https:" ? <a key={index} href={target.href} title={target.hostname}
            target="_blank" rel="noopener noreferrer">{text}</a> : null;
        })}
      </>}
      {copyStatus && <span role="status">{tr(copyStatus)}</span>}
    </span>}
  </span>;
}
