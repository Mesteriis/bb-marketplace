import { useState } from "react";
import { Trash2 } from "lucide-react";
import type { DeletionScope } from "../core/contract.ts";

export type MessageDeletionActions = {
  deletionOptions: (id: string, messageId: string) => Promise<DeletionScope[]>;
  deleteMessage: (id: string, messageId: string, scope: DeletionScope) => Promise<"deleted" | "refused" | "unknown">;
};

export function MessageDeletion({ chatId, messageId, deletionOptions, deleteMessage }: MessageDeletionActions & {
  chatId: string;
  messageId: string;
}) {
  const [prompt, setPrompt] = useState<{ scopes?: DeletionScope[]; busy: boolean; text?: string }>();

  async function open() {
    setPrompt({ busy: true, text: "Checking deletion options…" });
    try {
      const scopes = await deletionOptions(chatId, messageId);
      setPrompt({ scopes, busy: false, text: scopes.length ? "Delete this message?" : "Telegram does not allow deleting this message." });
    } catch {
      setPrompt({ busy: false, text: "Could not check Telegram deletion permissions." });
    }
  }

  async function remove(scope: DeletionScope) {
    setPrompt({ busy: true, text: "Deleting message…" });
    const result = await deleteMessage(chatId, messageId, scope).catch(() => "unknown");
    const text = result === "deleted" ? "Message deleted."
      : result === "refused" ? "Telegram did not allow this deletion."
      : "Telegram did not confirm the deletion. Check the conversation before trying again.";
    setPrompt({ busy: false, text });
  }

  if (!prompt) return <button type="button" className="mtg-reply-action" aria-label="Delete message"
    title="Delete message" onClick={() => void open()}><Trash2 size={15} aria-hidden="true" /></button>;

  return <div className="mtg-edit" role="group" aria-label="Message deletion">
    <p role="status">{prompt.text}</p>
    <div>
      {prompt.scopes?.map((scope) => <button key={scope} type="button" className="mtg-action"
        onClick={() => void remove(scope)}>{scope === "self" ? "Delete for me" : "Delete for everyone"}</button>)}
      {!prompt.busy && <button type="button" className="mtg-action"
        onClick={() => setPrompt(undefined)}>{prompt.scopes?.length ? "Cancel" : "Close"}</button>}
    </div>
  </div>;
}
