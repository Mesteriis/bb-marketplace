import { useCallback, useEffect, useState, type FormEvent } from "react";
import { onePasswordReference, type ImportSelection, type ImportTarget } from "../core/import-contract";

interface Props {
  loadTargets(): Promise<ImportTarget[]>;
  importPassword(input: ImportSelection): Promise<{ imported: true }>;
}

const inputClass = "w-full rounded-md border border-border bg-background px-3 py-2 text-sm";

export function ImportForm({ loadTargets, importPassword }: Props) {
  const [provider, setProvider] = useState<"keychain" | "onepassword">("keychain");
  const [targets, setTargets] = useState<ImportTarget[]>([]);
  const [profileId, setProfileId] = useState("");
  const [reference, setReference] = useState("");
  const [replace, setReplace] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTargets(await loadTargets());
    } catch {
      setTargets([]);
      setError("Remote Hub недоступен или ещё не поддерживает импорт из Credential Vault.");
    } finally {
      setLoading(false);
    }
  }, [loadTargets]);

  useEffect(() => { void refresh(); }, [refresh]);

  const eligible = targets.filter((item) => provider === "keychain" ? item.ref !== null : !item.shared);
  const selected = eligible.find((item) => item.id === profileId);
  const wantsReplacement = provider === "onepassword" && selected?.ref != null;
  const canSubmit = !loading && !busy && selected !== undefined
    && (provider === "keychain" || (onePasswordReference.safeParse(reference).success && (!wantsReplacement || replace)));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || !selected) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await importPassword({
        profileId: selected.id,
        expectedRevision: selected.revision,
        expectedRef: selected.ref,
        source: provider === "keychain"
          ? { kind: "keychain" }
          : { kind: "onepassword", reference: reference.trim(), replace },
      });
      setNotice("Пароль сохранён и проверен в Credential Vault.");
      setReference("");
      setReplace(false);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Импорт не подтверждён.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="max-w-xl space-y-4" onSubmit={(event) => void submit(event)}>
      <div className="space-y-3">
        <fieldset className="flex flex-wrap gap-x-4 gap-y-2 text-sm" disabled={busy}>
          <legend className="mb-2">Источник</legend>
          {([
            ["keychain", "Связка ключей macOS"],
            ["onepassword", "1Password"],
          ] as const).map(([value, label]) => (
            <label key={value} className="flex items-center gap-2">
              <input type="radio" name="vault-import-source" value={value} checked={provider === value} onChange={() => {
                setProvider(value);
                setProfileId("");
                setReplace(false);
                setReference("");
                setError(null);
                setNotice(null);
              }} />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
        {provider === "onepassword" ? (
          <label className="block space-y-1 text-sm">
            <span>Ссылка на пароль в 1Password</span>
            <input type="text" className={inputClass} placeholder="op://сейф/запись/password"
              value={reference} onChange={(event) => { setReference(event.target.value); setReplace(false); }}
              autoComplete="off" spellCheck={false} maxLength={2048} disabled={busy} />
            <span className="block text-xs text-muted-foreground">Скопируйте ссылку для поля пароля из приложения 1Password.</span>
          </label>
        ) : (
          <p className="text-sm text-muted-foreground">Переносит прежний пароль Remote Hub. macOS может запросить доступ к записи.</p>
        )}
        <label className="block space-y-1 text-sm">
          <span>Подключение Remote Hub</span>
          <select className={inputClass} value={selected?.id ?? ""} disabled={loading || busy}
            onChange={(event) => { setProfileId(event.target.value); setReplace(false); setNotice(null); }}>
            <option value="">{loading ? "Загрузка…" : "Выберите подключение"}</option>
            {eligible.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {item.protocol.toUpperCase()} · {item.username ? item.username + "@" : ""}{item.host}
              </option>
            ))}
          </select>
        </label>
        {wantsReplacement && (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={replace} onChange={(event) => setReplace(event.target.checked)} disabled={busy} />
            <span>Заменить сохранённый пароль этого подключения</span>
          </label>
        )}
      </div>
      {!loading && !error && eligible.length === 0 && (
        <p className="text-sm text-muted-foreground">Нет подключений, подходящих для этого источника.</p>
      )}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={!canSubmit}
          className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
          {busy ? "Ожидаем импорт…" : "Импортировать пароль"}
        </button>
        <button type="button" disabled={loading || busy} onClick={() => void refresh()}
          className="rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50">
          Обновить подключения
        </button>
      </div>
    </form>
  );
}
