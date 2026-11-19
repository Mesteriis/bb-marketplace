// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentAccessSection } from "./agent-access-section.tsx";
import type { AgentApi } from "./agent-panel.tsx";

afterEach(cleanup);
const P1 = "11111111-2222-4333-8444-555555555551";

function api(initial: Array<{ level: "observe" | "input" | "exec"; recordCommands: boolean }> = []): AgentApi {
  return {
    list: vi.fn(async () => initial.map((g) => ({ profileId: P1, ...g, updatedAt: "x" }))),
    set: vi.fn(async (profileId, level, recordCommands) => ({ profileId, level, recordCommands: level === "exec" && recordCommands })),
    revokeAll: vi.fn(async () => ({ revoked: 0 })),
    audit: vi.fn(async () => []),
    sessions: vi.fn(async () => []),
    takeover: vi.fn(async () => ({ tookOver: false })),
    allowAgents: vi.fn(async () => ({ allowed: false })),
    answer: vi.fn(async () => ({ answered: true as const })),
    decideCertificate: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    settings: vi.fn(async () => ({ requireWatching: true })),
    setRequireWatching: vi.fn(async (v: boolean) => ({ requireWatching: v, changed: true })),
  };
}

describe("AgentAccessSection", () => {
  it("says what the grant means: any thread, the order of the levels, connect from input, host keys and certificates stay the owner's", async () => {
    render(<AgentAccessSection api={api()} profileId={P1} />);
    const section = await screen.findByLabelText("Доступ агентов");
    expect(section.textContent).toContain("Applies to agents in ANY thread of this BB");
    expect(section.textContent).toContain("no access < observe < input < exec");
    expect(section.textContent).toContain("connecting is allowed from input up");
    expect(section.textContent).toContain("a new host key or a changed certificate is always your decision");
  });

  it("an unsaved profile has nothing to grant", () => {
    render(<AgentAccessSection api={api()} profileId={null} />);
    expect(screen.getByLabelText("Доступ агентов").textContent).toContain("Сначала сохраните подключение");
    expect(screen.queryByLabelText("Уровень доступа агентов")).toBeNull();
  });

  it("starts at the current level and applies a change at once, without Save", async () => {
    const a = api([{ level: "observe", recordCommands: false }]);
    render(<AgentAccessSection api={a} profileId={P1} />);
    const select = (await screen.findByLabelText("Уровень доступа агентов")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("observe"));
    fireEvent.change(select, { target: { value: "none" } });
    await waitFor(() => expect(a.set).toHaveBeenCalledWith(P1, "none", false));
    expect((await screen.findByRole("status")).textContent).toBe("Агенты больше не могут пользоваться этим подключением.");
  });

  it("recording commands is offered only at exec, is off by default, and is sent explicitly", async () => {
    const a = api([{ level: "input", recordCommands: false }]);
    render(<AgentAccessSection api={a} profileId={P1} />);
    const select = (await screen.findByLabelText("Уровень доступа агентов")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("input"));
    expect(screen.queryByLabelText(/Записывать текст команд/)).toBeNull();
    fireEvent.change(select, { target: { value: "exec" } });
    const box = (await screen.findByLabelText(/Записывать текст команд/)) as HTMLInputElement;
    expect(a.set).toHaveBeenLastCalledWith(P1, "exec", false);
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await waitFor(() => expect(a.set).toHaveBeenLastCalledWith(P1, "exec", true));
  });

  it("a refusal is shown", async () => {
    const a = api();
    a.set = vi.fn(async () => {
      throw new Error("not_found: no such profile");
    });
    render(<AgentAccessSection api={a} profileId={P1} />);
    const select = (await screen.findByLabelText("Уровень доступа агентов")) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    fireEvent.change(select, { target: { value: "observe" } });
    expect((await screen.findByRole("alert")).textContent).not.toBe("");
  });
});
