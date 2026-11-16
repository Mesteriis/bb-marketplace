import { useEffect, useState } from "react";
import { privacyAudiences, telegramPrivacyLabels, type TelegramPrivacyAudience, type TelegramPrivacyKey, type TelegramPrivacyView } from "../core/contract.ts";

import type { Chat } from "../core/demo.ts";
import { AutoDeleteTimer, type AutoDeleteActions } from "./default-auto-delete.tsx";
import { ArchivePrivacy, type ArchivePrivacyActions } from "./archive-privacy.tsx";
import { BlockedSenders, type BlockedSenderActions } from "./blocked-senders.tsx";

export type TelegramPrivacyActions = {
  defaultAutoDelete?: AutoDeleteActions;
  archiveSettings?: ArchivePrivacyActions;
  blockedSenders?: BlockedSenderActions;
  loadReadDate: () => Promise<boolean>;
  saveReadDate: (show: boolean, expected: boolean) => Promise<"saved" | "changed" | "unsupported">;
  load: (key: TelegramPrivacyKey) => Promise<TelegramPrivacyView>;
  save: (key: TelegramPrivacyKey, audience: TelegramPrivacyAudience, expected: string) => Promise<"saved" | "changed" | "unsupported">;
};

const audienceLabels = { everyone: "Everybody", contacts: "My contacts", nobody: "Nobody" };

export function TelegramPrivacy({ actions, openChat }: { actions: TelegramPrivacyActions; openChat?: (chat: Chat) => void }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState<TelegramPrivacyKey>("phone");
  const [rule, setRule] = useState<TelegramPrivacyView>();
  const [audience, setAudience] = useState<TelegramPrivacyAudience>();
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    let active = true;
    setRule(undefined);
    setAudience(undefined);
    setError("");
    void actions.load(key).then((result) => {
      if (active) { setRule(result); setAudience(result.audience ?? undefined); }
    }, () => { if (active) setError("Could not load this privacy setting."); });
    return () => { active = false; };
  }, [actions, key, open, reload]);

  async function save() {
    if (!rule || !audience || rule.audience === audience || busy) return;
    setBusy(true);
    setStatus("");
    setError("");
    try {
      const result = await actions.save(key, audience, rule.version);
      if (result === "saved") {
        setStatus("Privacy setting saved.");
        setReload((value) => value + 1);
      } else setError(result === "changed" ? "This setting changed in Telegram. Reload it before saving." : "Telegram did not apply this setting.");
    } catch { setError("Could not save this privacy setting."); }
    finally { setBusy(false); }
  }

  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Privacy</summary>
    {open && <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label>Privacy setting <select value={key} disabled={busy} onChange={(event) => {
        setStatus("");
        setError("");
        setRule(undefined);
        setAudience(undefined);
        setKey(event.target.value as TelegramPrivacyKey);
      }}>
        {Object.entries(telegramPrivacyLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      {!rule && !error && <p role="status">Loading privacy setting…</p>}
      {rule?.audience === null && <p>This setting uses a custom rule combination.</p>}
      {rule?.audience && <>
        <label>Default audience <select value={audience ?? ""} disabled={busy} onChange={(event) =>
          setAudience(event.target.value as TelegramPrivacyAudience)}>
          {privacyAudiences(key).map((value) => <option key={value} value={value}>{audienceLabels[value]}</option>)}
        </select></label>
        {rule.exceptions > 0 && <p>{rule.exceptions} existing exception {rule.exceptions === 1 ? "rule" : "rules"} will be kept.</p>}
        <button type="submit" className="mtg-action" disabled={busy || !audience || rule.audience === audience}>Save privacy</button>
      </>}
      {error && <p role="alert">{error} <button type="button" className="mtg-action" disabled={busy}
        onClick={() => setReload((value) => value + 1)}>Reload setting</button></p>}
      {status && <p role="status">{status}</p>}
    </form>}
    {open && actions.blockedSenders && <BlockedSenders actions={actions.blockedSenders} openChat={openChat} />}
    {open && actions.defaultAutoDelete && <AutoDeleteTimer actions={actions.defaultAutoDelete} />}
    {open && actions.archiveSettings && <ArchivePrivacy actions={actions.archiveSettings} />}
    {open && <ReadDatePrivacy load={actions.loadReadDate} save={actions.saveReadDate} />}
  </details>;
}

function ReadDatePrivacy({ load, save }: {
  load: TelegramPrivacyActions["loadReadDate"];
  save: TelegramPrivacyActions["saveReadDate"];
}) {
  const [current, setCurrent] = useState<boolean>();
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    setCurrent(undefined);
    setError("");
    setNotice("");
    void load().then((value) => {
      if (active) { setCurrent(value); setShow(value); }
    }, () => { if (active) setError("Could not load read time privacy."); });
    return () => { active = false; };
  }, [load, revision]);

  async function submit() {
    if (current === undefined || show === current || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await save(show, current);
      if (result === "saved") {
        setCurrent(show);
        setNotice("Read time privacy saved.");
      } else {
        if (result === "changed") setCurrent(undefined);
        setError(result === "changed" ? "This setting changed in Telegram. Reload it before saving."
          : "Telegram did not apply this setting.");
      }
    } catch { setError("Could not save read time privacy."); }
    finally { setBusy(false); }
  }

  return <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <fieldset>
      <legend>Read time in private chats</legend>
      {current === undefined && !error && <p role="status">Loading read time privacy…</p>}
      {current !== undefined && <>
        <label><input type="checkbox" checked={show} disabled={busy}
          onChange={(event) => setShow(event.target.checked)} /> Share read time</label>
        <p>People who can see your online status can always see when you read messages.
          Without Telegram Premium, hiding read times also limits whose read times you can see.</p>
        <button type="submit" className="mtg-action" disabled={busy || show === current}>Save read time privacy</button>
      </>}
      {error && <p role="alert">{error} <button type="button" className="mtg-action" disabled={busy}
        onClick={() => setRevision((value) => value + 1)}>Reload read time privacy</button></p>}
      {notice && <p role="status">{notice}</p>}
    </fieldset>
  </form>;
}
