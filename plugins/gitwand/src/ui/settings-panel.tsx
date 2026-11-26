// Plugin settings: what runs, and the actions on it.
import type { GitWandStatus } from "../core/contract.ts";

export interface SettingsPanelProps {
  status: GitWandStatus | null;
  error: string | null;
  busy: boolean;
  onRestart: () => void;
  onRollback: () => void;
  onCheckUpdates: () => void;
}

const BRIDGE: Record<GitWandStatus["bridge"]["state"], string> = {
  running: "работает",
  starting: "запускается",
  stopped: "не запущен, запустится при открытии GitWand",
  "no-runtime": "нет рантайма",
  failed: "остановлен после сбоев",
};

function runtimeText(s: GitWandStatus): string {
  if (s.runtime === null) return `не установлен${s.runtimeError ? `: ${s.runtimeError}` : ""}`;
  const source = s.runtime.source === "dev" ? "каталог разработки" : "установлен";
  return `${s.runtime.version} (${source}), GitWand ${s.runtime.commit.slice(0, 7)}`;
}

function updateText(u: GitWandStatus["update"]): string {
  switch (u.state) {
    case "disabled":
      return "выключены: канал не настроен";
    case "unchecked":
      return "не проверялись";
    case "none":
      return "установлена последняя сборка";
    case "available":
      return `доступна ${u.detail ?? ""}`.trim();
    case "needs-plugin":
      return `нужен плагин ${u.detail ?? ""} или новее`;
    case "error":
      return `ошибка: ${u.detail ?? ""}`;
  }
}

export function SettingsPanel({ status, error, busy, onRestart, onRollback, onCheckUpdates }: SettingsPanelProps) {
  const rows: [string, string][] =
    status === null
      ? []
      : [
          ["Рантайм", runtimeText(status)],
          ["Бэкенд", status.bridge.detail && status.bridge.state === "failed" ? `${BRIDGE.failed}: ${status.bridge.detail}` : BRIDGE[status.bridge.state]],
          ["Инструменты", (["git", "gh", "glab"] as const).map((t) => `${t} — ${status.tools[t] ? "есть" : "нет"}`).join(", ")],
          ["Обновления", updateText(status.update)],
        ];
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "6px 16px", margin: 0 }}>
        {rows.map(([label, value]) => [<dt key={`${label}-l`}>{label}</dt>, <dd key={`${label}-v`} style={{ margin: 0 }}>{value}</dd>])}
      </dl>
      {error !== null && <div role="alert">{error}</div>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" disabled={busy} onClick={onRestart}>
          Перезапустить
        </button>
        <button type="button" disabled={busy} onClick={onRollback}>
          Откатить
        </button>
        <button type="button" disabled={busy} onClick={onCheckUpdates}>
          Проверить обновления
        </button>
      </div>
    </div>
  );
}
