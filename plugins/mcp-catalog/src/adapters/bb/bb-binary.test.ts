import { describe, expect, it } from "vitest";
import { bbEnv, resolveBb } from "./bb-binary";

describe("resolveBb", () => {
  it("prefers BB_CLI, then the bundled binary, then PATH", () => {
    const bundled = "/h/Library/Application Support/Makosh BB Backend/runtime/node_modules/bb-app/host-daemon/dist/bb";
    expect(resolveBb({ BB_CLI: "/x/bb" }, "/h", () => true)).toBe("/x/bb");
    expect(resolveBb({ BB_CLI: "/x/bb" }, "/h", (p) => p === bundled)).toBe(bundled);
    expect(resolveBb({}, "/h", () => false)).toBe("bb");
  });
});

describe("bbEnv", () => {
  it("targets the running server and drops thread context", () => {
    const env = bbEnv({ PATH: "/p", BB_SERVER_URL: "http://other", BB_THREAD_ID: "t", BB_PROJECT_ID: "p" }, { url: "http://127.0.0.1:1", dataDir: "/d" });
    expect(env).toEqual({ PATH: "/p", BB_SERVER_URL: "http://127.0.0.1:1", BB_DATA_DIR: "/d" });
  });
});
