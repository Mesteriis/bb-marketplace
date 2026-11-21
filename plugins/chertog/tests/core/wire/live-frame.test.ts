// The address of the controlled frame page: where the server mounts it and
// what the frontend puts into the iframe.
import { describe, expect, it } from "vitest";
import { LIVE_FRAME_ROUTE, liveFrameUrlPath } from "../../../src/core/wire/index.ts";

describe("live frame address", () => {
  it("is one fixed route of the plugin", () => {
    expect(LIVE_FRAME_ROUTE).toBe("/fixtures/live-frame.html");
  });

  it("is the route under the plugin's HTTP namespace, relative to the BB origin", () => {
    expect(liveFrameUrlPath("chertog")).toBe("/api/v1/plugins/chertog/http/fixtures/live-frame.html");
  });

  it("names the instance whose counters the frame keeps", () => {
    expect(liveFrameUrlPath("chertog", "tile-2_b")).toBe("/api/v1/plugins/chertog/http/fixtures/live-frame.html?instance=tile-2_b");
  });

  it("refuses an instance name the page would not accept", () => {
    expect(() => liveFrameUrlPath("chertog", "a b")).toThrow("instance");
    expect(() => liveFrameUrlPath("chertog", "")).toThrow("instance");
    expect(() => liveFrameUrlPath("chertog", "a&file=x")).toThrow("instance");
    expect(() => liveFrameUrlPath("chertog", "x".repeat(65))).toThrow("instance");
    expect(liveFrameUrlPath("chertog", "x".repeat(64))).toBe(
      "/api/v1/plugins/chertog/http/fixtures/live-frame.html?instance=" + "x".repeat(64),
    );
  });

  it("refuses a plugin id that would change the path", () => {
    expect(() => liveFrameUrlPath("../core")).toThrow("plugin id");
    expect(() => liveFrameUrlPath("chertog/http")).toThrow("plugin id");
    expect(() => liveFrameUrlPath("")).toThrow("plugin id");
  });
});
