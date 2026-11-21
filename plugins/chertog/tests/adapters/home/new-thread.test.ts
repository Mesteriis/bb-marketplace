import { describe, expect, it } from "vitest";
import { createHomeRedirectController } from "../../../src/adapters/bb/home/controller.ts";
import { allowNextNewThreadScreen, newThreadPass, openNewThreadScreen } from "../../../src/adapters/bb/home/new-thread.ts";
import type { HomeArrivalFacts } from "../../../src/core/home/index.ts";

const onHome: HomeArrivalFacts = { setting: "on", surface: "stock-home", projectId: null, split: false };

describe("Chertog's New thread action", () => {
  it("grants the window's pass, which one arrival spends", () => {
    allowNextNewThreadScreen(1000);
    expect(newThreadPass.consume(1001)).toBe(true);
    expect(newThreadPass.consume(1002)).toBe(false);
  });

  it("grants the pass before it navigates, and passes the compose options through", () => {
    const seen: Array<{ options: unknown; passWasGranted: boolean }> = [];
    openNewThreadScreen(
      {
        toCompose(options) {
          seen.push({ options, passWasGranted: newThreadPass.consume(Date.now()) });
        },
      },
      { focusPrompt: true },
    );
    expect(seen).toEqual([{ options: { focusPrompt: true }, passWasGranted: true }]);
  });

  it("opens the new thread screen without a redirect, and the next Home visit redirects", () => {
    const panelCalls: unknown[] = [];
    const navigation = { toPluginPanel: (path: string, options?: object) => void panelCalls.push({ path, options }) };
    const deferred: Array<() => void> = [];
    const controller = createHomeRedirectController({ panelPath: "home", pass: newThreadPass, defer: (task) => deferred.push(task) });

    let composeCalls = 0;
    openNewThreadScreen({ toCompose: () => void (composeCalls += 1) });
    const unmount = controller.mount();
    controller.observe(onHome, navigation);
    expect(composeCalls).toBe(1);
    expect(panelCalls).toEqual([]);

    unmount();
    for (const task of deferred.splice(0)) task();
    controller.mount();
    controller.observe(onHome, navigation);
    expect(panelCalls).toEqual([{ path: "home", options: { replace: true } }]);
  });
});
