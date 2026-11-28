// Expected failures of the core, as RPC refusals the app shows to the owner.
import { experimental_PluginRpcRefusal } from "@get-bb/plugin-sdk";
import { NotLocal, StoreUnavailable, type StoreUnavailableReason } from "../../core/ports.ts";

const UNAVAILABLE_MESSAGES: Record<StoreUnavailableReason, string> = {
  not_configured:
    "Охрана не найдена: хук охраны Claude Code ещё не создал указатель. Запустите любой тред Claude Code или укажите файл отметки в настройках плагина",
  not_writable: "Файл отметки недоступен для записи",
  locked: "Файл отметки занят другой записью, повторите",
};

/** Expected refusals become RPC refusals; anything else stays an error. */
export function toRefusal(error: unknown): unknown {
  if (error instanceof StoreUnavailable) {
    return new experimental_PluginRpcRefusal({ code: "conflict", message: UNAVAILABLE_MESSAGES[error.reason] });
  }
  if (error instanceof NotLocal) {
    return new experimental_PluginRpcRefusal({
      code: "forbidden",
      message: "Охрана настраивается только на этом Mac",
    });
  }
  return error;
}
