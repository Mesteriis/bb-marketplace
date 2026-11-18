// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACCESS_NOTE, AgentPanel, type AgentApi, type AgentAuditView, type AgentGrantView } from "./agent-panel.tsx";

afterEach(cleanup);
const P1 = "11111111-2222-4333-8444-555555555551";
const row = (over: Partial<AgentAuditView>): AgentAuditView => ({ id: 1, at: "2026-11-18T12:00:00.000Z", threadId: "thr_a", projectId: "prj_1", tool: "remote_terminal_read", profileId: P1, sessionKey: "g.1", detailMode: "none", detail: null, outcome: "ok", count: 1, ...over });

function api(over: Partial<AgentApi> & { grants?: AgentGrantView[]; rows?: AgentAuditView[] } = {}): AgentApi {
  let grants = over.grants ?? [];
  return {
    list: over.list ?? vi.fn(async () => grants),
    set: over.set ?? vi.fn(async (profileId, level, recordCommands) => {
      grants = level === "none" ? grants.filter((g) => g.profileId !== profileId) : grants;
      return { profileId, level, recordCommands };
    }),
    revokeAll: over.revokeAll ?? vi.fn(async () => {
      const n = grants.length;
      grants = [];
      return { revoked: n };
    }),
    audit: over.audit ?? vi.fn(async () => over.rows ?? []),
  };
}
const names = new Map([[P1, "build box"]]);
const mount = (a: AgentApi) => render(<AgentPanel api={a} profileNames={names} onClose={() => {}} />);

describe("AgentPanel", () => {
  it("says the grant applies to agents in ANY thread, the order of the levels, and that connect starts at input", async () => {
    mount(api());
    expect(ACCESS_NOTE).toContain("ANY thread of this BB");
    expect(ACCESS_NOTE).toContain("no access < observe < input < exec");
    expect(ACCESS_NOTE).toContain("connecting is allowed from input up");
    expect(ACCESS_NOTE).toContain("always your decision");
    expect((await screen.findByLabelText("Agent activity")).textContent).toContain("ANY thread of this BB");
  });

  it("with no grants it says agents can use nothing, and the revoke-all button is off", async () => {
    mount(api());
    expect((await screen.findByLabelText("Agent activity")).textContent).toContain("Agents cannot see or use any connection");
    expect((screen.getByRole("button", { name: "Revoke all agent access" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("lists grants with profile names and revokes one", async () => {
    const a = api({ grants: [{ profileId: P1, level: "observe", recordCommands: false, updatedAt: "x" }] });
    mount(a);
    const list = await screen.findByLabelText("Granted connections");
    expect(list.textContent).toContain("build box");
    expect(list.textContent).toContain("observe");
    fireEvent.click(screen.getByLabelText("Revoke access to build box"));
    await waitFor(() => expect(a.set).toHaveBeenCalledWith(P1, "none", false));
    await waitFor(() => expect(screen.getByLabelText("Agent activity").textContent).toContain("Agents cannot see or use any connection"));
  });

  it("revoke all switches everything off and reports how many", async () => {
    const a = api({ grants: [{ profileId: P1, level: "observe", recordCommands: false, updatedAt: "x" }, { profileId: "p2", level: "exec", recordCommands: true, updatedAt: "x" }] });
    mount(a);
    await screen.findByLabelText("Granted connections");
    fireEvent.click(screen.getByRole("button", { name: "Revoke all agent access" }));
    expect((await screen.findByRole("status")).textContent).toBe("Agent access was switched off for 2 connection(s).");
    expect(a.revokeAll).toHaveBeenCalledTimes(1);
  });

  it("shows the thread, the tool, the connection and the outcome of each call, and calls that never finished", async () => {
    mount(api({ rows: [row({ id: 3, outcome: null, tool: "remote_rdp_screenshot", threadId: "thr_b" }), row({ id: 2, outcome: "agent_access_denied", profileId: null, sessionKey: null }), row({ id: 1, outcome: "rate_limited", count: 40 })] }));
    const list = await screen.findByLabelText("Agent activity list");
    const text = list.textContent ?? "";
    expect(text).toContain("remote_rdp_screenshot");
    expect(text).toContain("unfinished (no outcome was recorded)");
    expect(text).toContain("thread thr_b");
    expect(text).toContain("agent_access_denied");
    expect(text).toContain("40 times");
    expect(text).toContain("build box");
    expect(text).toContain("session g.1");
  });

  it("says which recording mode was in effect for a recorded input, and never invents text", async () => {
    mount(api({ rows: [row({ id: 2, tool: "remote_ssh_exec", detailMode: "text", detail: "uptime" }), row({ id: 1, tool: "remote_terminal_input", detailMode: "hash", detail: "len 4 sha 1a2b" })] }));
    const text = (await screen.findByLabelText("Agent activity list")).textContent ?? "";
    expect(text).toContain("command: uptime");
    expect(text).toContain("recorded as length and hash only");
    expect(text).not.toContain("1a2b");
  });

  it("an empty activity list says so, and a failing load is shown as an error", async () => {
    mount(api());
    expect((await screen.findByLabelText("Agent activity")).textContent).toContain("No agent has called a Remote Hub tool yet.");
    cleanup();
    mount(api({ list: vi.fn(async () => { throw new Error("helper_unavailable: x"); }) }));
    expect((await screen.findByRole("alert")).textContent).not.toBe("");
  });
});
