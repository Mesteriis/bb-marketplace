import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useRef, useState } from "react";
import { managedBotDraft, type ManagedBotDraft, type ManagedBotReview, type schemas } from "../core/contract.ts";

export function ManagedBotCreation({ review, busy, submit, cancel }: {
  review: ManagedBotReview; busy: boolean; submit: (draft: ManagedBotDraft) => void; cancel: () => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [name, setName] = useState(review.suggestedName ?? "");
  const [username, setUsername] = useState(review.suggestedUsername ?? "");
  const draft = managedBotDraft.safeParse({ name, username }).data;
  return <section aria-label={tr("Create a managed Telegram bot")}>
    <p>{tr("Telegram will create a bot on your account and let ")}<bdi>{review.bot}</bdi>{tr(" manage it.")}</p>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (draft && !busy) submit(draft);
    }}>
      <label>{tr("Bot name ")}<input value={name} maxLength={128} required disabled={busy} onChange={(event) => setName(event.target.value)} /></label>
      <label>{tr("Bot username ")}<input value={username} maxLength={32} required disabled={busy} autoCapitalize="none" spellCheck={false}
        onChange={(event) => setUsername(event.target.value)} /></label>
      <button type="submit" className="mtg-action" disabled={busy || !draft}>{busy ? tr("Creating bot…") : tr("Create managed bot")}</button>
      <button type="button" className="mtg-action" disabled={busy} onClick={cancel}>{tr("Cancel bot creation")}</button>
    </form>
  </section>;
}

export type LinkedManagedBotActions = {
  preview: (url: string) => Promise<ManagedBotReview | null>;
  create: (confirmation: string, draft: ManagedBotDraft) => Promise<ReturnType<typeof schemas.createLinkedManagedBot.output.parse>>;
};

export function LinkedManagedBotDialog({ review, create, close }: {
  review: ManagedBotReview; create: LinkedManagedBotActions["create"]; close: () => void;
}) {
  const { t: tr } = useTelegramLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const dispatching = useRef(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; finished: boolean }>();
  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);

  async function submit(draft: ManagedBotDraft) {
    if (dispatching.current || feedback?.finished) return;
    dispatching.current = true;
    setBusy(true);
    setFeedback(undefined);
    const result = await create(review.confirmation, draft).catch(() => "unknown" as const);
    const text = {
      created: `Created @${draft.username} with ${review.bot} as its managing bot.`,
      usernameUnavailable: "Telegram did not accept this username. Try another one.",
      limitReached: "You have reached Telegram’s limit for owned bots.",
      failed: "Could not create the managed bot.",
      unknown: "Telegram did not confirm creation. Check whether the bot exists before trying again.",
    }[result];
    setFeedback({ text, finished: result !== "usernameUnavailable" });
    setBusy(false);
    dispatching.current = false;
  }

  return <dialog ref={dialog} className="mtg-agent-settings" aria-label={tr("Telegram managed bot")} onCancel={(event) => {
    event.preventDefault();
    if (!dispatching.current) close();
  }}>
    {feedback && <p role="status" dir="auto">{feedback.text}</p>}
    {feedback?.finished ? <button type="button" className="mtg-action" onClick={close}>{tr("Close")}</button>
      : <ManagedBotCreation review={review} busy={busy} submit={(draft) => void submit(draft)} cancel={close} />}
  </dialog>;
}
