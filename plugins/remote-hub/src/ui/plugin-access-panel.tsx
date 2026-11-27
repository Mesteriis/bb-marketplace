// The owner's view of what OTHER plugins may do with saved SSH connections over SFTP: what they ask for, what is
// allowed, what is open right now. Only the owner grants, declines and revokes, and only here. Identifiers, levels and
// times are shown; a file name or a path never reaches this screen.
import { useCallback, useEffect, useState } from "react";
import { errorTextFromMessage } from "../core/rdp-texts.ts";
import type { SftpLevel } from "../core/sftp-contract.ts";

export interface PluginRequestView {
  requestId: string;
  pluginId: string;
  profileId: string;
  level: SftpLevel;
  reason: string | null;
  requestedAt: string;
}
export interface PluginGrantView {
  pluginId: string;
  profileId: string;
  level: SftpLevel;
  grantedAt: string | null;
}
export interface PluginChannelView {
  channelId: string;
  pluginId: string;
  profileId: string;
  openedAt: string;
}
export interface PluginAccessView {
  requests: PluginRequestView[];
  grants: PluginGrantView[];
  channels: PluginChannelView[];
}

export interface PluginAccessApi {
  list: () => Promise<PluginAccessView>;
  grant: (pluginId: string, profileId: string, level: SftpLevel) => Promise<unknown>;
  decline: (requestId: string) => Promise<unknown>;
  revoke: (pluginId: string, profileId: string) => Promise<{ revoked: boolean; channelsClosed: number }>;
  revokeAll: () => Promise<{ revoked: number }>;
}

export const SFTP_LEVEL_TEXT: Record<SftpLevel, string> = {
  read: "Чтение: смотреть папки и скачивать файлы",
  write: "Чтение и запись: ещё загружать, создавать, переименовывать и удалять",
};
export const SFTP_LEVEL_SHORT: Record<SftpLevel, string> = { read: "чтение", write: "чтение и запись" };

/** What the owner is told wherever a plugin's access is decided. */
export const PLUGIN_ACCESS_NOTE =
  "Другой плагин BB может работать с файлами на сервере через сохранённое SSH-подключение — только если вы разрешили это здесь, и только на выбранном уровне. " +
  "Плагин не получает пароль, ключ или путь к ключу: соединение открывает сам Remote Hub. Новый или изменившийся ключ хоста — всегда ваше решение. " +
  "Разрешение действует, пока вы его не отзовёте; отзыв сразу закрывает открытые каналы этого плагина.";

export const pluginText = (id: string): string => `плагин «${id}»`;

