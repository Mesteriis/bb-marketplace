import { useTelegramLocale } from "./i18n/index.tsx";
import { useRef, useState, type FormEvent } from "react";
import type { z } from "zod";
import type { BusinessChatLinkChange, schemas } from "../core/contract.ts";
import { sameDraftLinks, sameDraftStyles } from "../core/draft-formatting.ts";
import { DraftFormatButton, DraftFormatControls, useDraftFormatting } from "./draft-formatting.tsx";
import { MessageText } from "./message-text.tsx";

type View = z.infer<typeof schemas.businessChatLinks.output>;
type Link = View["links"][number];
type Actions = {
  read: () => Promise<View>;
  change: (input: BusinessChatLinkChange) => Promise<z.infer<typeof schemas.changeBusinessChatLink.output>>;
};

export function BusinessChatLinksSettings({ read, change }: Actions) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  const pending = useRef(false);
  const [view, setView] = useState<View>();
  const [editor, setEditor] = useState<Link | "new">();
  const [deleting, setDeleting] = useState<Link>();
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function run(task: () => Promise<void>, failure: string) {
    if (pending.current) return;
    pending.current = true;
    setError("");
    setNotice("");
    setBusy(true);
    try { await task(); }
    catch { setError(failure); }
    finally { pending.current = false; setBusy(false); }
  }

  async function load() {
    setView(await read());
    setEditor(undefined);
    setDeleting(undefined);
    setStale(false);
  }

  function submit(input: BusinessChatLinkChange) {
    if (stale) return;
    void run(async () => {
      const result = await change(input).catch((error) => {
        setStale(true);
        throw error;
      });
      if (result === "changed") {
        setStale(true);
        setError("This link changed in Telegram. Reload links before making changes.");
      } else if (result === "saved" || result === "deleted") {
        setNotice(result === "saved" ? "Business chat link saved." : "Business chat link deleted.");
        setStale(true);
        setEditor(undefined);
        setDeleting(undefined);
        try { await load(); }
        catch { setError("Could not reload Business chat links."); }
      } else {
        setError(result === "unavailable" ? "Creating and editing links requires Telegram Business."
          : "Telegram cannot use this prepared message.");
      }
    }, "Could not confirm the link change. Reload links to check the result.");
  }

  return <>
    <h3>{tr("Business chat links")}</h3>
    <button type="button" className="mtg-action" disabled={busy}
      onClick={() => void run(load, "Could not load Business chat links.")}>{view ? tr("Reload links") : tr("Load links")}</button>
    {view && <>
      {view.canEdit ? <button type="button" className="mtg-action" disabled={busy || stale || !!editor || !!deleting}
        onClick={() => setEditor("new")}>{tr("New chat link")}</button>
        : <p>{tr("Creating and editing links requires Telegram Business.")}</p>}
      {view.links.length === 0 && <p>{tr("No Business chat links.")}</p>}
      {view.links.length > 0 && <ul aria-label={tr("Business chat links")}>
        {view.links.map((link) => <li key={link.url}>
          <strong>{link.title || link.url}</strong>
          {link.title && <div>{link.url}</div>}
          <p>{link.views.toLocaleString(uiLocale)} {link.views === 1 ? tr("view") : tr("views")}</p>
          {link.message.text && <MessageText {...link.message} />}
          <button type="button" className="mtg-action" disabled={busy} onClick={() => {
            void run(async () => {
              await navigator.clipboard.writeText(link.url);
              setNotice("Business chat link copied.");
            }, "Could not copy the Business chat link.");
          }}>{tr("Copy link")}</button>
          {view.canEdit && <button type="button" className="mtg-action" disabled={busy || stale || !!editor || !!deleting}
            onClick={() => setEditor(link)}>{tr("Edit link")}</button>}
          <button type="button" className="mtg-action" disabled={busy || stale || !!editor || !!deleting}
            onClick={() => setDeleting(link)}>{tr("Delete link")}</button>
        </li>)}
      </ul>}
    </>}
    {editor && <BusinessChatLinkEditor key={editor === "new" ? "new" : editor.url}
      link={editor === "new" ? undefined : editor} busy={busy} stale={stale}
      submit={submit} close={() => setEditor(undefined)} />}
    {deleting && <div role="group" aria-label={tr("Confirm Business chat link deletion")}>
      <p>{tr("Delete the link ")}{deleting.title || deleting.url}?</p>
      <button type="button" className="mtg-action" disabled={busy || stale}
        onClick={() => submit({ action: "delete", url: deleting.url, revision: deleting.revision })}>{tr("Confirm delete link")}</button>
      <button type="button" className="mtg-action" disabled={busy} onClick={() => setDeleting(undefined)}>{tr("Keep link")}</button>
    </div>}
    {busy && <p role="status">{tr("Working with Business chat links…")}</p>}
    {error && <p role="alert">{tr(error)}</p>}
    {notice && <p role="status">{tr(notice)}</p>}
  </>;
}

function BusinessChatLinkEditor({ link, busy, stale, submit, close }: {
  link?: Link; busy: boolean; stale: boolean; submit: (input: BusinessChatLinkChange) => void; close: () => void;
}) {
  const { t: tr } = useTelegramLocale();
  const input = useRef<HTMLTextAreaElement>(null);
  const [title, setTitle] = useState(link?.title ?? "");
  const [text, setText] = useState(link?.message.text ?? "");
  const styles = link?.message.styles ?? [];
  const links = link?.message.links?.filter((item) => item.hidden) ?? [];
  const formatting = useDraftFormatting(link?.url ?? "new", text, input, styles, true, links);
  const canEditMessage = !link || link.messageEditable;
  const messageChanged = canEditMessage && (text !== link?.message.text || !sameDraftStyles(formatting.ranges, styles)
    || !sameDraftLinks(formatting.links, links));

  function save(event: FormEvent) {
    event.preventDefault();
    if (busy || stale) return;
    const message = { text: text.trim(), styles: formatting.deliveryStyles, links: formatting.deliveryLinks };
    if (!link) submit({ action: "create", title, message });
    else if (title !== link.title || messageChanged) submit({ action: "edit", url: link.url, revision: link.revision, title,
      ...(messageChanged && { message }) });
  }

  return <form aria-label={link ? tr("Edit Business chat link") : tr("New Business chat link")} onSubmit={save}>
    <label>{tr("Link title ")}<input value={title} maxLength={128} readOnly={stale || busy}
      onChange={(event) => setTitle(event.target.value)} /></label>
    <label>{tr("Prepared message ")}<textarea ref={input} value={text} maxLength={4096}
      readOnly={busy || stale || !canEditMessage}
      onChange={(event) => { formatting.change(event.target.value); setText(event.target.value); }}
      onSelect={(event) => formatting.select(event.currentTarget)}
      onKeyDown={busy || stale || !canEditMessage ? undefined : formatting.shortcut} /></label>
    {canEditMessage ? <>
      <DraftFormatButton formatting={formatting} busy={busy || stale} />
      <DraftFormatControls formatting={formatting} busy={busy || stale} />
    </> : <p>{tr("This message contains formatting that BB cannot edit. You can still change the title.")}</p>}
    <button type="submit" className="mtg-action" disabled={busy || stale || (!!link && title === link.title && !messageChanged)}>
      {link ? tr("Save link changes") : tr("Create link")}
    </button>
    <button type="button" className="mtg-action" disabled={busy} onClick={close}>{tr("Cancel")}</button>
  </form>;
}
