import { useEffect, useState } from "react";
import { AvatarEditor } from "./avatar-editor.tsx";
import type { ChatInfo, ChatInfoChange, SaveAvatarResult } from "../core/contract.ts";

export type ChatInfoActions = {
  load: (id: string) => Promise<ChatInfo | null>;
  removePhoto?: (id: string, expected: string) => Promise<SaveAvatarResult>;
  savePhoto?: (id: string, base64: string, expected: string | null) => Promise<SaveAvatarResult>;
  save: (id: string, change: ChatInfoChange) => Promise<"saved" | "changed" | "unavailable">;
};

export function ChatInfoPanel({ chatId, actions }: { chatId: string; actions: ChatInfoActions }) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<ChatInfo | null>();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setInfo(undefined);
    setError("");
    setNotice("");
    void actions.load(chatId).then((value) => {
      if (!active) return;
      setInfo(value);
      setTitle(value?.title ?? "");
      setDescription(value?.description ?? "");
    }, () => { if (active) setError("Could not load chat information."); });
    return () => { active = false; };
  }, [chatId, open, revision, actions]);

  const nextTitle = title.trim();
  const nextDescription = description.trim();
  const titleValid = !!nextTitle && [...nextTitle].length <= 128;
  const descriptionValid = [...nextDescription].length <= 255;
  async function save(field: ChatInfoChange["field"], value: string) {
    if (!info?.editable || busy || info[field] === value) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await actions.save(chatId, { field, value, expected: info[field] });
      if (result === "saved") {
        setInfo({ ...info, [field]: value });
        setNotice(field === "title" ? "Chat name saved." : "Description saved.");
      } else {
        if (result === "changed") setInfo(undefined);
        setError(result === "changed" ? "Chat information changed in Telegram. Reload it before saving."
          : "Telegram did not save the change.");
      }
    } catch { setError("Could not save chat information."); }
    finally { setBusy(false); }
  }

  return <details className="mtg-chat-info" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Group or channel information</summary>
    {open && <>
      {info === undefined && !error && <p role="status">Loading chat information…</p>}
      {info === null && <p>Chat information is unavailable.</p>}
      {info && <>
        <form onSubmit={(event) => { event.preventDefault(); if (titleValid) void save("title", nextTitle); }}>
          <label>Chat name <input value={title} maxLength={256} disabled={busy} readOnly={!info.editable}
            onChange={(event) => setTitle(event.target.value)} /></label>
          {info.editable && <button type="submit" className="mtg-action"
            disabled={busy || !titleValid || nextTitle === info.title}>Save chat name</button>}
        </form>
        <form onSubmit={(event) => { event.preventDefault(); if (descriptionValid) void save("description", nextDescription); }}>
          <label>Description <textarea value={description} maxLength={510} disabled={busy} readOnly={!info.editable}
            onChange={(event) => setDescription(event.target.value)} /></label>
          {info.editable && <button type="submit" className="mtg-action"
            disabled={busy || !descriptionValid || nextDescription === info.description}>Save description</button>}
        </form>
        {info.editable && actions.savePhoto && info.photoVersion !== undefined &&
          <AvatarEditor label="chat photo" version={info.photoVersion} disabled={busy}
            save={(base64, expected) => actions.savePhoto!(chatId, base64, expected)}
            remove={actions.removePhoto ? (expected) => actions.removePhoto!(chatId, expected) : undefined}
            canRemove={!!info.photoVersion}
            reload={async () => {
              const fresh = await actions.load(chatId);
              return { version: fresh?.photoVersion, canRemove: !!fresh?.editable && !!fresh.photoVersion };
            }} />}
      </>}
      {error && <p role="alert">{error} <button type="button" className="mtg-action" disabled={busy}
        onClick={() => setRevision((value) => value + 1)}>Reload chat information</button></p>}
      {notice && <p role="status">{notice}</p>}
    </>}
  </details>;
}