/** How long ago, in the owner's words (whole minutes, hours or days). */
export function sinceText(iso: string | null, now: number): string {
  if (iso === null) return "";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return "только что";
  if (minutes < 60) return `${minutes} мин назад`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)} ч назад`;
  return `${Math.floor(minutes / (60 * 24))} дн назад`;
}

export interface PluginAccessPanelProps {
  api: PluginAccessApi;
  /** Names for the profile ids in the lists. */
  profileNames: Map<string, string>;
  onClose: () => void;
  /** Called when the plugin signals a change (a request came, a channel opened or closed). */
  subscribe?: (cb: () => void) => () => void;
  now?: () => number;
}

export function PluginAccessPanel({ api, profileNames, onClose, subscribe, now = Date.now }: PluginAccessPanelProps) {
  const [view, setView] = useState<PluginAccessView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);

  const load = useCallback(async () => {
    try {
      setView(await api.list());
      setProblem(null);
    } catch (e) {
      setProblem(errorTextFromMessage(e instanceof Error ? e.message : String(e)));
    }
  }, [api]);
  useEffect(() => {
    void load();
    const off = subscribe?.(() => void load());
    // Channels open and close on their own; keep the list current while the screen is open.
    const timer = setInterval(() => void load(), 5000);
    return () => {
      off?.();
      clearInterval(timer);
    };
  }, [load, subscribe]);

  const act = (run: () => Promise<unknown>, done: (result: unknown) => string) => {
    setBusy(true);
    setMessage(null);
    void run()
      .then((result) => setMessage(done(result)))
      .catch((e) => setProblem(errorTextFromMessage(e instanceof Error ? e.message : String(e))))
      .finally(() => {
        setBusy(false);
        void load();
      });
  };
  const name = (id: string) => profileNames.get(id) ?? "удалённое подключение";
  const openOf = (g: PluginGrantView) => (view?.channels ?? []).filter((c) => c.pluginId === g.pluginId && c.profileId === g.profileId).length;

  return (
    <section aria-label="Доступ плагинов" className="rh-import rh-agents">
      <div className="rh-import-head">
        <h2>Доступ плагинов к файлам</h2>
        <button type="button" onClick={onClose}>
          Закрыть
        </button>
      </div>
      <p className="rh-hint">{PLUGIN_ACCESS_NOTE}</p>
      {problem !== null && <p className="rh-error" role="alert">{problem}</p>}
      {message !== null && <p role="status" className="rh-hint">{message}</p>}

      <h3>Запросы</h3>
      {view !== null && view.requests.length === 0 && <p className="rh-hint">Ни один плагин сейчас ничего не просит.</p>}
      <ul aria-label="Запросы плагинов">
        {(view?.requests ?? []).map((r) => (
          <li key={r.requestId} className="rh-profile" data-testid="plugin-request">
            <div className="rh-profile-main">
              <strong>
                {pluginText(r.pluginId)} просит доступ к «{name(r.profileId)}»: {SFTP_LEVEL_SHORT[r.level]}
              </strong>
              <span className="rh-profile-endpoint">
                {sinceText(r.requestedAt, now())}
                {r.reason !== null ? " · причина, как её назвал плагин: " + r.reason : ""}
              </span>
            </div>
            <div className="rh-profile-actions">
              <button type="button" disabled={busy} onClick={() => act(() => api.grant(r.pluginId, r.profileId, "read"), () => `Разрешено чтение: ${pluginText(r.pluginId)}, «${name(r.profileId)}».`)}>
                Разрешить чтение
              </button>
              {r.level === "write" && (
                <button type="button" disabled={busy} onClick={() => act(() => api.grant(r.pluginId, r.profileId, "write"), () => `Разрешены чтение и запись: ${pluginText(r.pluginId)}, «${name(r.profileId)}».`)}>
                  Разрешить чтение и запись
                </button>
              )}
              <button type="button" disabled={busy} onClick={() => act(() => api.decline(r.requestId), () => "Запрос отклонён.")}>
                Отклонить
              </button>
            </div>
          </li>
        ))}
      </ul>

      <h3>Разрешено</h3>
      {view !== null && view.grants.length === 0 && <p className="rh-hint">Ни одному плагину ничего не разрешено.</p>}
      <ul aria-label="Разрешения плагинов">
        {(view?.grants ?? []).map((g) => {
          const open = openOf(g);
          return (
            <li key={g.pluginId + "|" + g.profileId} className="rh-profile" data-testid="plugin-grant">
              <div className="rh-profile-main">
                <strong>
                  {pluginText(g.pluginId)} → «{name(g.profileId)}»
                </strong>
                <span className="rh-profile-endpoint">
                  {g.grantedAt !== null ? "разрешено " + sinceText(g.grantedAt, now()) + " · " : ""}
                  {open === 0 ? "сейчас не подключён" : `открыто каналов: ${open}`}
                </span>
              </div>
              <div className="rh-profile-actions">
                <select
                  aria-label={`Уровень: ${pluginText(g.pluginId)}, ${name(g.profileId)}`}
                  value={g.level}
                  disabled={busy}
                  onChange={(e) => {
                    const level = e.target.value as SftpLevel;
                    act(() => api.grant(g.pluginId, g.profileId, level), () => `Уровень изменён: ${SFTP_LEVEL_SHORT[level]}.`);
                  }}
                >
                  {(["read", "write"] as const).map((l) => (
                    <option key={l} value={l}>
                      {SFTP_LEVEL_TEXT[l]}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    act(
                      () => api.revoke(g.pluginId, g.profileId),
                      (result) => {
                        const closed = (result as { channelsClosed: number }).channelsClosed;
                        return closed > 0 ? `Доступ отозван, закрыто каналов: ${closed}.` : "Доступ отозван.";
                      },
                    )
                  }
                >
                  Отозвать
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {view !== null && view.grants.length > 0 && (
        <div className="rh-rule">
          {!confirmAll ? (
            <button type="button" disabled={busy} onClick={() => setConfirmAll(true)}>
              Отозвать всё
            </button>
          ) : (
            <div role="alertdialog" aria-label="Отозвать весь доступ плагинов" className="rh-rule-confirm">
              <p>Все плагины потеряют доступ ко всем подключениям, открытые каналы закроются. Запросы тоже будут сняты.</p>
              <button
                type="button"
                onClick={() => {
                  setConfirmAll(false);
                  act(() => api.revokeAll(), (result) => `Отозвано разрешений: ${(result as { revoked: number }).revoked}.`);
                }}
              >
                Да, отозвать всё
              </button>{" "}
              <button type="button" onClick={() => setConfirmAll(false)}>
                Отмена
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
