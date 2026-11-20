import { useTelegramLocale } from "./i18n/index.tsx";
import { sameDraftCustomEmoji, sameDraftLinks, sameDraftPreview, sameDraftStyles } from "../core/draft-formatting.ts";
import { useEffect, useState, type ReactNode } from "react";
import type { SyncedDraft, TopicDraft } from "../core/contract.ts";

export type TopicDraftActions = {
  load: (chatId: string, topicId: number) => Promise<TopicDraft>;
  save: (chatId: string, draft: SyncedDraft | null, expected: SyncedDraft | null, topicId: number) => Promise<"saved" | "changed" | "unsupported">;
};

export function TelegramDraftReview({ remote, disabled, useDraft }: {
  remote: TopicDraft;
  disabled: boolean;
  useDraft: (draft: SyncedDraft | null) => void;
}) {
  const { t: tr } = useTelegramLocale();
  return <div role="group" aria-label={tr("Latest Telegram draft")}>
    <p>{tr("Latest Telegram draft")}</p>
    {remote.draft ? <blockquote className="mtg-agent-text">{remote.draft.text}</blockquote>
      : remote.writable ? <p>{tr("Telegram has no saved draft.")}</p> : null}
    {remote.writable && <button type="button" className="mtg-action" disabled={disabled}
      onClick={() => useDraft(remote.draft)}>{tr("Use latest Telegram draft")}</button>}
  </div>;
}

export function TopicDraftSync({ chatId, topicId, load, save, draft, edited, busy, useDraft, renderLinkDraft }: TopicDraftActions & {
  chatId: string;
  topicId: number;
  draft: SyncedDraft | null;
  edited: boolean;
  busy: boolean;
  useDraft: (draft: SyncedDraft) => void;
  renderLinkDraft?: (remote: TopicDraft | undefined) => ReactNode;
}) {
  const { t: tr } = useTelegramLocale();
  const [remote, setRemote] = useState<TopicDraft>();
  const [revision, setRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [reviewRequired, setReviewRequired] = useState(false);
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

  const current = remote?.draft;
  const changed = draft?.text !== current?.text || !sameDraftStyles(draft?.styles ?? [], current?.styles ?? [])
    || !sameDraftLinks(draft?.links ?? [], current?.links ?? [])
    || !sameDraftCustomEmoji(draft?.customEmoji ?? [], current?.customEmoji ?? []) || !sameDraftPreview(draft?.preview, current?.preview);
  const canSave = remote?.writable && edited && changed;

  async function sync() {
    if (!remote || !canSave || busy || saving) return;
    setSaving(true);
    setNotice("");
    try {
      const result = await save(chatId, draft, remote.draft, topicId);
      if (result === "saved") {
        setRemote(undefined);
        setReviewRequired(false);
        setRevision((value) => value + 1);
        setNotice(draft ? "Draft saved to Telegram." : "Telegram draft cleared.");
      } else {
        setRemote(undefined);
        setReviewRequired(result === "changed");
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

  return <>{renderLinkDraft?.(remote)}<div className="mtg-composer-media">
    {remote && reviewRequired && <TelegramDraftReview remote={remote} disabled={busy || saving}
      useDraft={(latest) => {
        useDraft(latest ?? { text: "" });
        setReviewRequired(false);
        setNotice("");
      }} />}
    {remote?.draft && !edited && !reviewRequired && <button type="button" className="mtg-action" disabled={busy || saving}
      onClick={() => useDraft(remote.draft!)}>{tr("Use Telegram draft")}</button>}
    {remote && !remote.writable && (edited || !remote.draft) && <p>{tr("This Telegram draft cannot be replaced from BB.")}</p>}
    {canSave && <button type="button" className="mtg-action" disabled={busy || saving}
      onClick={() => void sync()}>{draft ? tr("Save draft to Telegram") : tr("Clear Telegram draft")}</button>}
    {notice && <p role="status">{tr(notice)}</p>}
    {!remote && notice && <button type="button" className="mtg-action" disabled={busy || saving}
      onClick={() => { setNotice(""); setRevision((value) => value + 1); }}>{reviewRequired ? tr("Review newer Telegram draft") : tr("Reload Telegram draft")}</button>}
  </div></>;
}
