import { describe, expect, it } from "vitest";
import { ChannelRouter } from "./channel-router.ts";

describe("ChannelRouter", () => {
  it("gives each page channel a bridge-wide id and routes messages back to its connection", () => {
    const router = new ChannelRouter();
    const a = router.rewriteArgs("conn-a", { cwd: "/r", onOutput: "__CHANNEL__:1" });
    const b = router.rewriteArgs("conn-b", { cwd: "/r", onOutput: "__CHANNEL__:1" });
    expect(a).toEqual({ cwd: "/r", onOutput: "__CHANNEL__:1" });
    expect(b).toEqual({ cwd: "/r", onOutput: "__CHANNEL__:2" });
    expect(router.route(1)).toEqual({ conn: "conn-a", channel: 1 });
    expect(router.route(2)).toEqual({ conn: "conn-b", channel: 1 });
  });

  it("leaves arguments without channels untouched and reports none", () => {
    const router = new ChannelRouter();
    expect(router.hasChannel({ cwd: "/r", data: "__CHANNEL__ is text" })).toBe(false);
    expect(router.rewriteArgs("c", { cwd: "/r", n: 3, list: ["x"] })).toEqual({ cwd: "/r", n: 3, list: ["x"] });
  });

  it("finds channels nested in objects and arrays", () => {
    const router = new ChannelRouter();
    expect(router.hasChannel({ opts: { handler: "__CHANNEL__:7" } })).toBe(true);
    expect(router.rewriteArgs("c", { opts: { handlers: ["__CHANNEL__:7", "__CHANNEL__:8"] } })).toEqual({
      opts: { handlers: ["__CHANNEL__:1", "__CHANNEL__:2"] },
    });
  });

  it("forgets every channel of a closed connection, and only those", () => {
    const router = new ChannelRouter();
    router.rewriteArgs("gone", { onOutput: "__CHANNEL__:4" });
    router.rewriteArgs("kept", { onOutput: "__CHANNEL__:4" });
    router.dropConn("gone");
    expect(router.route(1)).toBeNull();
    expect(router.route(2)).toEqual({ conn: "kept", channel: 4 });
  });

  it("returns null for a channel it never issued", () => {
    expect(new ChannelRouter().route(99)).toBeNull();
  });
});
