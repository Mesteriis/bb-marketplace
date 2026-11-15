import { describe, expect, it } from "vitest";
import { SERVER_COPY_IDLE_MS, serverCopyDue, type ServerCopyCheck } from "./compose-drafts.ts";

const SAVED = "2026-11-15T10:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(SAVED) + ms).toISOString();

function check(overrides: Partial<ServerCopyCheck> = {}): ServerCopyCheck {
  return {
    revision: 3,
    serverRevision: 2,
    updatedAt: SAVED,
    now: at(SERVER_COPY_IDLE_MS),
    hasAttachments: false,
    uidplus: true,
    hasDraftsFolder: true,
    reason: "tick",
    ...overrides,
  };
}

describe("serverCopyDue", () => {
  it("copies an idle draft the server lacks on a tick", () => {
    expect(serverCopyDue(check())).toBe(true);
    expect(serverCopyDue(check({ serverRevision: null }))).toBe(true);
  });

  it("waits 30 s after the last change before a tick copies it", () => {
    expect(serverCopyDue(check({ now: at(SERVER_COPY_IDLE_MS - 1) }))).toBe(false);
    expect(serverCopyDue(check({ now: at(0) }))).toBe(false);
  });

  it("never copies without UIDPLUS, whatever the reason", () => {
    for (const reason of ["tick", "close", "save", "send", "discard"] as const) {
      expect(serverCopyDue(check({ uidplus: false, reason }))).toBe(false);
    }
  });

  it("never copies without a Drafts folder", () => {
    for (const reason of ["tick", "close", "save"] as const) {
      expect(serverCopyDue(check({ hasDraftsFolder: false, reason }))).toBe(false);
    }
  });

  it("copies at once on close and Save draft, idle or not", () => {
    expect(serverCopyDue(check({ reason: "close", now: at(0) }))).toBe(true);
    expect(serverCopyDue(check({ reason: "save", now: at(0) }))).toBe(true);
  });

  it("with attachments copies only on close and Save draft", () => {
    expect(serverCopyDue(check({ hasAttachments: true, now: at(10 * SERVER_COPY_IDLE_MS) }))).toBe(false);
    expect(serverCopyDue(check({ hasAttachments: true, reason: "close" }))).toBe(true);
    expect(serverCopyDue(check({ hasAttachments: true, reason: "save" }))).toBe(true);
  });

  it("skips a send and a discard", () => {
    expect(serverCopyDue(check({ reason: "send" }))).toBe(false);
    expect(serverCopyDue(check({ reason: "discard" }))).toBe(false);
  });

  it("skips a revision the server already holds", () => {
    expect(serverCopyDue(check({ serverRevision: 3 }))).toBe(false);
    expect(serverCopyDue(check({ serverRevision: 3, reason: "save" }))).toBe(false);
  });

  it("does not copy on an unreadable time", () => {
    expect(serverCopyDue(check({ updatedAt: "not a date" }))).toBe(false);
  });
});
