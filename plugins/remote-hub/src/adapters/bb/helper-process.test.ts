import { describe, expect, it } from "vitest";
import {
  HELPER_BIN_NAME,
  helperBinaryPath,
  helperMissingError,
  parseHelperVersion,
  platformError,
  probeHelper,
} from "./helper-process.ts";

describe("helper-process (pure parts)", () => {
  it("resolves the binary path inside the plugin directory", () => {
    expect(helperBinaryPath("/plugins/remote-hub")).toBe("/plugins/remote-hub/bin/" + HELPER_BIN_NAME);
  });

  it("parses the --version line", () => {
    expect(parseHelperVersion("remote-hub-helper 0.1.0\n")).toBe("0.1.0");
  });

  it("returns null platform error on this darwin/arm64 machine", () => {
    expect(platformError()).toBeNull();
  });

  it("returns helper_missing with the expected path for a missing binary", async () => {
    const missing = "/plugins/remote-hub/bin/" + HELPER_BIN_NAME;
    const probe = await probeHelper(missing);
    expect(probe).toEqual({
      ok: false,
      error: {
        code: "helper_missing",
        message: helperMissingError(missing).message,
        path: missing,
      },
    });
    if (probe.ok) return;
    expect(probe.error.message).toContain(missing);
  });
});
