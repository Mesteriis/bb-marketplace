import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useState } from "react";
import type { RenameTelegramAccount, SelectTelegramAccount, TelegramAccountSelection } from "../core/contract.ts";

export function TelegramAccounts({ load, select, rename, disabled }: {
  load: () => Promise<TelegramAccountSelection>;
  select: (selection: SelectTelegramAccount) => Promise<void>;
  rename: (change: RenameTelegramAccount) => Promise<TelegramAccountSelection>;
  disabled: boolean;
}) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const [accounts, setAccounts] = useState<TelegramAccountSelection>();
  const [label, setLabel] = useState("");
  const [error, setError] = useState(false);
  const [editingLabel, setEditingLabel] = useState<string>();
  const [savingLabel, setSavingLabel] = useState(false);
  const [renameError, setRenameError] = useState(false);
  const selected = accounts?.accounts.find(({ id }) => id === accounts.selected);
  async function saveLabel() {
    const label = editingLabel?.trim();
    if (!selected || !label || label === selected.label || disabled || savingLabel) return;
    setSavingLabel(true);
    setRenameError(false);
    try {
      setAccounts(await rename({ expected: selected.id, previousLabel: selected.label, label }));
      setEditingLabel(undefined);
    } catch { setRenameError(true); }
    finally { setSavingLabel(false); }
  }
  useEffect(() => {
    if (!open) return;
    let active = true;
    setError(false);
    void load().then(
      (result) => { if (active) setAccounts(result); },
      () => { if (active) { setAccounts(undefined); setError(true); } },
    );
    return () => { active = false; };
  }, [load, open]);

  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{tr("Telegram accounts")}</summary>
    {open && (accounts ? <>
      <ul>{accounts.accounts.map(({ id, label }) => <li key={id}>
        {id === accounts.selected ? <strong>{label}{tr(" · selected")}</strong>
          : <button type="button" className="mtg-action" disabled={disabled || savingLabel}
            onClick={() => void select({ expected: accounts.selected, target: { id } })}>{tr("Switch to ")}{label}</button>}
      </li>)}</ul>
      {selected && (editingLabel === undefined ? <button type="button" className="mtg-action" disabled={disabled}
        onClick={() => { setRenameError(false); setEditingLabel(selected.label); }}>{tr("Rename selected account")}</button>
        : <form onSubmit={(event) => { event.preventDefault(); void saveLabel(); }}>
          <label>{tr("Account label ")}<input autoFocus value={editingLabel} maxLength={48} disabled={savingLabel}
            onChange={(event) => setEditingLabel(event.currentTarget.value)} /></label>
          <button type="submit" className="mtg-action" disabled={disabled || savingLabel || !editingLabel.trim() || editingLabel.trim() === selected.label}>{tr("Save account label")}</button>
          <button type="button" className="mtg-action" disabled={savingLabel}
            onClick={() => { setEditingLabel(undefined); setRenameError(false); }}>{tr("Cancel renaming")}</button>
          {renameError && <p role="alert">{tr("Could not rename the Telegram account.")}</p>}
        </form>)}
      {accounts.accounts.length < 10 && <form onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && !savingLabel && label.trim()) void select({ expected: accounts.selected, target: { label: label.trim() } });
      }}>
        <label>{tr("New account label ")}<input value={label} maxLength={48} onChange={(event) => setLabel(event.currentTarget.value)} /></label>
        <button type="submit" className="mtg-action" disabled={disabled || savingLabel || !label.trim()}>{tr("Add Telegram account")}</button>
      </form>}
    </> : error ? <p role="alert">{tr("Could not load Telegram accounts.")}</p> : <p role="status">{tr("Loading Telegram accounts…")}</p>)}
  </details>;
}
