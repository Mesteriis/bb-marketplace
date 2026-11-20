import { useTelegramLocale } from "./i18n/index.tsx";
import { PrivacyExceptions, type PrivacyExceptionActions } from "./privacy-exceptions.tsx";
import { useEffect, useState } from "react";
import { privacyAudiences, telegramPrivacyLabels, type SensitiveContentSettings, type TelegramPrivacyAudience, type TelegramPrivacyKey, type TelegramPrivacyView } from "../core/contract.ts";

import type { Chat } from "../core/demo.ts";
import { AutoDeleteTimer, type AutoDeleteActions } from "./default-auto-delete.tsx";
import { ArchivePrivacy, type ArchivePrivacyActions } from "./archive-privacy.tsx";
import { SecondaryAvatarEditor, type SecondaryAvatarActions } from "./secondary-avatar-editor.tsx";
import { BlockedSenders, type BlockedSenderActions } from "./blocked-senders.tsx";
import { NewChatPrivacy, type NewChatPrivacyActions } from "./new-chat-privacy.tsx";
import { useMiniAppLauncher, type LaunchMiniApp } from "./mini-app.tsx";

export type TelegramPrivacyActions = {
  exceptions?: PrivacyExceptionActions;
  publicPhoto?: SecondaryAvatarActions;
  defaultAutoDelete?: AutoDeleteActions;
  archiveSettings?: ArchivePrivacyActions;
  blockedSenders?: BlockedSenderActions;
  newChatPrivacy?: NewChatPrivacyActions;
  sensitiveContent?: {
    load: () => Promise<SensitiveContentSettings>;
    save: (show: boolean, expected: boolean) => Promise<"saved" | "changed" | "unavailable">;
    launchVerification?: (expectedBot: string) => ReturnType<LaunchMiniApp>;
  };
  loadReadDate: () => Promise<boolean>;
  saveReadDate: (show: boolean, expected: boolean) => Promise<"saved" | "changed" | "unsupported">;
  load: (key: TelegramPrivacyKey) => Promise<TelegramPrivacyView>;
  save: (key: TelegramPrivacyKey, audience: TelegramPrivacyAudience, expected: string) => Promise<"saved" | "changed" | "unsupported">;
};

const audienceLabels = { everyone: "Everybody", contacts: "My contacts", nobody: "Nobody" };

export function TelegramPrivacy({ actions, openChat }: { actions: TelegramPrivacyActions; openChat?: (chat: Chat) => void }) {
  const { t: tr } = useTelegramLocale();
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
    if (!rule || rule.requiresPremium || !audience || rule.audience === audience || busy) return;
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
    <summary>{tr("Privacy")}</summary>
    {open && actions.sensitiveContent && <SensitiveContentControl actions={actions.sensitiveContent} />}
    {open && <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label>{tr("Privacy setting ")}<select value={key} disabled={busy} onChange={(event) => {
        setStatus("");
        setError("");
        setRule(undefined);
        setAudience(undefined);
        setKey(event.target.value as TelegramPrivacyKey);
      }}>
        {Object.entries(telegramPrivacyLabels).map(([value, label]) => <option key={value} value={value}>{tr(label)}</option>)}
      </select></label>
      {!rule && !error && <p role="status">{tr("Loading privacy setting…")}</p>}
      {key === "voiceAndVideoNotes" && <p>{tr("Choose who can send you voice and video messages in private chats.")}</p>}
      {rule?.requiresPremium && <p>{tr("Telegram Premium is required to change this setting.")}</p>}
      {rule?.audience === null && <p>{tr("This setting uses a custom rule combination.")}</p>}
      {rule?.audience && <>
        <label>{tr("Default audience ")}<select value={audience ?? ""} disabled={busy || rule.requiresPremium} onChange={(event) =>
          setAudience(event.target.value as TelegramPrivacyAudience)}>
          {privacyAudiences(key).map((value) => <option key={value} value={value}>{tr(audienceLabels[value])}</option>)}
        </select></label>
        {rule.exceptions > 0 && <p>{rule.exceptions}{tr(" existing exception ")}{rule.exceptions === 1 ? tr("rule") : tr("rules")}{tr(" will be kept.")}</p>}
        <button type="submit" className="mtg-action" disabled={busy || rule.requiresPremium || !audience || rule.audience === audience}>{tr("Save privacy")}</button>
      </>}
      {error && <p role="alert">{tr(error)} <button type="button" className="mtg-action" disabled={busy}
        onClick={() => setReload((value) => value + 1)}>{tr("Reload setting")}</button></p>}
      {status && <p role="status">{tr(status)}</p>}
    </form>}
    {open && key !== "findByPhone" && (key !== "voiceAndVideoNotes" || rule && !rule.requiresPremium)
      && actions.exceptions && <PrivacyExceptions key={key} setting={key}
      actions={actions.exceptions} updated={() => setReload((value) => value + 1)} />}
    {open && key === "photo" && actions.publicPhoto && <SecondaryAvatarEditor label="public profile photo"
      description={tr("People who cannot see your main profile photo can see this public photo.")} actions={actions.publicPhoto} disabled={busy} />}
    {open && actions.blockedSenders && <BlockedSenders actions={actions.blockedSenders} openChat={openChat} />}
    {open && actions.defaultAutoDelete && <AutoDeleteTimer actions={actions.defaultAutoDelete} />}
    {open && actions.archiveSettings && <ArchivePrivacy actions={actions.archiveSettings} />}
    {open && actions.newChatPrivacy && <NewChatPrivacy actions={actions.newChatPrivacy} />}
    {open && <ReadDatePrivacy load={actions.loadReadDate} save={actions.saveReadDate} />}
  </details>;
}

