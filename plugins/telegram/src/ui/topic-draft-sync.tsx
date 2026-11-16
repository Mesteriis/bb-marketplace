import { useEffect, useState } from "react";
import type { TopicDraft } from "../core/contract.ts";

export type TopicDraftActions = {
  load: (chatId: string, topicId: number) => Promise<TopicDraft>;
  save: (chatId: string, text: string, expected: string | null, topicId: number) => Promise<"saved" | "changed" | "unsupported">;
};

export function TopicDraftSync({ chatId, topicId, load, save, text, edited, busy, useDraft }: TopicDraftActions & {
  chatId: string;
  topicId: number;
  text: string;
  edited: boolean;
  busy: boolean;
  useDraft: (text: string) => void;
}) {
  const [remote, setRemote] = useState<TopicDraft>();
  const [revision, setRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let current = true;
    void load(chatId, topicId).then((result) => {
      if (current) setRemote(result);
    }, () => {
      if (current) setNotice("Could not load the Telegram draft.");
    });
    return () => { current = false; };
  }, [chatId, load, revision, topicId]);

  const next = text.trim() ? text : null;
  const canSave = remote?.writable && edited && next !== remote.text;

  async function sync() {
    if (!remote || !canSave || busy || saving) return;
    setSaving(true);
    setNotice("");
    try {
      const result = await save(chatId, next ?? "", remote.text, topicId);
      if (result === "saved") {
        setRemote({ text: next, writable: true });
        setNotice(next ? "Draft saved to Telegram." : "Telegram draft cleared.");
      } else {
        setRemote(undefined);
        setNotice(result === "changed" ? "The Telegram draft changed. Reload it before saving."
          : "This Telegram draft cannot be replaced from BB.");
      }
    } catch {
      setRemote(undefined);
      setNotice("Could not confirm that Telegram saved the draft.");
    } finally {
      setSaving(false);
    }
  }

  return <div className="mtg-composer-media">
    {remote?.text && !edited && <button type="button" className="mtg-action" disabled={busy || saving}
      onClick={() => useDraft(remote.text!)}>Use Telegram draft</button>}
    {remote && !remote.writable && (edited || !remote.text) && <p>This Telegram draft cannot be replaced from BB.</p>}
    {canSave && <button type="button" className="mtg-action" disabled={busy || saving}
      onClick={() => void sync()}>{next ? "Save draft to Telegram" : "Clear Telegram draft"}</button>}
    {notice && <p role="status">{notice}</p>}
    {!remote && notice && <button type="button" className="mtg-action" disabled={busy || saving}
      onClick={() => { setNotice(""); setRevision((value) => value + 1); }}>Reload Telegram draft</button>}
  </div>;
}
