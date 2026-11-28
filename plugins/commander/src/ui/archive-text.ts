import { ERROR_REASONS } from "../core/errors.ts";

/** Russian lines for the archive error pairs (S14 spec §10). The host's own message is never shown. */
const structure = "Архив повреждён или имеет неподдерживаемую структуру";
const unusual = "Архив устроен необычно: превышен предел служебных данных, числа записей или длины имени";
const damaged = "Данные записи повреждены (контрольная сумма или размер)";
const format = "Формат или вариант архива не поддерживается";
const stopped = "Модуль архивов остановился. Повторите; пароль придётся ввести заново";

const lines: Record<string, string> = {
  "consent_required/archive_copy": "Нужно подтверждение копии архива",
  "invalid_archive/name_collision": "Два элемента архива получают одинаковое имя в каталоге назначения",
  "invalid_archive/duplicate_name": "В архиве повторяются имена записей; распаковка невозможна",
  "invalid_archive/crc_mismatch": damaged, "invalid_archive/size_mismatch": damaged, "invalid_archive/aes_auth_failed": damaged,
  "limit_exceeded/meta_too_large": unusual, "limit_exceeded/directory_too_large": unusual,
  "limit_exceeded/too_many_entries": unusual, "limit_exceeded/name_too_long": unusual,
  "limit_exceeded/total_bytes": "Превышен предел распаковки (общий размер)",
  "limit_exceeded/ratio": "Архив сжат сильнее допустимого коэффициента; возможно, это архивная бомба. Поднять предел можно в настройках",
  "limit_exceeded/too_many_streams": "Слишком много одновременных чтений архива; повторите чуть позже",
  "limit_exceeded/too_many_open_archives": "Открыто слишком много архивов (максимум 4)",
  "auth_failed/password_required": "Архив зашифрован: введите пароль",
  "auth_failed/bad_password": "Неверный пароль или повреждённые данные",
  "unsupported/link_not_supported": "Ссылки при распаковке не поддерживаются",
  "unsupported/link_escapes": "Ссылка выходит за каталог назначения",
  "unsupported/encryption_unsupported": "Этот вариант шифрования не поддерживается",
  "unsupported/v7_tar": format, "unsupported/pax_size": format, "unsupported/unsupported_format": format,
  "unsupported/unsupported_compression": format,
  "unsupported/archives_unavailable": "Архивы недоступны: нет helper для платформы",
  "internal/helper_checksum_failed": "Модуль архивов повреждён: контрольная сумма не совпала. Переустановите плагин",
  "internal/helper_version_mismatch": "Модуль архивов несовместим с версией плагина",
  "internal/helper_crashed": stopped, "internal/protocol_error": stopped,
};
for (const reason of ERROR_REASONS.invalid_archive) lines["invalid_archive/" + reason] ??= structure;

export const archiveCodeText: Record<string, string> = { invalid_archive: structure };

export function archiveReasonText(code: string, reason: string): string | null {
  return Object.hasOwn(lines, code + "/" + reason) ? lines[code + "/" + reason]! : null;
}
