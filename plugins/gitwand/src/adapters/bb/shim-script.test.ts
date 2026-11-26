// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { shimScript } from "./shim-script.ts";

describe("shimScript", () => {
  it("is a standalone script that installs the shim with the relay base", () => {
    const sockets: string[] = [];
    Object.assign(window, { WebSocket: class { constructor(url: string) { sockets.push(url); } } });
    new Function(shimScript("/api/v1/plugins/makosh-gitwand/http/gw/"))();
    expect(typeof (window as unknown as { __TAURI_INTERNALS__: { invoke: unknown } }).__TAURI_INTERNALS__.invoke).toBe("function");
    expect(sockets).toEqual(["ws://localhost:3000/api/v1/plugins/makosh-gitwand/http/gw/ws"]);
  });

  it("escapes the base so it cannot end the script", () => {
    const script = shimScript("/x</script><script>alert(1)//");
    expect(script).not.toContain("</script>");
    expect(script).toContain('"/x\\u003c/script>\\u003cscript>alert(1)//"');
  });
});
