// The Russian texts of Proxmox outcomes for the owner's screens. The core keeps its own English sentences: the same ones
// go to agents in tool results, so they are not changed; a code the list below does not know falls back to the core's text.
import { reasonText } from "../core/pve-console.ts";
import { adviceFor, type PveOutcome } from "../core/pve-targets.ts";

const REASON: Record<string, string> = {
  login_failed: "Proxmox отклонил вход. Откройте подключение и введите пароль заново; Remote Hub сам отклонённый вход не повторяет.",
  no_permission: "Учётной записи нельзя открывать эту консоль. Нужно право VM.Console (гости) или Sys.Console (узел) в Proxmox.",
  unreachable: "Сервер Proxmox не ответил. Проверьте адрес, порт и сеть.",
  timeout: "Proxmox не ответил вовремя.",
  tls_untrusted: "Сертификат сервера не доверенный. Сначала подтвердите его отпечаток в подключении.",
  cert_changed: "Сертификат сервера не тот, который вы подтверждали. Если вы его не меняли, не продолжайте.",
  tfa_required: "Эта учётная запись требует второй фактор, а Remote Hub его не поддерживает.",
  api_error: "Proxmox не смог открыть консоль.",
  protocol_error: "Proxmox ответил так, что Remote Hub его не понял (ошибка websocket).",
  invalid_request: "Эту консоль открыть нельзя.",
  unsupported_console: "Такой вид консоли для этого гостя не поддерживается.",
  guest_stopped: "Гость не запущен; Remote Hub никогда его не запускает.",
  guest_is_template: "У шаблона нет консоли.",
  guest_not_found: "Этого гостя в подключении больше нет.",
  guest_moved: "Гость переехал на другой узел; откройте консоль из списка заново.",
  no_credential: "У этого подключения ещё нет сохранённого пароля или токена.",
  websocket_error: "Соединение с консолью оборвалось (ошибка websocket).",
  remote_closed: "Proxmox закрыл консоль.",
  upstream_stalled: "Proxmox перестал принимать ввод для консоли, поэтому она закрыта.",
  engine_exited: "Процесс консоли неожиданно завершился.",
  helper_exited: "Помощник Remote Hub завершился.",
  node_offline: "Узел не в сети.",
  idle_timeout: "Закрыта, потому что на неё никто не смотрел.",
  viewer_too_slow: "Экран не успевал за консолью, поэтому консоль закрыта (графический поток не прореживается). Откройте её заново.",
  viewer_failed: "Графический экран не запустился или перестал работать, поэтому консоль закрыта. Откройте её заново.",
  vnc_start_timeout: "Proxmox закрыл графическую консоль раньше, чем она что-то показала (его прокси VNC ждёт экран около десяти секунд). Вторая попытка тоже не удалась. «Переподключить» откроет новую.",
  view_closed: "Графический экран закрыт, и консоль закрыта вместе с ним. Откройте её заново, чтобы получить новую.",
  vnc_buffer_overflow: "Консоль отправила данные раньше, чем подключился экран, поэтому она закрыта.",
  vnc_view_taken: "Эта консоль уже открыта на другом экране.",
  vnc_not_resumable: "К этой графической консоли нельзя подключиться повторно; отключите её и откройте заново.",
};

const ADVICE: Record<Exclude<PveOutcome, "ok" | "empty">, string> = {
  no_permission: "Учётной записи нельзя читать список гостей. Дайте ей VM.Audit (и VM.Console для консолей) в Proxmox или запустите настройку пользователя с урезанными правами заново.",
  login_failed: "Proxmox отклонил вход. Проверьте пользователя и пароль (или токен) в этом подключении; Remote Hub отклонённый вход не повторяет.",
  unreachable: "Сервер Proxmox не ответил. Проверьте адрес, порт и сеть.",
  tls_untrusted: "Сертификат сервера не доверенный. Сравните отпечаток с тем, что показывает Proxmox, и подтвердите его, чтобы доверять этому серверу.",
  cert_changed: "Сертификат сервера не тот, который вы подтверждали. Если вы его не меняли, не продолжайте.",
  tfa_required: "Эта учётная запись требует второй фактор, а Remote Hub его не поддерживает. Используйте настройку пользователя с урезанными правами или учётную запись без него.",
  no_credential: "У этого подключения ещё нет сохранённого пароля или токена. Добавьте его в настройках подключения.",
  keychain_locked: "Связка ключей «Вход» заблокирована. Разблокируйте её (в «Связке ключей» или войдя заново) и обновите список.",
  keychain_needs_approval: "macOS не разрешил этой сборке Remote Hub читать сохранённый пароль (помощник обновился). Нажмите «Разрешить доступ» и выберите «Всегда разрешать» в диалоге macOS.",
  error: "Не удалось прочитать Proxmox.",
};

const OUTCOME: Record<Exclude<PveOutcome, "ok" | "empty">, string> = {
  no_permission: "нет прав", login_failed: "вход отклонён", unreachable: "сервер недоступен", tls_untrusted: "сертификат не доверенный", cert_changed: "сертификат изменился",
  tfa_required: "нужен второй фактор", no_credential: "нет сохранённого пароля", keychain_locked: "Связка ключей заблокирована", keychain_needs_approval: "нужно разрешение macOS", error: "ошибка",
};

const GUEST_STATUS: Record<string, string> = { running: "работает", stopped: "выключен", paused: "на паузе", suspended: "приостановлен" };

/** Why a console ended or could not be opened, for the owner. */
export function consoleReasonRu(code: string): string {
  return REASON[code] ?? reasonText(code);
}

/** What to do about a connection whose lists could not be read; null when there is nothing to do. */
export function adviceRu(outcome: PveOutcome, detail: string | null): string | null {
  if (outcome === "ok" || outcome === "empty") return null;
  const base = ADVICE[outcome];
  if (base === undefined) return adviceFor(outcome, detail);
  return detail !== null && detail !== "" && outcome === "error" ? `${base} (${detail})` : base;
}

/** A short name of an outcome code for a list row; an unknown code is shown as it is. */
export function outcomeRu(outcome: string): string {
  return (OUTCOME as Record<string, string>)[outcome] ?? outcome;
}

export function guestStatusRu(status: string): string {
  return GUEST_STATUS[status] ?? status;
}

/** Why a guest's console cannot be opened now; null when it can. */
export function consoleOffRu(guest: { template: boolean; status: string }): string | null {
  if (guest.template) return "у шаблона нет консоли";
  if (guest.status !== "running") return `гость ${guestStatusRu(guest.status)}; сначала запустите его в Proxmox (Remote Hub гостей не запускает)`;
  return null;
}
