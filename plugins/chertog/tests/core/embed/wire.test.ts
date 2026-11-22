import { workspacePanelSchema } from "../../../src/core/workspace/document.ts";
import { expect, it } from "vitest";
import { host, paramsSchema, parseOwner } from "../../../src/core/embed/wire.ts";
const address = { version: "chertog.embed.v1", provider: "zoom-call", instanceId: "view-9", generation: 1 };
const resourceRef = "12345678-1234-4123-8123-123456789abc";

it("rejects unsupported versions with a fixed reason", () => {
  expect(parseOwner({ ...address, version: "chertog.embed.v2", kind: "ready" })).toEqual({ ok: false, reason: "unsupported-version" });
});
it("admits only the opaque UUID and closed owner messages", () => {
  expect(paramsSchema.safeParse({ resourceRef }).success).toBe(true);
  expect(paramsSchema.safeParse({ resourceRef, chatId: "other" }).success).toBe(false);
  for (const invalid of [
    { ...address, kind: "ready", url: "other" }, { ...address, generation: 0, kind: "ready" },
    { ...address, kind: "selected", resourceRef: resourceRef.toUpperCase() },
  ]) expect(parseOwner(invalid)).toEqual({ ok: false, reason: "invalid-message" });
});

it("refuses saving any other embed parameters while retaining legacy card references", () => {
  for (const provider of ["telegram-chat", "zoom-call", "remote-ssh-live", "remote-rdp-live", "remote-vnc-live"]) {
    expect(workspacePanelSchema.safeParse({ ref: { provider, params: { resourceRef, chatId: "other" } } }).success).toBe(false);
    expect(workspacePanelSchema.safeParse({ ref: { provider, params: { resourceRef } } }).success).toBe(true);
  }
  for (const provider of ["telegram", "zoom", "remote-ssh", "remote-rdp", "remote-vnc"])
    expect(workspacePanelSchema.safeParse({ ref: { provider, params: {} } }).success).toBe(true);
});

it("requires exactly one choice mode or resource UUID in the host announcement", () => {
  const base = { ...address, kind: "announce" };
  expect(host.safeParse({ ...base, mode: "choose" }).success).toBe(true);
  expect(host.safeParse({ ...base, resourceRef }).success).toBe(true);
  expect(host.safeParse({ ...base, resourceRef, mode: "choose" }).success).toBe(false);
  expect(host.safeParse({ ...address, kind: "close", command: "disconnect" }).success).toBe(false);
});
