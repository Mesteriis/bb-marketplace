import { describe, expect, it } from "vitest";
import { DECRYPT_ERROR } from "../adapters/bb/sync-service.ts";
import {
  DECRYPT_ERROR_TEXT,
  OFFLINE_QUIET_MS,
  isQuietlyOffline,
  parseSyncProblems,
  syncProblemText,
} from "./sync-problems.ts";

const codes = (text: string | null) => parseSyncProblems(text).map((p) => p.code);

describe("parseSyncProblems", () => {
  it("reads nothing from a clean account", () => {
    expect(parseSyncProblems(null)).toEqual([]);
    expect(parseSyncProblems("")).toEqual([]);
  });

  it("reads every sentence sync writes", () => {
    expect(parseSyncProblems("Authentication failed")).toEqual([
      { code: "auth_failed", folder: null, count: null, detail: null },
    ]);
    expect(codes("Sync failed (ENOTFOUND)")).toEqual(["network"]);
    expect(codes("Sync failed (ETIMEDOUT); Sync failed (ECONNRESET)")).toEqual(["network", "network"]);
    expect(codes("Sync failed (UNAVAILABLE)")).toEqual(["server_busy"]);
    expect(codes("Sync failed (TLSFailed)")).toEqual(["tls"]);
    expect(codes("Sync failed (ERR_TLS_CERT_ALTNAME_INVALID)")).toEqual(["tls"]);
    expect(codes("Sync failed (SearchFailed)")).toEqual(["server"]);
    expect(codes("Sync failed")).toEqual(["server"]);
    expect(parseSyncProblems("Invented folder: Sync failed (ECONNRESET)")).toEqual([
      { code: "network", folder: "Invented folder", count: null, detail: "ECONNRESET" },
    ]);
    expect(parseSyncProblems("Archive: could not update flags on the server")).toEqual([
      { code: "flags_not_saved", folder: "Archive", count: null, detail: null },
    ]);
    expect(parseSyncProblems("Old no longer exists; 3 queued move(s) were dropped")).toEqual([
      { code: "folder_gone_moves_dropped", folder: "Old", count: 3, detail: null },
    ]);
    expect(parseSyncProblems("Old was renumbered by the server; 2 queued move(s) were dropped")).toEqual([
      { code: "renumbered_moves_dropped", folder: "Old", count: 2, detail: null },
    ]);
    expect(parseSyncProblems("Could not move 4 message(s); they were returned to INBOX")).toEqual([
      { code: "moves_returned", folder: "INBOX", count: 4, detail: null },
    ]);
  });

  it("knows the sync service's own sentence", () => {
    expect(DECRYPT_ERROR_TEXT).toBe(DECRYPT_ERROR);
    expect(codes(DECRYPT_ERROR)).toEqual(["credential_unreadable"]);
  });

  it("keeps a folder name with a colon whole and unknown text as it came", () => {
    expect(parseSyncProblems("Work: 2026: Sync failed (EPIPE)")[0]).toMatchObject({
      code: "network",
      folder: "Work: 2026",
    });
    expect(parseSyncProblems("Something invented happened")).toEqual([
      { code: "other", folder: null, count: null, detail: "Something invented happened" },
    ]);
  });

  it("is bounded on a long line", () => {
    const long = Array.from({ length: 500 }, (_, i) => `F${i}: Sync failed (EPIPE)`).join("; ");
    expect(parseSyncProblems(long)).toHaveLength(20);
    expect(parseSyncProblems("x".repeat(100_000))[0]!.detail).toHaveLength(600);
  });
});

describe("isQuietlyOffline", () => {
  const now = Date.parse("2026-11-17T12:00:00.000Z");
  const account = (lastError: string | null, minutesAgo: number | null, authFailed = false) => ({
    lastError,
    authFailed,
    lastSyncAt: minutesAgo === null ? null : new Date(now - minutesAgo * 60_000).toISOString(),
  });

  it("is quiet for a lost network while the last good sync is recent", () => {
    expect(isQuietlyOffline(account("Sync failed (ENOTFOUND)", 5), now)).toBe(true);
    expect(isQuietlyOffline(account("INBOX: Sync failed (ETIMEDOUT); Sync failed (UNAVAILABLE)", 29), now)).toBe(true);
  });

  it("is not quiet after 30 minutes, without a first sync, or for any other problem", () => {
    expect(isQuietlyOffline(account("Sync failed (ENOTFOUND)", OFFLINE_QUIET_MS / 60_000), now)).toBe(false);
    expect(isQuietlyOffline(account("Sync failed (ENOTFOUND)", null), now)).toBe(false);
    expect(isQuietlyOffline(account("Authentication failed", 1, true), now)).toBe(false);
    expect(isQuietlyOffline(account("Sync failed (ENOTFOUND); Archive: could not update flags on the server", 1), now)).toBe(false);
    expect(isQuietlyOffline(account(null, 1), now)).toBe(false);
  });
});

describe("syncProblemText", () => {
  it("says each problem in one sentence, with the folder and numbers as data", () => {
    const text = (line: string) => parseSyncProblems(line).map(syncProblemText);
    expect(text("Sync failed (ENOTFOUND)")).toEqual(["The mail server could not be reached (ENOTFOUND)."]);
    expect(text("Could not move 4 message(s); they were returned to INBOX")).toEqual([
      "4 messages could not be moved; they are back in INBOX.",
    ]);
    expect(text("Archive: could not update flags on the server")).toEqual([
      "Archive: Read and flag changes could not be saved on the server.",
    ]);
    expect(text("Something invented happened")).toEqual(["Something invented happened"]);
  });
});
