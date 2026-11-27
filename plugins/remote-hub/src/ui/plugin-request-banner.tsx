// A standing notice while another plugin waits for the owner's answer about SFTP access: shown wherever the owner is in
// BB, so a request is never decided by nobody noticing it. The answer itself is the owner's click here or on the screen.
import { useCallback, useEffect, useRef, useState } from "react";
import { pluginText, SFTP_LEVEL_SHORT, type PluginAccessApi, type PluginRequestView } from "./plugin-access-panel.tsx";

const POLL_MS = 15_000;

export interface PluginRequestBannerApi extends Pick<PluginAccessApi, "list" | "grant" | "decline"> {
  /** Names of the saved connections, by id. */
  names: () => Promise<Map<string, string>>;
  /** Opens the "Plugin access" screen. */
  open: () => void;
  subscribe: (cb: () => void) => () => void;
}

export function PluginRequestBanner({ api }: { api: PluginRequestBannerApi }) {
  const [requests, setRequests] = useState<PluginRequestView[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const apiRef = useRef(api);
  apiRef.current = api;
  const refresh = useCallback(() => {
    apiRef.current
      .list()
      .then(async (view) => {
        setRequests(view.requests);
        if (view.requests.length > 0) setNames(await apiRef.current.names());
      })
      .catch(() => undefined); // the banner stays as it was; the screen shows the details
  }, []);
  useEffect(() => {
    refresh();
    const off = api.subscribe(refresh);
    const timer = setInterval(refresh, POLL_MS);
    return () => {
      off();
      clearInterval(timer);
    };
  }, [api, refresh]);
  if (requests.length === 0) return null;
  const act = (run: () => Promise<unknown>) => {
    setBusy(true);
    void run()
      .catch(() => undefined)
      .finally(() => {
        setBusy(false);
        refresh();
      });
  };
  return (
    <div className="rh-agent-banner rh-plugin-banner" role="region" aria-label="Запросы плагинов на доступ к файлам">
      {requests.map((r) => (
        <div key={r.requestId} role="status" className="rh-agent-banner-row" data-testid="plugin-request-banner-row">
          <span>
            {pluginText(r.pluginId)} просит доступ к файлам на «{names.get(r.profileId) ?? "удалённое подключение"}»: {SFTP_LEVEL_SHORT[r.level]}.
          </span>
          <button type="button" disabled={busy} onClick={() => act(() => api.grant(r.pluginId, r.profileId, "read"))}>
            Разрешить чтение
          </button>
          {r.level === "write" && (
            <button type="button" disabled={busy} onClick={() => act(() => api.grant(r.pluginId, r.profileId, "write"))}>
              Чтение и запись
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => act(() => api.decline(r.requestId))}>
            Отклонить
          </button>
          <button type="button" className="rh-link" onClick={api.open}>
            Все разрешения
          </button>
        </div>
      ))}
    </div>
  );
}
