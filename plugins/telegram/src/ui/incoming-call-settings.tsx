import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useRef, useState } from "react";

export type IncomingCallSettingsActions = {
  load: () => Promise<boolean | null>;
  save: (enabled: boolean, expected: boolean) => Promise<"saved" | "changed" | "unavailable">;
};

export function IncomingCallSettings({ actions, audioAvailable }: { actions: IncomingCallSettingsActions; audioAvailable?: boolean }) {
  const { t: tr } = useTelegramLocale();
  const [enabled, setEnabled] = useState<boolean | null>();
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    const request = ++generation.current;
    setEnabled(undefined);
    setError("");
    setSaving(false);
    void actions.load().then((value) => {
      if (generation.current === request) setEnabled(value);
    }, () => {
      if (generation.current !== request) return;
      setEnabled(null);
      setError("Could not load incoming call settings.");
    });
    return () => { generation.current++; };
  }, [actions, attempt]);

  async function change(next: boolean) {
    if (typeof enabled !== "boolean" || saving) return;
    const request = ++generation.current;
    setSaving(true);
    setError("");
    try {
      const result = await actions.save(next, enabled);
      if (generation.current !== request) return;
      if (result === "saved") setEnabled(next);
      else {
        setError(result === "changed" ? "The setting changed in Telegram. Reload to see its current value."
          : "Telegram could not confirm the change. Reload to check its current value.");
        setEnabled(null);
      }
    } catch {
      if (generation.current !== request) return;
      setError("Could not save incoming call settings. Reload to check its current value.");
      setEnabled(null);
    } finally {
      if (generation.current === request) setSaving(false);
    }
  }

  return <>
    <h3>{tr("Calls")}</h3>
    {typeof enabled === "boolean" && <label>
      <input type="checkbox" role="switch" checked={enabled} disabled={saving}
        onChange={(event) => void change(event.currentTarget.checked)} />{tr(" Accept incoming calls in BB")}</label>}
    <p>{tr("This setting controls whether Telegram routes incoming calls to the current BB session.")}</p>
    {audioAvailable === false && <p>{tr("Voice calling requires the NTgCalls runtime on the Mac running BB.")}</p>}
    {enabled === undefined && <p role="status">{tr("Loading call settings…")}</p>}
    {saving && <p role="status">{tr("Saving call settings…")}</p>}
    {error && <p role="alert">{tr(error)}</p>}
    {enabled === null && <>
      {!error && <p>{tr("This Telegram session did not report its incoming call setting.")}</p>}
      <button type="button" className="mtg-action" onClick={() => setAttempt((value) => value + 1)}>{tr("Reload call settings")}</button>
    </>}
  </>;
}
