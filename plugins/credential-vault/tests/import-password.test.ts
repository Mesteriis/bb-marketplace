import { describe, expect, mock, test } from "bun:test";
import { createPasswordImport } from "../src/adapters/bb/import-password";
import { onePasswordReference, type ImportSelection } from "../src/core/import-contract";

const target = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Test RDP",
  protocol: "rdp",
  host: "test.example",
  username: "fixture",
  ref: "rh-fixture-ref",
  revision: "fixture-revision",
  shared: false,
} as const;
const signal = new AbortController().signal;
const input: ImportSelection = {
  profileId: target.id,
  expectedRevision: target.revision,
  expectedRef: target.ref,
  source: { kind: "onepassword", reference: "op://Fixture vault/Test entry/password", replace: true },
};

function fixture() {
  const read = mock(async () => "  synthetic payload  ");
  const call = mock(async ({ method }: { method: string }) => method === "experimental_vault_targets" ? [target] : { imported: true });
  return { call, read, api: createPasswordImport({ callRpc: call as never }, read) };
}

describe("password import", () => {
  test("sends only the selected password to the Remote Hub backend and returns the receipt", async () => {
    const { api, call, read } = fixture();
    await expect(api.importPassword(input, signal)).resolves.toEqual({ imported: true });
    expect(read).toHaveBeenCalledWith("op://Fixture vault/Test entry/password", signal);
    expect(call.mock.calls[1]?.[0]).toMatchObject({
      pluginId: "makosh-remote-hub",
      method: "experimental_vault_import",
      input: { profileId: target.id, expectedRef: target.ref, expectedRevision: target.revision,
        source: { kind: "onepassword", secret: "  synthetic payload  ", replace: true } },
    });
  });

  test("does not authorize 1Password for stale targets or an unconfirmed replacement", async () => {
    const { api, call, read } = fixture();
    await expect(api.importPassword({ ...input, expectedRef: null }, signal)).rejects.toThrow("Подключение изменилось");
    await expect(api.importPassword({ ...input,
      source: { kind: "onepassword", reference: "op://Vault/Item/password", replace: false } }, signal)).rejects.toThrow("Подтвердите замену");
    expect(read).not.toHaveBeenCalled();
    expect(call.mock.calls.map(([request]) => request.method)).toEqual(["experimental_vault_targets", "experimental_vault_targets"]);
  });

  test("requests migration of a single Keychain record without reading a secret in Vault settings", async () => {
    const { api, call, read } = fixture();
    await expect(api.importPassword({ ...input, source: { kind: "keychain" } }, signal)).resolves.toEqual({ imported: true });
    expect(read).not.toHaveBeenCalled();
    expect(call.mock.calls[1]?.[0]).toMatchObject({
      method: "experimental_vault_import",
      input: { expectedRef: target.ref, source: { kind: "keychain" } },
    });
  });

  test("accepts field references and rejects commands, query strings and missing fields", () => {
    for (const ref of ["op://Vault/Item/password", "op://Vault/Item/Section/Field"]) {
      expect(onePasswordReference.safeParse(ref).success).toBe(true);
    }
    for (const ref of ["--help", "op://Vault/Item", "op://Vault/Item/password?attribute=otp", "op://Vault/Item/pass\nword"]) {
      expect(onePasswordReference.safeParse(ref).success).toBe(false);
    }
  });
});
