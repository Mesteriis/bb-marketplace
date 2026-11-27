// Host-free texts for the RDP page: a sentence for every state, every close
// reason and every error code the service can return, plus the certificate
// validity format. Same plain, lowercase-label tone as the SSH page.

export function stateText(state: string): string {
  switch (state) {
    case "idle":
      return "не подключено";
    case "error":
      return "ошибка";
    case "connecting":
      return "подключение";
    case "tls":
      return "защита соединения (TLS)";
    case "cert_prompt":
      return "ждёт вашего решения о сертификате сервера";
    case "authenticating":
      return "вход";
    case "desktop_ready":
      return "рабочий стол готов";
    case "closed":
      return "закрыто";
    default:
      return state;
  }
}

const CLOSE_REASONS: Record<string, string> = {
  auth_failed: "вход не удался: проверьте пользователя, пароль и домен",
  cert_rejected: "сертификат сервера отклонён",
  cert_changed: "сертификат сервера не тот, что ожидался",
  tls_error: "не удалось установить защищённое соединение (TLS)",
  protocol_error: "сессия RDP нарушила протокол",
  network_error: "ошибка сети: сервер недоступен или соединение оборвалось",
  timeout: "время ожидания соединения истекло",
  killed_by_close: "отключено",
  engine_exited: "движок RDP неожиданно остановился",
  helper_shutdown: "помощник Remote Hub завершил работу",
  helper_exited: "помощник Remote Hub завершился",
  server_disconnected: "сервер завершил сессию",
  exited: "сессия завершилась",
};

export function closeReasonText(reason: string | null): string {
  if (reason === null) return "сессия завершилась";
  return CLOSE_REASONS[reason] ?? "закрыто: " + reason;
}

const ERROR_CODES: Record<string, string> = {
  not_ready: "рабочий стол ещё не готов",
  session_closed: "сессия завершилась",
  session_not_found: "сессии больше нет",
  screenshot_too_large: "снимок экрана слишком велик для отправки",
  screenshot_busy: "снимок экрана уже делается",
  fingerprint_mismatch: "решение относится не к тому сертификату, который показан",
  no_pending_prompt: "решения о сертификате сейчас не требуется",
  rdp_input_overflow: "ввод приходит быстрее, чем сессия его принимает; часть отброшена",
  rdp_invalid_geometry: "такой размер рабочего стола не допускается",
  rdp_open_failed: "не удалось запустить сессию RDP",
  response_too_large: "ответ слишком велик для отправки",
  bad_control: "страница отправила сообщение, которое служба не поняла",
  protocol_error: "помощник ответил не по порядку",
  helper_exited: "помощник Remote Hub завершился",
  keychain_locked: "Связка ключей «Вход» заблокирована, или macOS не разрешил этой сборке Remote Hub читать сохранённый пароль. Разблокируйте связку (в «Связке ключей» или войдя заново), затем нажмите «Разрешить доступ» на экране «Учётные данные».",
  keychain_needs_approval: "macOS не разрешил этой сборке Remote Hub читать сохранённый пароль (помощник обновился). Откройте «Учётные данные», нажмите «Разрешить доступ» и выберите «Всегда разрешать» в диалоге macOS.",
  allow_timed_out: "macOS не дождался ответа на свой диалог. Нажмите «Разрешить доступ» ещё раз.",
  keychain_denied: "Связка ключей отказала в доступе к сохранённому паролю.",
  vault_unavailable: "Credential Vault недоступен. Проверьте его состояние в BB и повторите попытку.",
  keychain_unavailable: "Связка ключей на этом Mac недоступна.",
  credential_missing: "Сохранённого пароля больше нет в Связке ключей. Откройте настройки подключения и сохраните его заново.",
  profile_needs_config: "Это подключение идёт через вашу конфигурацию SSH (прокси или правило Match), поэтому пароль для него сохранить нельзя.",
  credential_unbound: "Этот пароль сохранён старой версией и не привязан к хосту. Откройте настройки подключения и сохраните его заново.",
  invalid_bind: "Сохранённый пароль не удалось привязать к его хосту.",
  credential_unknown: "Такого сохранённого пароля больше нет.",
  credential_target_mismatch: "Этот сохранённый пароль принадлежит другому хосту или пользователю, поэтому не использован.",
  credential_exists: "У этого подключения уже есть сохранённый пароль; замените его.",
  credential_not_applicable: "Это подключение не использует сохранённый пароль.",
  ssh_credential_rejected: "Сервер отклонил сохранённый пароль или парольную фразу. Попытка была одна, повторов нет. Сохраните верный в настройках подключения.",
  prompt_expired: "На вопрос не ответили вовремя, и он отклонён.",
  prompt_gone: "Этот вопрос уже закрыт.",
  empty_secret: "Сначала введите пароль.",
  invalid_credential_source: "Используйте либо сохранённый пароль, либо введённый, но не оба.",
};

export function errorCodeText(code: string): string {
  return ERROR_CODES[code] ?? code;
}

/** The RPC layer prefixes a helper refusal with its code ("not_ready: …"). */
export function errorTextFromMessage(message: string): string {
  const match = /^([a-z][a-z_]*): /.exec(message);
  if (match !== null && match[1] in ERROR_CODES) return ERROR_CODES[match[1]];
  return message;
}

/** The helper sends certificate validity as epoch seconds; show it as UTC. */
export function formatCertTime(value: string): string {
  if (!/^\d{1,12}$/.test(value)) return value;
  const date = new Date(Number(value) * 1000);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

const PROMPT_REASONS: Record<string, string> = {
  untrusted_root: "сертификат не подписан корневым сертификатом, которому доверяет этот Mac",
  hostname_mismatch: "сертификат выдан для другого имени хоста",
  expired: "срок действия сертификата истёк или ещё не начался",
  other: "сертификат не удалось проверить",
  first_use: "это первое использование сохранённого пароля",
  cert_changed: "это ДРУГОЙ сертификат, не тот, которому вы доверяли для этого хоста и порта. Сохранённый пароль ему не отправляется. Если сервер действительно получил новый сертификат, примите его один раз или забудьте старый (экран «Импорт», «Сертификаты RDP, которым вы доверяете») и доверьтесь новому.",
};

export function promptReasonText(reason: string): string {
  return PROMPT_REASONS[reason] ?? "сертификат не удалось проверить (" + reason + ")";
}
