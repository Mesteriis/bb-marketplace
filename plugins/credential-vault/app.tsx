import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { ImportForm } from "./src/ui/import-form";
import type { ImportSelection } from "./src/core/import-contract";

const labels: Record<string, string> = {
  starting: "Проверяем доступ к хранилищу…",
  ready: "Хранилище открыто",
  missing: "Ключ этой базы отсутствует в Связке ключей",
  approval: "macOS требует разрешить доступ к ключу",
  no_keychain: "Связка ключей по умолчанию недоступна",
  locked: "Разблокируйте Связку ключей macOS",
  unavailable: "Хранилище недоступно",
};

function VaultSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState("starting");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      void rpc.call("vault_status").then(
        (result) => { if (active) setState(result.state); },
        () => { if (active) setState("unavailable"); },
      );
    };
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [rpc]);

  async function unlock() {
    setBusy(true);
    try {
      setState((await rpc.call("vault_unlock")).state);
    } catch {
      setState("unavailable");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p role="status" className="text-sm text-muted-foreground">{labels[state]}</p>
      {state !== "ready" && state !== "starting" && (
        <button type="button" disabled={busy} onClick={() => void unlock()}
          className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
          {busy ? "Ожидаем macOS…" : "Повторить проверку доступа"}
        </button>
      )}
    </div>
  );
}

function VaultImportSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const loadTargets = useCallback(() => rpc.call("vault_import_targets"), [rpc]);
  const importPassword = useCallback((input: ImportSelection) => rpc.call("vault_import_password", input), [rpc]);
  return <ImportForm loadTargets={loadTargets} importPassword={importPassword} />;
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "vault",
    title: "Доступ к хранилищу",
    component: VaultSettings,
  });
  app.slots.settingsSection({
    id: "import",
    title: "Импорт секретов",
    component: VaultImportSettings,
  });
});
