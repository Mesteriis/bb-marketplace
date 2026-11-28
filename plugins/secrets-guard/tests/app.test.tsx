// @vitest-environment jsdom
import { fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { rpcContract } from "../src/adapters/bb/contract.ts";

const closed = { configured: true, local: true, effective: null };

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const load = () => loadPluginApp(() => import("../src/adapters/bb/app.tsx"));

async function customization() {
  const app = await load();
  expect(app.composerCustomizations).toHaveLength(1);
  return app.composerCustomizations[0]!;
}

describe("what the plugin adds to the composer", () => {
  it("one action, one «+» row and one host popup, in thread composers only", async () => {
    const composer = await customization();
    expect(composer.scopes).toEqual(["thread"]);
    expect(composer.actions?.map((action) => action.id)).toEqual(["toggle"]);
    expect(composer.plusMenu?.map((row) => row.label)).toEqual(["Секреты…"]);
    expect(composer.experimental_popups?.map((popup) => [popup.id, popup.label])).toEqual([
      ["secrets-guard", "Секреты"],
    ]);
  });
  it("the «+» row opens the host's window", async () => {
    const composer = await customization();
    const experimental_openPopup = vi.fn(() => true);
    await composer.plusMenu?.[0]?.run({ composer: { experimental_openPopup } as never });
    expect(experimental_openPopup).toHaveBeenCalledTimes(1);
    expect(experimental_openPopup).toHaveBeenCalledWith("secrets-guard");
  });
});

describe("the composer button", () => {
  it("opens the plugin's own popover and opens the guard from it", async () => {
    const composer = await customization();
    const open = vi.fn((_input: { threadId: string; scope: string; minutes: number }) => ({
      configured: true,
      local: true,
      effective: { scope: "thread" as const, until: 9999999999, rootThreadId: "thr_a" },
    }));
    const slot = renderSlot<object, typeof rpcContract>(
      composer.actions![0]!,
      {},
      {
        pluginId: "makosh-secrets-guard",
        rpc: { state: () => closed, open, close: () => closed },
        composer: { scope: { kind: "thread", threadId: "thr_a" } },
      },
    );
    const lock = await slot.findByRole("button", { name: "Секреты: Закрыто" });
    expect(lock.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(lock);
    const dialog = await slot.findByRole("dialog", { name: "Секреты" });
    expect(dialog.getAttribute("data-bb-plugin")).toBe("makosh-secrets-guard");
    expect(dialog.getAttribute("data-layout")).toBeNull();
    expect(dialog.querySelector('[data-layout="fit"]')).not.toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "10 мин" }));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(open.mock.calls[0]?.[0]).toEqual({ threadId: "thr_a", scope: "thread", minutes: 10 });
    expect(slot.getByRole("dialog")).toBeTruthy();
    slot.lifecycle.unmount();
  });
});

describe("the host's window", () => {
  it("shows the same controls, filling the window", async () => {
    const composer = await customization();
    const slot = renderSlot<object, typeof rpcContract>(
      composer.experimental_popups![0]!,
      {},
      {
        pluginId: "makosh-secrets-guard",
        rpc: { state: () => closed, open: () => closed, close: () => closed },
        composer: { scope: { kind: "thread", threadId: "thr_a" } },
      },
    );
    const group = await slot.findByRole("radiogroup", { name: "Охват" });
    expect(group.closest("[data-layout]")?.getAttribute("data-layout")).toBe("fill");
    expect(slot.getByRole("button", { name: "60 мин" })).toBeTruthy();
    slot.lifecycle.unmount();
  });
});
