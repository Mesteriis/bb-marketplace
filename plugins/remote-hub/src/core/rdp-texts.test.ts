import { describe, expect, it } from "vitest";
import { RDP_CLOSED_REASONS, RDP_ERROR_CODES, RDP_STATES } from "./rdp-protocol.ts";
import { closeReasonText, errorCodeText, errorTextFromMessage, formatCertTime, promptReasonText, stateText } from "./rdp-texts.ts";

describe("rdp texts", () => {
  it("has a sentence for every close reason the service can return", () => {
    for (const reason of [...RDP_CLOSED_REASONS, "helper_exited", "exited"]) {
      expect(closeReasonText(reason), reason).not.toMatch(/^closed: /);
    }
    expect(closeReasonText("auth_failed")).toBe("вход не удался: проверьте пользователя, пароль и домен");
    expect(closeReasonText("killed_by_close")).toBe("отключено");
    expect(closeReasonText("server_disconnected")).toBe("сервер завершил сессию");
    expect(closeReasonText("network_error")).toBe("ошибка сети: сервер недоступен или соединение оборвалось");
    expect(closeReasonText("engine_exited")).toBe("движок RDP неожиданно остановился");
    expect(closeReasonText("cert_rejected")).toBe("сертификат сервера отклонён");
    expect(closeReasonText("something_new")).toBe("закрыто: something_new");
    expect(closeReasonText(null)).toBe("сессия завершилась");
  });

  it("has a text for every helper error code the TS layer expects, and passes unknown codes through", () => {
    for (const code of RDP_ERROR_CODES) expect(errorCodeText(code), code).not.toBe(code);
    expect(errorCodeText("not_ready")).toBe("рабочий стол ещё не готов");
    expect(errorCodeText("screenshot_too_large")).toBe("снимок экрана слишком велик для отправки");
    expect(errorCodeText("session_closed")).toBe("сессия завершилась");
    expect(errorCodeText("mystery")).toBe("mystery");
  });

  it("reads the code the RPC layer puts in front of a helper refusal", () => {
    expect(errorTextFromMessage("not_ready: the desktop is not ready yet")).toBe("рабочий стол ещё не готов");
    expect(errorTextFromMessage("screenshot_too_large: too big")).toBe("снимок экрана слишком велик для отправки");
    expect(errorTextFromMessage("keychain_locked: the Keychain is locked")).toMatch(/Связка ключей «Вход» заблокирована/);
    expect(errorTextFromMessage("credential_target_mismatch: x")).toMatch(/другому хосту или пользователю/);
    expect(errorTextFromMessage("credential_missing: gone")).toMatch(/больше нет в Связке ключей/);
    expect(errorTextFromMessage("connection refused")).toBe("connection refused");
    expect(errorTextFromMessage("whatever: text")).toBe("whatever: text");
  });

  it("has a text for every state", () => {
    expect(RDP_STATES.map(stateText)).toEqual([
      "подключение",
      "защита соединения (TLS)",
      "ждёт вашего решения о сертификате сервера",
      "вход",
      "рабочий стол готов",
    ]);
    expect(stateText("closed")).toBe("закрыто");
    expect(stateText("idle")).toBe("не подключено");
    expect(stateText("error")).toBe("ошибка");
    expect(stateText("brand_new")).toBe("brand_new");
  });

  it("formats certificate validity from epoch seconds in UTC and leaves other text alone", () => {
    expect(formatCertTime("1794882534")).toBe("2026-11-17 02:28:54 UTC");
    expect(formatCertTime("1826418534")).toBe("2027-11-17 02:28:54 UTC");
    expect(formatCertTime("2026-01-01T00:00:00Z")).toBe("2026-01-01T00:00:00Z");
  });

  it("explains every prompt reason, cert_changed in capitals for the difference", () => {
    expect(promptReasonText("cert_changed")).toBe(
      "это ДРУГОЙ сертификат, не тот, которому вы доверяли для этого хоста и порта. Сохранённый пароль ему не отправляется. Если сервер действительно получил новый сертификат, примите его один раз или забудьте старый (экран «Импорт», «Сертификаты RDP, которым вы доверяете») и доверьтесь новому.",
    );
    expect(promptReasonText("untrusted_root")).toBe("сертификат не подписан корневым сертификатом, которому доверяет этот Mac");
    expect(promptReasonText("hostname_mismatch")).toBe("сертификат выдан для другого имени хоста");
    expect(promptReasonText("expired")).toBe("срок действия сертификата истёк или ещё не начался");
    expect(promptReasonText("zzz")).toBe("сертификат не удалось проверить (zzz)");
  });
});
