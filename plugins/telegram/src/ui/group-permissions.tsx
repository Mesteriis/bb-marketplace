import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useState } from "react";
import { groupPermissionLabels, type GroupPermission, type GroupPermissionChange, type GroupPermissionsView } from "../core/contract.ts";

export type GroupPermissionActions = {
  load: (id: string) => Promise<GroupPermissionsView | null>;
  save: (id: string, changes: GroupPermissionChange[]) => Promise<"saved" | "changed" | "unavailable">;
};

const fields = Object.keys(groupPermissionLabels) as GroupPermission[];

export function GroupPermissions({ chatId, actions }: { chatId: string; actions: GroupPermissionActions }) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<GroupPermissionsView | null>();
  const [draft, setDraft] = useState<GroupPermissionsView["values"]>({});
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoaded(undefined);
    setError("");
    void actions.load(chatId).then(
      (result) => {
        if (!active) return;
        setLoaded(result);
        setDraft(result?.values ?? {});
      },
      () => { if (active) setError("Could not load group permissions."); },
    );
    return () => { active = false; };
  }, [open, chatId, actions, revision]);

  const changes: GroupPermissionChange[] = [];
  for (const key of fields) {
    const expected = loaded?.values[key];
    const enabled = draft[key];
    if (typeof expected === "boolean" && typeof enabled === "boolean" && expected !== enabled) {
      changes.push({ key, expected, enabled });
    }
  }

  async function save() {
    if (!loaded?.editable || !changes.length || busy) return;
    setBusy(true);
    setStatus("");
    setError("");
    try {
      const result = await actions.save(chatId, changes);
      if (result === "saved") {
        setStatus("Group permissions saved.");
        setRevision((value) => value + 1);
      } else setError(result === "changed" ? "Telegram permissions changed. Reload them before saving again." : "You cannot change these permissions.");
    } catch { setError("Telegram could not save these permissions."); }
    finally { setBusy(false); }
  }

  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{tr("Member permissions")}</summary>
    {open && <>
      {loaded === undefined && !error && <p role="status">{tr("Loading permissions…")}</p>}
      {loaded === null && <p>{tr("Member permissions are unavailable.")}</p>}
      {loaded && <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <fieldset disabled={!loaded.editable || busy}>
          <legend>{tr("Default permissions")}</legend>
          {fields.map((key) => typeof draft[key] === "boolean" && <label key={key}>
            <input type="checkbox" checked={draft[key]} onChange={(event) =>
              setDraft((previous) => ({ ...previous, [key]: event.target.checked }))} /> {tr(groupPermissionLabels[key])}
          </label>)}
        </fieldset>
        {loaded.editable && <button type="submit" className="mtg-action" disabled={busy || changes.length === 0}>{tr("Save permissions")}</button>}
      </form>}
      {error && <p role="alert">{tr(error)} <button type="button" className="mtg-action" disabled={busy}
        onClick={() => setRevision((value) => value + 1)}>{tr("Reload permissions")}</button></p>}
      {status && <p role="status">{tr(status)}</p>}
    </>}
  </details>;
}
