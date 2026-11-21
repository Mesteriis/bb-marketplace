import { describe, expect, it } from "vitest";
import { readHomeArrivalFacts } from "../../../src/adapters/bb/home/facts.ts";

describe("readHomeArrivalFacts", () => {
  it("reads the plain Home with the setting on", () => {
    expect(readHomeArrivalFacts({ enabled: true, projectId: null, splitLayout: null })).toEqual({
      setting: "on",
      surface: "stock-home",
      projectId: null,
      split: false,
    });
  });

  it("reads the setting off", () => {
    expect(readHomeArrivalFacts({ enabled: false, projectId: null, splitLayout: null }).setting).toBe("off");
  });

  it("reads a setting that has not loaded as unknown", () => {
    expect(readHomeArrivalFacts({ enabled: null, projectId: null, splitLayout: null }).setting).toBe("unknown");
  });

  it("carries the project the screen was opened for", () => {
    expect(readHomeArrivalFacts({ enabled: true, projectId: "prj_1", splitLayout: null }).projectId).toBe("prj_1");
  });

  it("reads any split layout as a split, even one without panes", () => {
    expect(readHomeArrivalFacts({ enabled: true, projectId: null, splitLayout: { panes: [] } }).split).toBe(true);
  });
});
