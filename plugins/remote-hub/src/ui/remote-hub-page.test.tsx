// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RemoteHubPage, STATUS_POLL_MS } from "./remote-hub-page.tsx";
import type { HelperStatus } from "../core/rpc.ts";

function makeStatus(alive: boolean): HelperStatus {
  return { version: "0.1.0", pid: 1, platform: "test", sessionCount: 0, alive };
}

describe("RemoteHubPage", () => {
  it("shows loading, then ready, then the error state on the 5s re-check", async () => {
    vi.useFakeTimers();
    try {
      let alive = true;
      const loadStatus = vi.fn(async () => makeStatus(alive));
      const onOpen = vi.fn();
      const onInput = vi.fn();
      const onClose = vi.fn();

      render(
        <RemoteHubPage loadStatus={loadStatus} onOpen={onOpen} onInput={onInput} onClose={onClose} />,
      );

      expect(screen.getByText(/starting/i)).toBeTruthy();

      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByText(/version 0\.1\.0/)).toBeTruthy();

      alive = false;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(STATUS_POLL_MS);
      });
      expect(screen.getByText(/not running/i)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
