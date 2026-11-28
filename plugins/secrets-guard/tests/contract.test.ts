import { experimental_PluginRpcRefusal } from "@get-bb/plugin-sdk";
import { describe, expect, it } from "vitest";
import { closeInput, openInput, stateInput, viewOutput } from "../src/adapters/bb/contract.ts";
import { toRefusal } from "../src/adapters/bb/refusals.ts";
import { NotLocal, StoreUnavailable } from "../src/core/ports.ts";

describe("rpc input", () => {
  it("accepts a valid open request", () => {
    expect(openInput.parse({ threadId: "thr_a", scope: "tree", minutes: 30 })).toEqual({
      threadId: "thr_a",
      scope: "tree",
      minutes: 30,
    });
  });
  it.each([
    ["minutes outside the three terms", { threadId: "thr_a", scope: "thread", minutes: 15 }],
    ["minutes as a string", { threadId: "thr_a", scope: "thread", minutes: "10" }],
    ["no minutes: there is no open-ended opening", { threadId: "thr_a", scope: "thread" }],
    ["an unknown scope", { threadId: "thr_a", scope: "all", minutes: 10 }],
    ["an empty thread id", { threadId: "", scope: "thread", minutes: 10 }],
    ["an extra field", { threadId: "thr_a", scope: "thread", minutes: 10, until: 9999999999 }],
  ])("rejects %s", (_name, input) => {
    expect(openInput.safeParse(input).success).toBe(false);
  });
  it("rejects an empty thread id for state and close", () => {
    expect(stateInput.safeParse({ threadId: "" }).success).toBe(false);
    expect(closeInput.safeParse({ threadId: "" }).success).toBe(false);
    expect(stateInput.safeParse({}).success).toBe(false);
  });
});

describe("rpc output", () => {
  it("accepts a closed and an open view", () => {
    expect(viewOutput.safeParse({ configured: true, local: true, effective: null }).success).toBe(true);
    expect(
      viewOutput.safeParse({
        configured: true,
        local: true,
        effective: { scope: "global", until: 1600, rootThreadId: null },
      }).success,
    ).toBe(true);
  });
});

describe("refusals", () => {
  it.each([
    ["not_configured", "Укажите файл отметки в настройках плагина"],
    ["not_writable", "Файл отметки недоступен для записи"],
    ["locked", "Файл отметки занят другой записью, повторите"],
  ] as const)("maps %s to a conflict", (reason, message) => {
    const mapped = toRefusal(new StoreUnavailable(reason));
    expect(mapped).toBeInstanceOf(experimental_PluginRpcRefusal);
    expect(mapped).toMatchObject({ code: "conflict", message });
  });
  it("maps a thread on another machine to forbidden", () => {
    const mapped = toRefusal(new NotLocal());
    expect(mapped).toBeInstanceOf(experimental_PluginRpcRefusal);
    expect(mapped).toMatchObject({ code: "forbidden", message: "Охрана настраивается только на этом Mac" });
  });
  it("passes any other error through", () => {
    const boom = new Error("boom");
    expect(toRefusal(boom)).toBe(boom);
  });
});
