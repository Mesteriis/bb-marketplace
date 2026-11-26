// Plugin settings: what runs, and the actions on it.
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { GitWandStatus } from "../core/contract.ts";

export interface SettingsPanelProps {
  status: GitWandStatus | null;
  error: string | null;
  busy: boolean;
  onRestart: () => void;
  onRollback: () => void;
  onCheckUpdates: () => void;
  onInstall: (version: string) => void;
}

const BRIDGE: Record<GitWandStatus["bridge"]["state"], string> = {
  running: "работает",
  starting: "запускается",
  stopped: "не запущен, запустится при открытии GitWand",
  "no-runtime": "нет рантайма",
  failed: "остановлен после сбоев",
};

type Tone = "ok" | "muted" | "bad";

function runtimeRow(s: GitWandStatus): [string, Tone] {
  if (s.runtime === null) return [`не установлен${s.runtimeError ? `: ${s.runtimeError}` : ""}`, s.runtimeError ? "bad" : "muted"];
  const source = s.runtime.source === "dev" ? "каталог разработки" : "установлен";
  return [`${s.runtime.version} (${source}), GitWand ${s.runtime.commit.slice(0, 7)}`, "ok"];
}

function bridgeRow(s: GitWandStatus): [string, Tone] {
  if (s.bridge.state === "failed") return [s.bridge.detail ? `${BRIDGE.failed}: ${s.bridge.detail}` : BRIDGE.failed, "bad"];
  return [BRIDGE[s.bridge.state], s.bridge.state === "running" ? "ok" : "muted"];
}

function updateRow(u: GitWandStatus["update"]): [string, Tone] {
  switch (u.state) {
    case "disabled":
      return ["выключены: канал не настроен", "muted"];
    case "unchecked":
      return ["не проверялись", "muted"];
    case "none":
      return ["установлена последняя сборка", "ok"];
    case "available":
      return [`доступна ${u.detail ?? ""}`.trim(), "ok"];
    case "needs-plugin":
      return [`нужен плагин ${u.detail ?? ""} или новее`, "bad"];
    case "error":
      return [`ошибка: ${u.detail ?? ""}`, "bad"];
  }
}

const TONE: Record<Tone, string> = { ok: "text-foreground", muted: "text-muted-foreground", bad: "text-destructive" };

export function SettingsPanel({ status, error, busy, onRestart, onRollback, onCheckUpdates, onInstall }: SettingsPanelProps) {
  const rows: [string, [string, Tone]][] =
    status === null
      ? []
      : [
          ["Рантайм", runtimeRow(status)],
          ["Бэкенд", bridgeRow(status)],
          ["Инструменты", [(["git", "gh", "glab"] as const).map((t) => `${t} — ${status.tools[t] ? "есть" : "нет"}`).join(", "), "muted"]],
          ["Обновления", updateRow(status.update)],
        ];
  const available = status?.update.state === "available" ? status.update.detail : null;
  const needsSource = status !== null && status.runtime === null && status.update.state === "disabled";
  return (
    <div className="flex flex-col gap-4">
      {status === null ? (
        <p className="text-sm text-muted-foreground">Загрузка состояния…</p>
      ) : (
        <dl className="divide-y divide-border rounded-md border border-border text-sm">
          {rows.map(([label, [value, tone]]) => (
            <div key={label} className="grid grid-cols-[8rem_1fr] gap-3 px-3 py-2">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className={`m-0 break-words ${TONE[tone]}`}>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {status?.notice && (
        <div role="status" className="flex items-start gap-2 rounded-md border border-border bg-secondary px-3 py-2 text-sm">
          <Icon name="Info" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span>{status.notice}</span>
        </div>
      )}
      {needsSource && (
        <p role="note" className="text-sm text-muted-foreground">
          Чтобы запустить GitWand, укажите каталог рантайма разработки или канал обновлений с ключом подписи в настройках выше.
        </p>
      )}
      {error !== null && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">
          <Icon name="TriangleAlert" className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {available !== null && (
          <Button size="sm" disabled={busy} onClick={() => onInstall(available)}>
            Установить {available}
          </Button>
        )}
        <Button size="sm" variant="outline" disabled={busy} onClick={onRestart}>
          Перезапустить
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={onRollback}>
          Откатить
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={onCheckUpdates}>
          Проверить обновления
        </Button>
      </div>
    </div>
  );
}
