import { expect, it } from "vitest";
import { ERROR_REASONS } from "../core/errors.ts";
import { archiveReasonText } from "./archive-text.ts";
import { problemOf } from "./model.ts";

const host = (code: string, reason?: string) =>
  Object.assign(new Error(JSON.stringify({ code, message: "x", retryable: false, ...(reason ? { reason } : {}) })), { code: "invalid" });

it("shows the agreed Russian line for the pairs the owner meets most", () => {
  expect(problemOf(host("invalid_archive", "duplicate_name"))).toEqual({
    code: "invalid_archive", message: "В архиве повторяются имена записей; распаковка невозможна",
  });
  expect(problemOf(host("invalid_archive", "bad_tar")).message).toBe("Архив повреждён или имеет неподдерживаемую структуру");
  expect(problemOf(host("invalid_archive", "crc_mismatch")).message).toBe("Данные записи повреждены (контрольная сумма или размер)");
  expect(problemOf(host("limit_exceeded", "total_bytes")).message).toBe("Превышен предел распаковки (общий размер)");
  expect(problemOf(host("limit_exceeded", "ratio")).message)
    .toBe("Архив сжат сильнее допустимого коэффициента; возможно, это архивная бомба. Поднять предел можно в настройках");
  expect(problemOf(host("auth_failed", "password_required")).message).toBe("Архив зашифрован: введите пароль");
  expect(problemOf(host("auth_failed", "bad_password")).message).toBe("Неверный пароль или повреждённые данные");
  expect(problemOf(host("unsupported", "archives_unavailable")).message).toBe("Архивы недоступны: нет helper для платформы");
  expect(problemOf(host("unsupported", "link_escapes")).message).toBe("Ссылка выходит за каталог назначения");
  expect(problemOf(host("internal", "helper_crashed")).message).toBe("Модуль архивов остановился. Повторите; пароль придётся ввести заново");
});

it("has a line for every allowed code and reason pair, and none for a pair the schema forbids", () => {
  let pairs = 0;
  for (const [code, reasons] of Object.entries(ERROR_REASONS)) {
    for (const reason of reasons) {
      pairs++;
      expect(archiveReasonText(code, reason), `${code}+${reason}`).toEqual(expect.any(String));
    }
  }
  expect(pairs).toBe(39);
  expect(archiveReasonText("invalid_archive", "ratio")).toBeNull();
  expect(archiveReasonText("limit_exceeded", "nope")).toBeNull();
});

it("names a collision of two archive entries on the target in plain words", () => {
  expect(problemOf(host("invalid_archive", "name_collision")).message)
    .toBe("Два элемента архива получают одинаковое имя в каталоге назначения");
});

it("falls back to the code's own line when the reason is unknown, and never prints the host message", () => {
  const problem = problemOf(host("invalid_archive", "nope"));
  expect(problem.code).toBe("invalid_archive");
  expect(problem.message).not.toContain("x");
  expect(problemOf(host("invalid_archive")).message).toBe("Архив повреждён или имеет неподдерживаемую структуру");
});
