import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtemp, rmdir } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const vaultPlugin = "makosh-credential-vault";
const unavailable = { error: "vault_unavailable" } as const;
const maxFrame = 1_048_576;
const ref = z.string().regex(/^rh-cred:v1:[a-z0-9][a-z0-9-]{0,31}:[0-9a-f-]{36}$/);
const value = z.string().min(1).max(131072);
const token = z.string().regex(/^[0-9a-f]{64}$/);
const request = z.discriminatedUnion("op", [
  z.object({ op: z.literal("get"), ref, token }),
  z.object({ op: z.enum(["put", "import"]), ref, token, value }),
]);

export type VaultRequest =
  | { op: "get"; ref: string }
  | { op: "put" | "import"; ref: string; value: string };
type VaultReply = { value: string | null } | { stored: boolean };
type Dispatch = (request: VaultRequest, signal: AbortSignal) => Promise<VaultReply>;

export function dispatchVault(plugins: BbPluginApi["sdk"]["plugins"]): Dispatch {
  return async (request, signal) => {
    const args = { pluginId: vaultPlugin, signal };
    if (request.op === "get") {
      const { secret } = await plugins.callRpc({
        ...args, method: "experimental_get", input: { ref: request.ref },
        outputSchema: z.object({ secret: value.nullable() }),
      });
      return { value: secret };
    }
    return plugins.callRpc({
      ...args, method: request.op === "import" ? "experimental_put_if_absent" : "experimental_put",
      input: { ref: request.ref, secret: request.value },
      outputSchema: z.object({ stored: z.boolean() }),
    });
  };
}

/** A private local socket for credential children. There is no web or agent route. */
export async function startVaultBridge(dispatch: Dispatch, baseDir = "/tmp") {
  // "/tmp" by default on purpose: a unix socket path is limited to about 104 bytes and macOS's per-user temp directory is long.
  // A test (or a sandbox that only allows its own temp directory) names a short one.
  const directory = await mkdtemp(join(baseDir, "bb-rhv-"));
  const path = join(directory, "store.sock");
  const secret = randomBytes(32);
  const nonce = secret.toString("hex");
  const sockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    const abort = new AbortController();
    const chunks: Buffer[] = [];
    let size = 0;
    socket.setTimeout(5_000);
    socket.on("timeout", () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      abort.abort();
      sockets.delete(socket);
      for (const chunk of chunks) chunk.fill(0);
    });
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > maxFrame) socket.destroy();
    });
    socket.once("end", () => {
      void (async () => {
        try {
          const parsed = request.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          if (!parsed.success || !timingSafeEqual(secret, Buffer.from(parsed.data.token, "hex"))) return unavailable;
          const { token: _, ...op } = parsed.data;
          return await dispatch(op, abort.signal);
        } catch {
          return unavailable;
        } finally {
          for (const chunk of chunks) chunk.fill(0);
        }
      })().then((reply) => {
        if (!socket.destroyed) socket.end(JSON.stringify(reply));
      });
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (error) {
    secret.fill(0);
    await rmdir(directory);
    throw error;
  }

  let closing: Promise<void> | undefined;
  return {
    path,
    token: nonce,
    close() {
      return closing ??= (async () => {
        secret.fill(0);
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rmdir(directory);
      })();
    },
  };
}
