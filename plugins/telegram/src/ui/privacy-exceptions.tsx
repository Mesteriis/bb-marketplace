import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useState } from "react";
import type { NamedPrivacyException, PrivacyExceptionChange, PrivacyExceptionPage, TelegramPrivacyKey } from "../core/contract.ts";

export type PrivacyExceptionActions = {
  load: (key: TelegramPrivacyKey, offset: number, version?: string) => Promise<PrivacyExceptionPage | null>;
  search: (query: string) => Promise<NamedPrivacyException[]>;
  change: (change: PrivacyExceptionChange) => Promise<"saved" | "changed" | "unsupported">;
  changePremiumInvites: (version: string, allowed: boolean) => Promise<"saved" | "changed" | "unsupported">;
};

type Review = { choice: NamedPrivacyException; decision: PrivacyExceptionChange["decision"]; action: PrivacyExceptionChange["action"] }
  | { allowPremiumInvites: boolean };
const decisionLabel = { allow: "Always allow", restrict: "Never allow" };

export function PrivacyExceptions({ setting, actions, updated }: {
  setting: TelegramPrivacyKey; actions: PrivacyExceptionActions; updated: () => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<PrivacyExceptionPage>();
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<NamedPrivacyException[]>();
  const [decision, setDecision] = useState<PrivacyExceptionChange["decision"]>("allow");
  const [review, setReview] = useState<Review>();
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [status, setStatus] = useState<"saved" | "changed" | "failed" | "loadFailed">();

  useEffect(() => {
    if (!open) return;
    let active = true;
    setPage(undefined);
    void actions.load(setting, 0).then((value) => {
      if (!active) return;
      if (value) setPage(value);
      else setStatus("loadFailed");
    }, () => { if (active) setStatus("loadFailed"); });
    return () => { active = false; };
  }, [actions, open, setting, revision]);

  const editable = page?.editable === true;
  useEffect(() => {
    const pattern = query.trim();
    setMatches(undefined);
    setSearchError(false);
    if (!open || !editable || pattern.length < 2) return;
    let active = true;
    const timer = setTimeout(() => {
      void actions.search(pattern).then((rows) => { if (active) setMatches(rows); },
        () => { if (active) setSearchError(true); });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [actions, editable, open, query]);

  async function loadMore() {
    if (busy || !page || page.next === null) return;
    setBusy(true);
    const next = await actions.load(setting, page.next, page.version).catch(() => null);
    setBusy(false);
    if (next) setPage({ ...next, entries: [...page.entries, ...next.entries] });
    else setStatus("changed");
  }

  async function confirm() {
    if (!review || !page?.editable || busy || status === "changed") return;
    setBusy(true);
    const result = await ("allowPremiumInvites" in review
      ? actions.changePremiumInvites(page.version, review.allowPremiumInvites)
      : actions.change({ key: setting, target: review.choice.target, version: page.version,
        action: review.action, decision: review.decision })).catch(() => "unsupported" as const);
    setBusy(false);
    setReview(undefined);
    setStatus(result === "unsupported" ? "failed" : result);
    if (result === "saved") {
      setQuery("");
      setRevision((value) => value + 1);
      updated();
    }
  }

  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{tr("Privacy exceptions")}</summary>
    {open && <>
      {!page && status !== "loadFailed" && <p role="status">{tr("Loading privacy exceptions…")}</p>}
      {page && !page.editable && <p>{tr("Telegram uses a rule combination that BB cannot edit here.")}</p>}
      {page?.premiumInvites && (page.premiumInvites.allowed || page.premiumInvites.editable) && <div>
        <p>{tr("Premium users · ")}{page.premiumInvites.allowed ? tr("Always allow") : tr("Follow invitation rules")}</p>
        {page.premiumInvites.editable && <button type="button" className="mtg-action"
          disabled={busy || status === "changed" || !!review} onClick={() => {
            setStatus(undefined);
            setReview({ allowPremiumInvites: !page.premiumInvites?.allowed });
          }}>{page.premiumInvites.allowed ? tr("Remove Premium exception") : tr("Allow invitations from Premium users")}</button>}
      </div>}
      {page?.entries.length === 0 && <p>{tr("No people or groups in the exception list.")}</p>}
      {!!page?.entries.length && <ul aria-label={tr("Privacy exception list")}>
        {page.entries.map(({ target, name, decision }) => <li key={`${decision}:${target.kind}:${target.id}`}>
          <bdi>{name}</bdi> · {decisionLabel[decision]}{target.kind === "group" && tr(" · Group members")}
          {editable && <button type="button" className="mtg-action" aria-label={tr("Remove exception for {0}", [name])}
            disabled={busy || status === "changed" || !!review} onClick={() => {
              setStatus(undefined);
              setReview({ choice: { target, name }, decision, action: "remove" });
            }}>{tr("Remove")}</button>}
        </li>)}
      </ul>}
      {page?.next != null && status !== "changed" && <button type="button" className="mtg-action" disabled={busy || !!review}
        onClick={() => void loadMore()}>{tr("Load more exceptions")}</button>}
      {editable && status !== "changed" && <fieldset disabled={busy || !!review}>
        <legend>{tr("Add privacy exception")}</legend>
        <label>{tr("Rule ")}<select value={decision} onChange={(event) => setDecision(event.currentTarget.value === "restrict" ? "restrict" : "allow")}>
          <option value="allow">{tr("Always allow")}</option><option value="restrict">{tr("Never allow")}</option>
        </select></label>
        <label>{tr("Search people or groups ")}<input type="search" maxLength={128} value={query}
          onChange={(event) => setQuery(event.currentTarget.value)} /></label>
        {searchError && <p role="alert">{tr("Could not search for exception targets.")}</p>}
        {matches?.length === 0 && <p>{tr("No matching people or groups.")}</p>}
        {!!matches?.length && <ul aria-label={tr("Privacy exception targets")}>{matches.map((choice) => <li key={`${choice.target.kind}:${choice.target.id}`}>
          <button type="button" className="mtg-action" onClick={() => { setStatus(undefined); setReview({ choice, decision, action: "add" }); }}>
            <bdi>{choice.name}</bdi>{choice.target.kind === "group" && tr(" · Group members")}
          </button>
        </li>)}</ul>}
      </fieldset>}
      {review && <div role="group" aria-label={tr("Review privacy exception")}>
        {"allowPremiumInvites" in review
          ? <p>{review.allowPremiumInvites
            ? tr("Allow Telegram Premium users to invite you to groups and channels?")
            : tr("Remove the Premium exception for group and channel invitations?")}</p>
          : <p>{review.action === "add" ? decisionLabel[review.decision] : tr("Remove the exception for")} <bdi>{review.choice.name}</bdi>
            {review.choice.target.kind === "group" && tr(" · Group members")}?</p>}
        <button type="button" className="mtg-action" disabled={busy} onClick={() => void confirm()}>{tr("Confirm privacy exception")}</button>
        <button type="button" className="mtg-action" disabled={busy} onClick={() => setReview(undefined)}>{tr("Cancel")}</button>
      </div>}
      {status === "saved" && <p role="status">{tr("Privacy exception saved.")}</p>}
      {status === "failed" && <p role="alert">{tr("Telegram could not apply this privacy exception.")}</p>}
      {(status === "changed" || status === "loadFailed") && <p role="alert">
        {status === "changed" ? tr("Privacy rules changed in Telegram.") : tr("Could not load privacy exceptions.")}
        <button type="button" className="mtg-action" onClick={() => {
          setStatus(undefined); setReview(undefined); setRevision((value) => value + 1);
        }}>{tr("Reload exceptions")}</button>
      </p>}
    </>}
  </details>;
}
