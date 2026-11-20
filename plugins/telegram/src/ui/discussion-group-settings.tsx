import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useRef, useState } from "react";
import type { DiscussionGroupCandidate, DiscussionGroupResult, GroupUpgradeResult, DiscussionGroupView } from "../core/contract.ts";

export type DiscussionGroupActions = {
  load: (id: string) => Promise<DiscussionGroupView | null>;
  candidates: (id: string) => Promise<DiscussionGroupCandidate[] | null>;
  save: (id: string, target: string | null, expected: string | null) => Promise<DiscussionGroupResult>;
  enableHistory?: (id: string, target: string, title: string, expected: string | null) => Promise<DiscussionGroupResult>;
  upgrade?: (id: string, target: string, title: string, expected: string | null) => Promise<GroupUpgradeResult>;
};

export function DiscussionGroupSettings({ id, actions, channel }: { id: string; actions: DiscussionGroupActions; channel: boolean }) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const [view, setView] = useState<DiscussionGroupView | null>();
  const [choosing, setChoosing] = useState(false);
  const [candidates, setCandidates] = useState<DiscussionGroupCandidate[] | null>();
  const [review, setReview] = useState<{ target: DiscussionGroupCandidate | null; expected: DiscussionGroupView["current"]; stage?: "history" | "upgrade" }>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const saving = useRef(false);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setView(undefined);
    void actions.load(id).then((value) => { if (active) setView(value); }, () => { if (active) setView(null); });
    return () => { active = false; };
  }, [actions, id, open, revision]);

  useEffect(() => {
    if (!channel || !open || !choosing) return;
    let active = true;
    setCandidates(undefined);
    void actions.candidates(id).then((value) => { if (active) setCandidates(value); }, () => { if (active) setCandidates(null); });
    return () => { active = false; };
  }, [actions, channel, id, open, choosing, revision]);

  async function confirm() {
    if (!review || saving.current) return;
    saving.current = true;
    setBusy(true);
    setNotice("");
    try {
      const expected = review.expected?.id ?? null;
      const prepare = review.stage === "history" ? actions.enableHistory : actions.upgrade;
      const result = review.stage
        ? (review.target && await prepare?.(id, review.target.id, review.target.title, expected)) ?? "unavailable"
        : await actions.save(id, review.target?.id ?? null, expected);
      if (typeof result === "object") {
        setReview((current) => current === review ? { ...review, target: result.group, stage: undefined } : current);
        setNotice("Group upgraded. Confirm the link when ready.");
        return;
      }
      if (review.stage === "history" && result === "saved") {
        setReview((current) => current === review ? { ...review, stage: undefined } : current);
        setNotice("Group history is visible to new members. Confirm the link when ready.");
        return;
      }
      if (!review.stage && result === "historyHidden" && review.target && actions.enableHistory) {
        setReview((current) => current === review ? { ...review, stage: "history" } : current);
        return;
      }
      setReview((current) => current === review ? undefined : current);
      if (result === "historyHidden") {
        setNotice("Telegram requires the group’s history to be visible to new members before it can be linked.");
      } else if (result === "unavailable") {
        setNotice("Telegram did not apply the discussion change.");
      } else {
        setChoosing(false);
        setRevision((value) => value + 1);
        setNotice(result === "unknown" ? "Telegram did not confirm the upgrade. Reload eligible groups to check its status."
          : result === "changed" ? "The discussion settings changed. Review the current selection."
          : review.target ? "Discussion group linked." : channel ? "Discussion group unlinked." : "Channel unlinked.");
      }
    } catch {
      setNotice("Could not apply the discussion change.");
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  return <details onToggle={(event) => {
    const expanded = event.currentTarget.open;
    setOpen(expanded);
    if (!expanded) {
      setReview(undefined);
      setChoosing(false);
    }
  }}>
    <summary>{channel ? tr("Discussion group") : tr("Linked channel")}</summary>
    {open && view === undefined && <p role="status">{tr("Loading discussion link…")}</p>}
    {open && view === null && <p>{tr("Discussion settings are unavailable.")}</p>}
    {open && view && <>
      <p>{view.current ? <>{channel ? tr("Linked group") : tr("Linked channel")} · <bdi>{view.current.title}</bdi></>
        : channel ? tr("No discussion group linked.") : tr("No channel linked.")}</p>
      {view.editable && !review && <>
        {channel && <button type="button" className="mtg-action" disabled={busy}
          onClick={() => setChoosing((value) => !value)}>{choosing ? tr("Hide groups") : tr("Choose group")}</button>}
        {view.current && <button type="button" className="mtg-action" disabled={busy}
          onClick={() => setReview({ target: null, expected: view.current })}>{channel ? tr("Unlink group") : tr("Unlink channel")}</button>}
        {choosing && (candidates === undefined ? <p role="status">{tr("Loading eligible groups…")}</p>
          : candidates === null ? <p role="status">{tr("Telegram could not load eligible groups.")}</p>
          : !candidates.length ? <p>{tr("No eligible groups.")}</p>
          : <ul aria-label={tr("Eligible discussion groups")} className="mtg-scheduled-list">
            {candidates.map((target) => <li key={target.id}>
              {target.upgradeRequired && !actions.upgrade ? <p><bdi>{target.title}</bdi>{tr(" · Upgrade to supergroup required")}</p>
                : <button type="button" className="mtg-action" disabled={busy}
                  onClick={() => setReview({ target, expected: view.current, stage: target.upgradeRequired ? "upgrade" : undefined })}>
                  {target.upgradeRequired && tr("Upgrade ")}<bdi>{target.title}</bdi>
                </button>}
            </li>)}
          </ul>)}
      </>}
      {review && <div role="group" aria-label={tr("Confirm discussion change")}>
        <p>{review.stage === "upgrade" ? <>{tr("Upgrade ")}<bdi>{review.target?.title}</bdi>{tr(" to a supergroup? Telegram permanently deactivates the original group.")}</>
          : review.stage === "history" ? <>{tr("Let new members of ")}<bdi>{review.target?.title}</bdi>{tr(" read earlier messages? This change applies even if you cancel linking.")}</>
          : review.target ? <>{tr("Link ")}<bdi>{review.target.title}</bdi>{tr(" as the channel’s discussion group?")}</>
          : <>{tr("Unlink ")}<bdi>{review.expected?.title}</bdi>{tr(" from this ")}{channel ? tr("channel") : "group"}?</>}</p>
        {!review.stage && review.target && review.expected && <p>{tr("This will replace ")}<bdi>{review.expected.title}</bdi>.</p>}
        <button type="button" className="mtg-action" disabled={busy} onClick={() => setReview(undefined)}>{tr("Cancel")}</button>
        <button type="button" className="mtg-action" disabled={busy}
          onClick={() => void confirm()}>{review.stage === "upgrade" ? tr("Confirm upgrade")
            : review.stage === "history" ? tr("Confirm history visibility") : review.target ? tr("Confirm link") : tr("Confirm unlink")}</button>
      </div>}
    </>}
    {open && notice && <p role="status">{tr(notice)}</p>}
  </details>;
}
