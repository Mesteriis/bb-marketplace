import { describe, expect, it } from "vitest";
import { createHomePresence, createNewThreadPass, type HomeArrivalFacts } from "../../../src/core/home/index.ts";

const onHome: HomeArrivalFacts = { setting: "on", surface: "stock-home", projectId: null, split: false };

function mounted(pass = createNewThreadPass()) {
  const presence = createHomePresence(pass);
  presence.enter();
  return { presence, pass };
}

describe("home presence", () => {
  it("redirects once per visit, however often the same visit is observed", () => {
    const { presence } = mounted();
    expect(presence.observe(onHome, 100)).toEqual({ action: "redirect" });
    expect(presence.observe(onHome, 101)).toEqual({ action: "stay", reason: "decided" });
    expect(presence.observe(onHome, 102)).toEqual({ action: "stay", reason: "decided" });
  });

  it("reports not-home while nothing is mounted", () => {
    const presence = createHomePresence(createNewThreadPass());
    expect(presence.observe(onHome, 100)).toEqual({ action: "stay", reason: "not-home" });
  });

  it("does not spend the pass while nothing is mounted", () => {
    const pass = createNewThreadPass();
    const presence = createHomePresence(pass);
    pass.grant(100);
    presence.observe(onHome, 101);
    expect(pass.consume(102)).toBe(true);
  });

  it("lets the visit with a pass stay for its whole life, and spends the pass", () => {
    const { presence, pass } = mounted();
    pass.grant(100);
    expect(presence.observe(onHome, 101)).toEqual({ action: "stay", reason: "new-thread-pass" });
    expect(presence.observe(onHome, 9000)).toEqual({ action: "stay", reason: "decided" });
    expect(pass.consume(102)).toBe(false);
  });

  it("redirects the next visit after a visit that used the pass", () => {
    const { presence, pass } = mounted();
    pass.grant(100);
    expect(presence.observe(onHome, 101)).toEqual({ action: "stay", reason: "new-thread-pass" });
    presence.leave();
    presence.settle();
    presence.enter();
    expect(presence.observe(onHome, 200)).toEqual({ action: "redirect" });
  });

  it("keeps the visit when the host remounts the section inside one commit", () => {
    const { presence, pass } = mounted();
    pass.grant(100);
    expect(presence.observe(onHome, 101)).toEqual({ action: "stay", reason: "new-thread-pass" });
    presence.leave();
    presence.enter();
    presence.settle();
    expect(presence.observe(onHome, 102)).toEqual({ action: "stay", reason: "decided" });
  });

  it("keeps the visit while a second mount of the section is still on screen", () => {
    const { presence } = mounted();
    presence.enter();
    expect(presence.observe({ ...onHome, projectId: "prj_1" }, 100)).toEqual({ action: "stay", reason: "project" });
    presence.leave();
    presence.settle();
    expect(presence.observe(onHome, 101)).toEqual({ action: "stay", reason: "decided" });
  });

  it("waits for the setting, then decides with the pass it took on arrival", () => {
    const { presence, pass } = mounted();
    pass.grant(100);
    expect(presence.observe({ ...onHome, setting: "unknown" }, 101)).toEqual({ action: "wait" });
    expect(presence.observe({ ...onHome, setting: "unknown" }, 102)).toEqual({ action: "wait" });
    expect(presence.observe(onHome, 99000)).toEqual({ action: "stay", reason: "new-thread-pass" });
  });

  it("waits for the setting, then redirects once", () => {
    const { presence } = mounted();
    expect(presence.observe({ ...onHome, setting: "unknown" }, 100)).toEqual({ action: "wait" });
    expect(presence.observe(onHome, 101)).toEqual({ action: "redirect" });
    expect(presence.observe(onHome, 102)).toEqual({ action: "stay", reason: "decided" });
  });

  it("does not redirect a visit that began with the setting off when it turns on meanwhile", () => {
    const { presence } = mounted();
    expect(presence.observe({ ...onHome, setting: "off" }, 100)).toEqual({ action: "stay", reason: "disabled" });
    expect(presence.observe(onHome, 101)).toEqual({ action: "stay", reason: "decided" });
  });

  it("does not redirect a visit that began in a project when the project goes away", () => {
    const { presence } = mounted();
    expect(presence.observe({ ...onHome, projectId: "prj_1" }, 100)).toEqual({ action: "stay", reason: "project" });
    expect(presence.observe(onHome, 101)).toEqual({ action: "stay", reason: "decided" });
  });

  it("ignores a leave without an enter", () => {
    const presence = createHomePresence(createNewThreadPass());
    presence.leave();
    presence.settle();
    presence.enter();
    expect(presence.observe(onHome, 100)).toEqual({ action: "redirect" });
  });

  it("redirects every separate visit: ten arrivals, ten redirects", () => {
    const presence = createHomePresence(createNewThreadPass());
    let redirects = 0;
    for (let visit = 0; visit < 10; visit += 1) {
      presence.enter();
      if (presence.observe(onHome, visit).action === "redirect") redirects += 1;
      if (presence.observe(onHome, visit).action === "redirect") redirects += 1;
      presence.leave();
      presence.settle();
    }
    expect(redirects).toBe(10);
  });
});
