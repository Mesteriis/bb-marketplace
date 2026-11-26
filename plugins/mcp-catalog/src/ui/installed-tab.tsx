import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import type { InventoryRowDto } from "../core/contract";
import { messageOf, type CatalogApi, type Notify, type Setup } from "./api";
import { VariablesDialog } from "./install-dialog";
import { Badge, Centered, LoadView, Notice, Row } from "./parts";
import { normaliseStatus, statusLabel } from "./status";
import { useLoad } from "./use-load";

interface Props {
  api: CatalogApi;
  notify: Notify;
  tick: number;
  openUrl: (url: string) => void;
  onChanged: () => void;
  setup: Setup;
}

export function InstalledTab({ api, notify, tick, openUrl, onChanged, setup }: Props) {
  const { state, reload } = useLoad(() => api.inventory(), tick);
  return (
    <LoadView state={state} onRetry={reload}>
      {({ rows, warnings }) => (
        <div className="flex flex-col gap-2">
          {warnings.length > 0 && (
            <div className="flex flex-col gap-1 px-4 pt-2">
              {warnings.map((warning) => (
                <Notice key={warning}>{warning}</Notice>
              ))}
            </div>
          )}
          {rows.length === 0 ? (
            <Centered>
              <p>Серверов пока нет</p>
              <p className="text-xs">Серверы моста Agent Plugins появятся здесь.</p>
            </Centered>
          ) : (
            <ul>
              {rows.map((row) => (
                <ServerRow
                  key={`${row.pluginId}/${row.serverId}`}
                  row={row}
                  api={api}
                  notify={notify}
                  openUrl={openUrl}
                  onChanged={onChanged}
                  canUpdate={setup.repo}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </LoadView>
  );
}

function ServerRow({
  row,
  api,
  notify,
  openUrl,
  onChanged,
  canUpdate,
}: {
  row: InventoryRowDto;
  api: CatalogApi;
  notify: Notify;
  openUrl: (url: string) => void;
  onChanged: () => void;
  canUpdate: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [editing, setEditing] = useState(false);
  const loadVariables = useCallback(() => api.secretsState({ pluginId: row.pluginId }), [api, row.pluginId]);
  const status = normaliseStatus(row.status);
  const ref = { pluginId: row.pluginId, serverId: row.serverId };

  const act = async (work: () => Promise<void>, done?: string) => {
    setBusy(true);
    try {
      await work();
      if (done !== undefined) notify("success", done);
      onChanged();
    } catch (error) {
      notify("error", messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  const signIn = () =>
    act(async () => {
      const { url } = await api.auth(ref);
      if (url === null) notify("info", "Вход не требует адреса");
      else if (isWebUrl(url)) openUrl(url);
      else notify("error", "Сервер вернул адрес входа не http(s): не открываю");
    });

  return (
    <Row>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 truncate text-sm font-medium">{row.serverId}</span>
        <span className="truncate text-xs text-muted-foreground">{row.pluginName}</span>
        <Badge tone={status === "error" ? "danger" : "plain"}>{statusLabel(row.status)}</Badge>
        {!row.enabled && status !== "disabled" && <Badge tone="outline">выключен</Badge>}
        {row.toolCount !== null && <Badge tone="outline">{`${row.toolCount} инструм.`}</Badge>}
        {row.origin === "infra" && <Badge tone="outline">из infra</Badge>}
        {row.origin === "catalog" && <Badge tone="outline">из каталога</Badge>}
        <div className="ml-auto flex flex-wrap items-center gap-1">
          {(status === "needs approval" || !row.approved) && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => api.approve(ref))}>
              Одобрить
            </Button>
          )}
          {status === "needs auth" && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void signIn()}>
              Войти
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => api.setEnabled({ ...ref, enabled: !row.enabled }))}>
            {row.enabled ? "Выключить" : "Включить"}
          </Button>
          {row.origin === "catalog" && row.updateAvailable !== null && (
            <Button size="sm" variant="outline" disabled={busy || !canUpdate} onClick={() => void act(() => api.update({ pluginId: row.pluginId }), "Обновлено")}>
              {`Обновить до ${row.updateAvailable}`}
            </Button>
          )}
          {row.origin === "catalog" && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(true)}>
              Изменить переменные
            </Button>
          )}
          {row.origin === "catalog" && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              className={confirmRemove ? "text-destructive" : undefined}
              onClick={() => {
                if (!confirmRemove) {
                  setConfirmRemove(true);
                  return;
                }
                setConfirmRemove(false);
                void act(() => api.remove({ pluginId: row.pluginId }), "Удалено");
              }}
              onBlur={() => setConfirmRemove(false)}
            >
              {confirmRemove ? "Точно удалить?" : "Удалить"}
            </Button>
          )}
        </div>
      </div>
      {editing && (
        <VariablesDialog
          title={`Переменные ${row.serverId}`}
          description="Пустое поле оставляет значение, «Очистить» удаляет его."
          submitLabel="Сохранить"
          allowClear
          loadVariables={loadVariables}
          submit={async (values, clear) => {
            await api.setSecrets({ pluginId: row.pluginId, values, clear });
            return { ok: true };
          }}
          onDone={() => {
            setEditing(false);
            notify("success", "Переменные сохранены");
            onChanged();
          }}
          onClose={() => setEditing(false)}
        />
      )}
      {row.lastError !== null && row.lastError !== "" && <p className="text-xs text-destructive">{row.lastError}</p>}
    </Row>
  );
}

function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}
