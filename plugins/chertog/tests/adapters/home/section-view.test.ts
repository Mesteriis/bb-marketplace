import { describe, expect, it } from "vitest";
import { showsOpenChertogButton } from "../../../src/adapters/bb/home/section-view.ts";
import type { HomeRedirectDecision } from "../../../src/core/home/index.ts";

const stay = (reason: "disabled" | "new-thread-pass" | "project" | "split" | "decided" | "not-home"): HomeRedirectDecision => ({
  action: "stay",
  reason,
});

describe("showsOpenChertogButton", () => {
  it.each<[string, boolean | null, HomeRedirectDecision | null, boolean]>([
    ["setting off, visit stays as disabled", false, stay("disabled"), false],
    ["setting off, visit already decided", false, stay("decided"), false],
    ["setting off, a pass let the visit through", false, stay("new-thread-pass"), false],
    ["setting off, a project is in view", false, stay("project"), false],
    ["setting unknown, nothing decided", null, { action: "wait" }, false],
    ["setting unknown, visit decided earlier", null, stay("decided"), false],
    ["setting on, nothing observed yet", true, null, false],
    ["setting on, redirect issued", true, { action: "redirect" }, false],
    ["setting on, still waiting", true, { action: "wait" }, false],
    ["setting on, a pass let the visit through", true, stay("new-thread-pass"), true],
    ["setting on, a project is in view", true, stay("project"), true],
    ["setting on, the screen is a split pane", true, stay("split"), true],
    ["setting on, visit decided earlier", true, stay("decided"), true],
    ["setting on, decision says disabled", true, stay("disabled"), false],
  ])("%s", (_name, enabled, decision, expected) => {
    expect(showsOpenChertogButton(enabled, decision)).toBe(expected);
  });
});
