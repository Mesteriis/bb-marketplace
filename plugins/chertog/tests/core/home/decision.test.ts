import { describe, expect, it } from "vitest";
import { decideHomeRedirect, type HomeRedirectDecision, type HomeRedirectFacts } from "../../../src/core/home/index.ts";

/** The one combination that redirects: every other row changes exactly the named facts. */
const accidentalHome: HomeRedirectFacts = {
  setting: "on",
  surface: "stock-home",
  newThreadPass: false,
  projectId: null,
  split: false,
};

const redirect: HomeRedirectDecision = { action: "redirect" };
const wait: HomeRedirectDecision = { action: "wait" };
const stay = (reason: string): unknown => ({ action: "stay", reason });

describe("decideHomeRedirect", () => {
  it("redirects an arrival on the stock Home with the setting on and nothing saying it was meant", () => {
    expect(decideHomeRedirect(accidentalHome)).toEqual(redirect);
  });

  it.each<[string, Partial<HomeRedirectFacts>, unknown]>([
    ["the setting is off", { setting: "off" }, stay("disabled")],
    ["the setting is not known yet", { setting: "unknown" }, wait],
    ["the surface is not the stock Home", { surface: "other" }, stay("not-home")],
    ["Chertog's own New thread action left a pass", { newThreadPass: true }, stay("new-thread-pass")],
    ["a project is in view", { projectId: "prj_1" }, stay("project")],
    ["the project id is an empty string", { projectId: "" }, stay("project")],
    ["the screen is one pane of a split", { split: true }, stay("split")],
  ])("does not redirect when %s", (_name, change, expected) => {
    expect(decideHomeRedirect({ ...accidentalHome, ...change })).toEqual(expected);
  });

  it.each<[string, Partial<HomeRedirectFacts>, unknown]>([
    ["off wins over a pass, a project and a split", { setting: "off", newThreadPass: true, projectId: "prj_1", split: true }, stay("disabled")],
    ["another surface wins over the setting being off", { surface: "other", setting: "off" }, stay("not-home")],
    ["another surface wins over an unknown setting", { surface: "other", setting: "unknown" }, stay("not-home")],
    ["an unknown setting waits even with a pass", { setting: "unknown", newThreadPass: true }, wait],
    ["a pass wins over a project", { newThreadPass: true, projectId: "prj_1" }, stay("new-thread-pass")],
    ["a project wins over a split", { projectId: "prj_1", split: true }, stay("project")],
  ])("names one reason when several apply: %s", (_name, change, expected) => {
    expect(decideHomeRedirect({ ...accidentalHome, ...change })).toEqual(expected);
  });
});
