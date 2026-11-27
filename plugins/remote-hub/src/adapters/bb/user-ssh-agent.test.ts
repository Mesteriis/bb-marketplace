import { describe, expect, it } from "vitest";
import { agentSocketFor } from "./user-ssh-agent.ts";

const HOME = "/Users/someone";
const env = { SSH_AUTH_SOCK: "/tmp/launchd/agent.sock", HOME };
const at = (config: string, host = "box.test", e: Record<string, string | undefined> = env) => agentSocketFor({ env: e, home: HOME, host, configText: config });

describe("which agent socket ssh uses for a host", () => {
  it("is SSH_AUTH_SOCK when the configuration names no IdentityAgent", () => {
    expect(at("")).toBe("/tmp/launchd/agent.sock");
    expect(at("Host other\n  IdentityAgent /x/y.sock\n")).toBe("/tmp/launchd/agent.sock");
  });

  it("is the configured socket when a global or matching Host block names one, and the configuration wins over SSH_AUTH_SOCK", () => {
    expect(at("IdentityAgent /a/global.sock\n")).toBe("/a/global.sock");
    expect(at("Host *.test\n  IdentityAgent /a/test.sock\n")).toBe("/a/test.sock");
    expect(at("Host box.test other\n  identityagent=/a/eq.sock\n")).toBe("/a/eq.sock");
    expect(at('Host *\n  IdentityAgent "~/Library/Group Containers/x y/agent.sock"\n')).toBe(`${HOME}/Library/Group Containers/x y/agent.sock`);
    expect(at("Host *\n  IdentityAgent %d/.agent/sock\n")).toBe(`${HOME}/.agent/sock`);
  });

  it("uses the first value ssh would, like ssh does", () => {
    expect(at("Host box.test\n  IdentityAgent /first.sock\nHost *\n  IdentityAgent /second.sock\n")).toBe("/first.sock");
  });

  it("honours none, SSH_AUTH_SOCK and environment variables as values", () => {
    expect(at("IdentityAgent none\n")).toBeNull();
    expect(at("IdentityAgent SSH_AUTH_SOCK\n")).toBe("/tmp/launchd/agent.sock");
    expect(at("IdentityAgent $AGENT_SOCK\n", "box.test", { ...env, AGENT_SOCK: "/e/s.sock" })).toBe("/e/s.sock");
    expect(at("IdentityAgent ${AGENT_SOCK}\n", "box.test", { ...env, AGENT_SOCK: "/e/s.sock" })).toBe("/e/s.sock");
    expect(at("IdentityAgent $NOPE\n")).toBeNull();
    expect(at("", "box.test", { HOME })).toBeNull();
  });

  it("matches Host patterns with * ? and !, and does not guess about Match blocks", () => {
    expect(at("Host *.test !box.test\n  IdentityAgent /a.sock\n")).toBe("/tmp/launchd/agent.sock");
    expect(at("Host bo?.test\n  IdentityAgent /a.sock\n")).toBe("/a.sock");
    expect(at("Match host box.test\n  IdentityAgent /a.sock\n")).toBe("/tmp/launchd/agent.sock");
    expect(at("Host box.test\n  IdentityAgent /h.sock\nMatch all\n  IdentityAgent /m.sock\n")).toBe("/h.sock");
  });
});
