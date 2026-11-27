import { createConnection } from "node:net";
import { describe, expect, it } from "vitest";
import { startVaultBridge, type VaultRequest } from "./vault-bridge.ts";

function request(path: string, request: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const connection = createConnection(path, () => connection.end(JSON.stringify(request)));
    const chunks: Buffer[] = [];
    connection.on("data", (chunk: Buffer) => chunks.push(chunk));
    connection.on("error", reject);
    connection.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
  });
}

describe("native credential vault bridge", () => {
  it("refuses a foreign token and preserves the current value on a legacy import", async () => {
    const values = new Map<string, string>();
    const bridge = await startVaultBridge(async (op: VaultRequest) => {
      if (op.op === "get") return { value: values.get(op.ref) ?? null };
      if (op.op === "import" && values.has(op.ref)) return { stored: false };
      values.set(op.ref, op.value);
      return { stored: true };
    });
    try {
      const ref = "rh-cred:v1:local:00000000-0000-4000-8000-000000000001";
      const send = (op: object) => request(bridge.path, { token: bridge.token, ref, ...op });
      await expect(send({ op: "put", value: "current" })).resolves.toEqual({ stored: true });
      await expect(send({ op: "import", value: "stale" })).resolves.toEqual({ stored: false });
      await expect(send({ op: "get", token: "incorrect" })).resolves.toEqual({ error: "vault_unavailable" });
      await expect(send({ op: "get" })).resolves.toEqual({ value: "current" });
    } finally {
      await bridge.close();
    }
  });
});
