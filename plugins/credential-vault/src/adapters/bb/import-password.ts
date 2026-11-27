import { execFile } from "node:child_process";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { experimental_hostToolchain } from "@get-bb/plugin-sdk/process";
import { experimental_PluginRpcRefusal } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { importTarget, onePasswordReference, type ImportSelection } from "../../core/import-contract";

const pluginId = "makosh-remote-hub";
type Plugins = Pick<BbPluginApi["sdk"]["plugins"], "callRpc">;
type Read = (ref: string, signal: AbortSignal) => Promise<string>;

function refuse(message: string, code: "conflict" | "not_found" = "conflict") {
  return new experimental_PluginRpcRefusal({ code, message });
}

export function readOnePassword(ref: string, signal: AbortSignal): Promise<string> {
  const reference = onePasswordReference.parse(ref);
  const executable = experimental_hostToolchain.resolve("op");
  if (!executable) throw refuse("Установите 1Password CLI и включите интеграцию в приложении 1Password.", "not_found");

  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("OP_")));
  env.OP_BIOMETRIC_UNLOCK_ENABLED = "true";

  return new Promise((resolve, reject) => {
    execFile(executable, ["read", "--no-newline", reference], {
      env, signal, timeout: 60_000, killSignal: "SIGKILL", encoding: "buffer", maxBuffer: 32768,
    }, (error, stdout, stderr) => {
      try {
        if (error || signal.aborted) {
          reject(refuse("1Password не выдал пароль. Проверьте интеграцию CLI и подтверждение в приложении."));
        } else {
          const value = stdout.toString("utf8");
          if (value.length < 1 || value.length > 4096) {
            reject(refuse("Поле 1Password должно содержать пароль длиной до 4096 символов."));
          } else {
            resolve(value);
          }
        }
      } finally {
        stdout.fill(0);
        stderr.fill(0);
      }
    });
  });
}

export function createPasswordImport(plugins: Plugins, read: Read = readOnePassword) {
  async function targets(signal: AbortSignal) {
    return plugins.callRpc({ pluginId, method: "experimental_vault_targets", outputSchema: z.array(importTarget), signal });
  }

  async function importPassword(input: ImportSelection, signal: AbortSignal) {
    const target = (await targets(signal)).find((item) => item.id === input.profileId);
    if (!target || target.revision !== input.expectedRevision || target.ref !== input.expectedRef) {
      throw refuse("Подключение изменилось. Обновите список и выберите его заново.");
    }

    let source: { kind: "keychain" } | { kind: "onepassword"; secret: string; replace: boolean };
    if (input.source.kind === "keychain") {
      if (!target.ref) throw refuse("У подключения нет сохранённого пароля для переноса.");
      source = { kind: "keychain" };
    } else {
      if (target.shared) throw refuse("Пароль закреплён за несколькими подключениями.");
      if (target.ref && !input.source.replace) throw refuse("Подтвердите замену сохранённого пароля.");
      const secret = await read(input.source.reference, signal);
      source = { kind: "onepassword", replace: input.source.replace, secret };
    }
    signal.throwIfAborted();

    try {
      return await plugins.callRpc({
        pluginId, method: "experimental_vault_import",
        input: { profileId: target.id, expectedRevision: target.revision, expectedRef: target.ref, source },
        outputSchema: z.object({ imported: z.literal(true) }), signal,
      });
    } catch {
      throw refuse("Remote Hub не подтвердил импорт. Проверьте доступ к источнику и обновите список подключений.");
    }
  }

  return { targets, importPassword };
}