function SensitiveContentControl({ actions }: { actions: NonNullable<TelegramPrivacyActions["sensitiveContent"]> }) {
  const { t: tr } = useTelegramLocale();
  const [current, setCurrent] = useState<SensitiveContentSettings>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const miniApp = useMiniAppLauncher();
  const verificationBot = current?.verificationBot;
  const launchVerification = actions.launchVerification;

  useEffect(() => {
    let active = true;
    setCurrent(undefined);
    setError("");
    void actions.load().then((value) => { if (active) setCurrent(value); },
      () => { if (active) setError("Could not load sensitive content settings."); });
    return () => { active = false; };
  }, [actions, revision]);

  async function change(show: boolean) {
    if (!current?.editable || busy || current.show === show) return;
    setBusy(true);
    setError("");
    try {
      const result = await actions.save(show, current.show);
      if (result === "saved") setCurrent({ ...current, show });
      else {
        setCurrent(undefined);
        setError(result === "changed" ? "This setting changed in Telegram." : "Telegram did not confirm the change.");
      }
    } catch {
      setCurrent(undefined);
      setError("Could not save sensitive content settings.");
    } finally { setBusy(false); }
  }

  return <div>
    <label><input type="checkbox" role="switch" checked={current?.show ?? false}
      disabled={busy || !current?.editable} onChange={(event) => void change(event.currentTarget.checked)} />{tr(" Show 18+ Content")}</label>
    {busy ? <p role="status">{tr("Saving sensitive content settings…")}</p>
      : current ? <p>{current.ageVerificationRequired ? tr("Telegram requires age verification before you can change this setting.")
        : current.editable ? tr("Telegram applies this setting to all your devices.")
          : tr("Telegram does not allow this account to change this setting.")}</p>
        : !error && <p role="status">{tr("Loading sensitive content settings…")}</p>}
    {!busy && current?.ageVerificationRequired && <p>
      {verificationBot && <>
        {launchVerification && <><button type="button" className="mtg-action" onClick={() => miniApp.open({
          target: { label: `Age verification · @${verificationBot}` },
          entryPoint: ["age-verification", verificationBot],
          launch: () => launchVerification(verificationBot),
          checkAgeVerification: async () => {
            const settings = await actions.load();
            return !settings.ageVerificationRequired && settings.editable;
          },
          onClosed: () => setRevision((value) => value + 1),
        })}>{tr("Verify age in BB")}</button>{" "}</>}
        <a href={`https://t.me/${verificationBot}?startapp`} target="_blank" rel="noopener noreferrer">{tr("Verify age in Telegram")}</a>{" "}
      </>}
      <button type="button" className="mtg-action" onClick={() => setRevision((value) => value + 1)}>{tr("Check verification status")}</button>
    </p>}
    {error && <p role="alert">{tr(error)}{" "}
      <button type="button" className="mtg-action" onClick={() => setRevision((value) => value + 1)}>{tr("Reload sensitive content setting")}</button>
    </p>}
    {miniApp.dialog}
  </div>;
}

function ReadDatePrivacy({ load, save }: {
  load: TelegramPrivacyActions["loadReadDate"];
  save: TelegramPrivacyActions["saveReadDate"];
}) {
  const { t: tr } = useTelegramLocale();
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
      <legend>{tr("Read time in private chats")}</legend>
      {current === undefined && !error && <p role="status">{tr("Loading read time privacy…")}</p>}
      {current !== undefined && <>
        <label><input type="checkbox" checked={show} disabled={busy}
          onChange={(event) => setShow(event.target.checked)} />{tr(" Share read time")}</label>
        <p>{tr("People who can see your online status can always see when you read messages. Without Telegram Premium, hiding read times also limits whose read times you can see.")}</p>
        <button type="submit" className="mtg-action" disabled={busy || show === current}>{tr("Save read time privacy")}</button>
      </>}
      {error && <p role="alert">{tr(error)} <button type="button" className="mtg-action" disabled={busy}
        onClick={() => setRevision((value) => value + 1)}>{tr("Reload read time privacy")}</button></p>}
      {notice && <p role="status">{tr(notice)}</p>}
    </fieldset>
  </form>;
}
