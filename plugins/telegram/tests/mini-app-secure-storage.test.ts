import { expect, test, vi } from "vitest";
import { createMiniAppSecureStorage } from "../src/adapters/bb/mini-app-secure-storage.ts";

test("isolates secure storage by profile, Telegram account and bot without exposing identities to Keychain", async () => {
  const run = vi.fn<NonNullable<Parameters<typeof createMiniAppSecureStorage>[1]>>(async () => ({ status: "ok" as const, value: null }));
  const operation = { kind: "get" as const, key: "fixture" };
  const store = createMiniAppSecureStorage("/fixture/profile", run);
  await store("account-one", 54, operation);
  await store("account-one", 55, operation);
  await store("account-two", 54, operation);
  await createMiniAppSecureStorage("/fixture/other-profile", run)("account-one", 54, operation);
  await createMiniAppSecureStorage("/fixture/profile/.", run)("account-one", 54, operation);
  const requests = run.mock.calls.map(([request]) => request);
  expect(new Set(requests.slice(0, 4).map(({ namespace }) => namespace)).size).toBe(4);
  expect(requests[4]!.namespace).toBe(requests[0]!.namespace);
  for (const request of requests) expect(request.namespace).toMatch(/^[a-f0-9]{64}$/);
});

test("rejects malformed secure-storage operations and contains native failures", async () => {
  const run = vi.fn(async () => { throw new Error("Synthetic native failure"); });
  const store = createMiniAppSecureStorage("/fixture/profile", run);
  const operation = { kind: "get" as const, key: "fixture" };
  await expect(store("", 54, operation)).resolves.toMatchObject({ status: "failed" });
  await expect(store("account", 0, operation)).resolves.toMatchObject({ status: "failed" });
  await expect(store("account", 54, { ...operation, key: "../outside" })).resolves.toMatchObject({ status: "failed" });
  expect(run).not.toHaveBeenCalled();
  await expect(store("account", 54, operation)).resolves.toEqual({ status: "failed", error: "UNKNOWN_ERROR" });
  expect(run).toHaveBeenCalledTimes(1);
});
