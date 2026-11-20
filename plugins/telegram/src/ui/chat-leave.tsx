import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useState } from "react";

type LeaveOptions = { owner: boolean; basic: boolean; canDelete?: true };
export type ChatLeaveActions = {
  load: (id: string, name: string) => Promise<LeaveOptions | null>;
  leave: (id: string, name: string, expectedOwner: boolean) => Promise<"left" | "refused" | "unknown">;
  deleteOwned?: (id: string, title: string, kind: "Group" | "Channel") => Promise<"deleted" | "refused" | "not_owner" | "not_deletable" | "unknown">;
};

export function ChatLeave({ id, name, kind, actions, onLeft }: {
  id: string;
  name: string;
  kind: "group" | "channel";
  actions: ChatLeaveActions;
  onLeft: () => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [options, setOptions] = useState<LeaveOptions | null>(null);
  const [prompt, setPrompt] = useState<"leave" | "delete">();
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setOptions(null);
    setPrompt(undefined);
    setConfirmation("");
    setError("");
    void actions.load(id, name).then((result) => {
      if (active) setOptions(result);
    }, () => { if (active) setError("Could not check whether you can leave."); });
    return () => { active = false; };
  }, [actions, id, name]);

  async function leave() {
    if (prompt !== "leave" || !options || busy) return;
    setBusy(true);
    const result = await actions.leave(id, name, options.owner).catch(() => "unknown" as const);
    setBusy(false);
    setPrompt(undefined);
    if (result === "left") onLeft();
    else {
      setOptions(null);
      setError(result === "unknown" ? "Telegram did not confirm that you left." : "Telegram refused the request or your membership changed.");
    }
  }

  async function deleteOwned() {
    if (prompt !== "delete" || !options?.canDelete || !actions.deleteOwned || busy || confirmation !== name) return;
    setBusy(true);
    const result = await actions.deleteOwned(id, name, kind === "group" ? "Group" : "Channel").catch(() => "unknown" as const);
    setBusy(false);
    setPrompt(undefined);
    if (result === "deleted") onLeft();
    else {
      setOptions(null);
      setError(result === "unknown" ? "Telegram did not confirm deletion. Check the chat list before retrying."
        : "Telegram refused deletion or this chat's ownership or permissions changed.");
    }
  }

  return <>
    {options && (prompt === "leave" ? <div role="group" aria-label={tr("Confirm leaving the {0}", [kind])}>
      <p>{tr("Leave ")}<bdi>{name}</bdi>?</p>
      {options.owner && <p>{options.basic
        ? tr("Telegram may transfer ownership to another member immediately.")
        : tr("If you do not return within seven days, Telegram may transfer ownership to another member.")}</p>}
      <button type="button" className="mtg-action" disabled={busy} onClick={() => void leave()}>
        {busy ? tr("Leaving…") : tr("Confirm leave")}
      </button>
      <button type="button" className="mtg-action" disabled={busy} onClick={() => setPrompt(undefined)}>{tr("Cancel")}</button>
    </div> : prompt === "delete" ? <div role="group" aria-label={tr("Confirm deleting the {0}", [kind])}>
      <p>{tr("Delete ")}<bdi>{name}</bdi>{tr(" and its messages for all members?")}</p>
      <label>{tr("Type the chat name ")}<input value={confirmation} disabled={busy}
        onChange={(event) => setConfirmation(event.target.value)} /></label>
      <button type="button" className="mtg-action" disabled={busy || confirmation !== name} onClick={() => void deleteOwned()}>
        {busy ? tr("Deleting…") : tr("Delete for everyone")}
      </button>
      <button type="button" className="mtg-action" disabled={busy} onClick={() => setPrompt(undefined)}>{tr("Cancel")}</button>
    </div> : <>
      <button type="button" className="mtg-action" onClick={() => setPrompt("leave")}>{tr("Leave ")}{kind}</button>
      {options.canDelete && actions.deleteOwned && <button type="button" className="mtg-action" onClick={() => {
        setConfirmation("");
        setPrompt("delete");
      }}>{tr("Delete ")}{kind}</button>}
    </>)}
    {error && <p role="alert">{tr(error)}</p>}
  </>;
}
