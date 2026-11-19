import { describe, expect, it } from "vitest";
import { adviceRu, consoleOffRu, consoleReasonRu, guestStatusRu, outcomeRu } from "./pve-texts.ts";

describe("pve texts", () => {
  it("says in Russian why a console ended, and falls back to the core's line for a code it does not know", () => {
    expect(consoleReasonRu("node_offline")).toBe("Узел не в сети.");
    expect(consoleReasonRu("something_new")).toBe("The console ended (something_new).");
  });

  it("gives the advice for an outcome, with the helper's detail only for a plain error", () => {
    expect(adviceRu("ok", null)).toBeNull();
    expect(adviceRu("empty", null)).toBeNull();
    expect(adviceRu("unreachable", "ignored")).toBe("Сервер Proxmox не ответил. Проверьте адрес, порт и сеть.");
    expect(adviceRu("error", "helper is not running")).toBe("Не удалось прочитать Proxmox. (helper is not running)");
  });

  it("names outcomes and guest states, leaving unknown ones as they are", () => {
    expect(outcomeRu("tls_untrusted")).toBe("сертификат не доверенный");
    expect(outcomeRu("zzz")).toBe("zzz");
    expect(guestStatusRu("running")).toBe("работает");
    expect(guestStatusRu("prelaunch")).toBe("prelaunch");
  });

  it("says why a guest has no console now", () => {
    expect(consoleOffRu({ template: true, status: "stopped" })).toBe("у шаблона нет консоли");
    expect(consoleOffRu({ template: false, status: "stopped" })).toBe("гость выключен; сначала запустите его в Proxmox (Remote Hub гостей не запускает)");
    expect(consoleOffRu({ template: false, status: "running" })).toBeNull();
  });
});
