// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACCESS_NOTE, AgentPanel, type AgentApi, type AgentAuditView, type AgentGrantView, type AgentSessionView } from "./agent-panel.tsx";

afterEach(cleanup);
const P1 = "11111111-2222-4333-8444-555555555551";
const row = (over: Partial<AgentAuditView>): AgentAuditView => ({ id: 1, at: "2026-11-18T12:00:00.000Z", threadId: "thr_a", projectId: "prj_1", tool: "remote_terminal_read", profileId: P1, sessionKey: "g.1", detailMode: "none", detail: null, outcome: "ok", count: 1, ...over });

function api(over: Partial<AgentApi> & { grants?: AgentGrantView[]; rows?: AgentAuditView[]; sessionRows?: AgentSessionView[] } = {}): AgentApi {
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
    sessions: over.sessions ?? vi.fn(async () => over.sessionRows ?? []),
    takeover: over.takeover ?? vi.fn(async () => ({ tookOver: true })),
    allowAgents: over.allowAgents ?? vi.fn(async () => ({ allowed: true })),
    answer: over.answer ?? vi.fn(async () => ({ answered: true as const })),
    decideCertificate: over.decideCertificate ?? vi.fn(async () => {}),
    disconnect: over.disconnect ?? vi.fn(async () => {}),
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

  it("Y1: the note does not claim agents never see secrets; it says what Observe shows and what is never given", async () => {
    expect(ACCESS_NOTE).not.toContain("never see or type a password or key");
    expect(ACCESS_NOTE).toContain("never get a saved password or key");
    expect(ACCESS_NOTE).toContain("everything the terminal prints");
    expect(ACCESS_NOTE).toContain("including a secret shown there");
  });

  it("Y2: grant changes are shown at the top, apart from the tool calls, with who, old and new level and a limit note", async () => {
    const a = api({
      rows: [
        row({ id: 5, tool: "remote_terminal_read" }),
        row({ id: 4, tool: "access.set", threadId: "owner RPC", projectId: "", sessionKey: null, detail: "exec <- observe", at: "2026-11-18T12:05:00.000Z" }),
        row({ id: 3, tool: "access.revoke_all", threadId: "owner RPC", projectId: "", profileId: null, sessionKey: null, detail: "removed 2" }),
      ],
    });
    mount(a);
    const changes = await screen.findByLabelText("Access changes");
    expect(changes.textContent).toContain("exec <- observe");
    expect(changes.textContent).toContain("owner RPC");
    expect(changes.textContent).toContain("removed 2");
    expect(changes.textContent).not.toContain("remote_terminal_read");
    expect(screen.getByLabelText("Agent activity list").textContent).toContain("remote_terminal_read");
    expect(screen.getByLabelText("Agent activity list").textContent).not.toContain("access.set");
    const panel = screen.getByLabelText("Agent activity");
    expect(panel.compareDocumentPosition(changes) & Node.DOCUMENT_POSITION_CONTAINED_BY).toBeTruthy();
    expect(changes.compareDocumentPosition(screen.getByLabelText("Granted connections")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(ACCESS_NOTE).toContain("restrict the tools registered for agents");
    expect(ACCESS_NOTE).toContain("not a sandbox");
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


describe("AgentPanel: sessions agents opened or drive (stage 4b-1)", () => {
  const GEN = "a".repeat(32);
  const base: AgentSessionView = {
    generation: GEN, sessionId: 4, kind: "ssh", connectionId: P1, state: "running", openedByThread: "thr_a", controlledBy: "human",
    leaseThreadId: null, leaseExpiresAt: null, questions: [], certificate: null, openedByArchivedThread: false, holdUntil: null,
  };

  it("says there are none when no agent opened or holds a session", async () => {
    mount(api());
    expect((await screen.findByLabelText("Agent sessions")).textContent).toBe("");
    expect(screen.getByText(/No agent has opened or is driving a session/)).toBeTruthy();
  });

  it("lists a session with its connection name, who opened it and who drives it; Take control calls the RPC with its handle", async () => {
    const a = api({ sessionRows: [{ ...base, controlledBy: "agent", leaseThreadId: "thr_a", leaseExpiresAt: 1_700_000_000_000 }] });
    mount(a);
    const list = await screen.findByLabelText("Agent sessions");
    expect(list.textContent).toContain("build box");
    expect(list.textContent).toContain("opened by agent thread thr_a");
    expect(list.textContent).toContain("driven by an agent");
    fireEvent.click(screen.getByRole("button", { name: "Take control of build box" }));
    await waitFor(() => expect(a.takeover).toHaveBeenCalledWith({ generation: GEN, sessionId: 4 }));
  });

  it("there is no Take control when the human already drives, and Disconnect closes the session", async () => {
    const a = api({ sessionRows: [base] });
    mount(a);
    await screen.findByLabelText("Agent sessions");
    expect(screen.queryByRole("button", { name: "Take control of build box" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect build box" }));
    await waitFor(() => expect(a.disconnect).toHaveBeenCalledWith({ generation: GEN, sessionId: 4 }));
  });

  it("a host-key question waits for the owner: the text is shown and the answer goes back with the prompt id", async () => {
    const a = api({ sessionRows: [{ ...base, state: "connecting", questions: [{ kind: "host_key", promptId: 7, text: "Are you sure you want to continue connecting (yes/no)?" }] }] });
    mount(a);
    expect((await screen.findByTestId("ssh-prompt-text")).textContent).toContain("Are you sure you want to continue connecting");
    fireEvent.change(screen.getByLabelText("Type yes to continue"), { target: { value: "yes" } });
    fireEvent.keyDown(screen.getByLabelText("Type yes to continue"), { key: "Enter" });
    await waitFor(() => expect(a.answer).toHaveBeenCalledWith({ generation: GEN, sessionId: 4 }, 7, "yes"));
  });

  it("a login question (one-time code) is typed here, masked, and sent once", async () => {
    const a = api({ sessionRows: [{ ...base, questions: [{ kind: "login_prompt", promptId: 9, text: "One-time code:" }] }] });
    mount(a);
    const field = (await screen.findByLabelText("Answer")) as HTMLInputElement;
    expect(field.type).toBe("password");
    fireEvent.change(field, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(a.answer).toHaveBeenCalledWith({ generation: GEN, sessionId: 4 }, 9, "123456"));
  });

  it("a certificate question shows the certificate and the decision names the PRESENTED fingerprint", async () => {
    const fp = Array.from({ length: 32 }, () => "AB").join(":");
    const a = api({
      sessionRows: [{ ...base, kind: "rdp", state: "connecting", certificate: { host: "rdp.test", port: 3389, fingerprint: fp, subject: "CN=x", issuer: "CN=y", notBefore: "2026-01-01T00:00:00Z", notAfter: "2036-01-01T00:00:00Z", reason: "untrusted_root", firstUse: true } }],
    });
    mount(a);
    await screen.findByRole("alertdialog");
    expect(screen.getByRole("alertdialog").textContent).toContain(fp);
    fireEvent.click(screen.getByRole("button", { name: /Reject/ }));
    await waitFor(() => expect(a.decideCertificate).toHaveBeenCalledWith({ generation: GEN, sessionId: 4 }, fp, "reject"));
  });

  it("two sessions that ask at once open one dialog; the other says it is waiting", async () => {
    const q = (promptId: number) => [{ kind: "host_key" as const, promptId, text: "Are you sure (yes/no)?" }];
    mount(api({ sessionRows: [{ ...base, sessionId: 4, questions: q(1) }, { ...base, sessionId: 5, questions: q(2) }] }));
    await screen.findByRole("alertdialog");
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    expect(screen.getByText(/opens after the other one is answered/)).toBeTruthy();
  });

  it("a session opened by an archived thread says so and can be disconnected", async () => {
    const a = api({ sessionRows: [{ ...base, openedByArchivedThread: true }] });
    mount(a);
    const list = await screen.findByLabelText("Agent sessions");
    expect(list.textContent).toContain("opened by an archived thread (thr_a)");
    fireEvent.click(screen.getByRole("button", { name: "Disconnect build box" }));
    await waitFor(() => expect(a.disconnect).toHaveBeenCalled());
  });

  it("a session the owner took back shows the hold and offers to let agents drive again", async () => {
    const a = api({ sessionRows: [{ ...base, holdUntil: 1_700_000_000_000 }] });
    mount(a);
    const list = await screen.findByLabelText("Agent sessions");
    expect(list.textContent).toContain("kept by you until");
    fireEvent.click(screen.getByRole("button", { name: "Let agents drive build box again" }));
    await waitFor(() => expect(a.allowAgents).toHaveBeenCalledWith({ generation: GEN, sessionId: 4 }));
  });
});

