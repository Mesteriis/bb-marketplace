// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACCESS_NOTE, AgentPanel, type AgentApi, type AgentAuditView, type AgentGrantView, type AgentSessionView } from "./agent-panel.tsx";

afterEach(cleanup);
const P1 = "11111111-2222-4333-8444-555555555551";
const row = (over: Partial<AgentAuditView>): AgentAuditView => ({ id: 1, at: "2026-11-18T12:00:00.000Z", threadId: "thr_a", projectId: "prj_1", tool: "remote_terminal_read", profileId: P1, sessionKey: "g.1", detailMode: "none", detail: null, outcome: "ok", count: 1, ...over });

function api(over: Partial<AgentApi> & { grants?: AgentGrantView[]; rows?: AgentAuditView[]; sessionRows?: AgentSessionView[]; requireWatching?: boolean } = {}): AgentApi {
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
    settings: over.settings ?? vi.fn(async () => ({ requireWatching: over.requireWatching ?? true })),
    setRequireWatching: over.setRequireWatching ?? vi.fn(async (v: boolean) => ({ requireWatching: v, changed: true })),
  };
}
const names = new Map([[P1, "build box"]]);
const mount = (a: AgentApi) => render(<AgentPanel api={a} profileNames={names} onClose={() => {}} />);

describe("AgentPanel: the watching rule (stage 4c)", () => {
  it("states the mode prominently at the top: ON says agents act only while you watch", async () => {
    mount(api());
    const box = await screen.findByTestId("watching-rule");
    expect(box.textContent).toContain("Агенты действуют, только пока я смотрю сессию");
    expect(box.textContent).toContain("ВКЛ");
    expect(box.textContent).toContain("Ввод и команды агента отклоняются");
  });

  it("OFF says honestly that an agent can act while nobody looks, and what still stays visible", async () => {
    mount(api({ requireWatching: false }));
    const box = await screen.findByTestId("watching-rule");
    expect(box.textContent).toContain("ВЫКЛ");
    expect(box.textContent).toContain("Агент МОЖЕТ действовать, когда никто не смотрит");
    expect(box.textContent).toContain("Баннер");
  });

  it("turning it OFF asks for confirmation and only then changes it; turning it ON needs none", async () => {
    const a = api();
    mount(a);
    await screen.findByTestId("watching-rule");
    fireEvent.click(screen.getByRole("button", { name: "Выключить" }));
    expect(a.setRequireWatching).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog").textContent).toContain("может действовать, когда на сессию никто не смотрит");
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(a.setRequireWatching).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Выключить" }));
    fireEvent.click(screen.getByRole("button", { name: "Да, разрешить агентам действовать без наблюдения" }));
    await waitFor(() => expect(a.setRequireWatching).toHaveBeenCalledWith(false));
  });

  it("when it is OFF the button turns it back ON at once", async () => {
    const a = api({ requireWatching: false });
    mount(a);
    await screen.findByTestId("watching-rule");
    fireEvent.click(screen.getByRole("button", { name: "Включить" }));
    await waitFor(() => expect(a.setRequireWatching).toHaveBeenCalledWith(true));
  });

  it("a change of the rule is listed with the grant changes", async () => {
    mount(api({ rows: [row({ id: 9, tool: "access.require_watching", threadId: "owner RPC", projectId: "", profileId: null, sessionKey: null, detail: "off" })] }));
    const list = await screen.findByLabelText("Изменения доступа");
    expect(list.textContent).toContain("Правило наблюдения");
    expect(list.textContent).toContain("off");
  });
});

describe("AgentPanel", () => {
  it("says the grant applies to agents in ANY thread, the order of the levels, and that connect starts at input", async () => {
    mount(api());
    expect(ACCESS_NOTE).toContain("ЛЮБОМ треде этого BB");
    expect(ACCESS_NOTE).toContain("нет доступа < наблюдение < ввод < команды");
    expect(ACCESS_NOTE).toContain("подключаться можно начиная с ввода");
    expect(ACCESS_NOTE).toContain("всегда ваше решение");
    expect((await screen.findByLabelText("Активность агентов")).textContent).toContain("ЛЮБОМ треде этого BB");
  });

  it("Y1: the note does not claim agents never see secrets; it says what Observe shows and what is never given", async () => {
    expect(ACCESS_NOTE).not.toContain("never see or type a password or key");
    expect(ACCESS_NOTE).toContain("никогда не получают сохранённый пароль или ключ");
    expect(ACCESS_NOTE).toContain("всё, что печатает терминал");
    expect(ACCESS_NOTE).toContain("в том числе показанный там секрет");
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
    const changes = await screen.findByLabelText("Изменения доступа");
    expect(changes.textContent).toContain("exec <- observe");
    expect(changes.textContent).toContain("owner RPC");
    expect(changes.textContent).toContain("removed 2");
    expect(changes.textContent).not.toContain("remote_terminal_read");
    expect(screen.getByLabelText("Список активности агентов").textContent).toContain("remote_terminal_read");
    expect(screen.getByLabelText("Список активности агентов").textContent).not.toContain("access.set");
    const panel = screen.getByLabelText("Активность агентов");
    expect(panel.compareDocumentPosition(changes) & Node.DOCUMENT_POSITION_CONTAINED_BY).toBeTruthy();
    expect(changes.compareDocumentPosition(screen.getByLabelText("Разрешённые подключения")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(ACCESS_NOTE).toContain("ограничивают инструменты, выданные агентам");
    expect(ACCESS_NOTE).toContain("не песочница");
  });

  it("with no grants it says agents can use nothing, and the revoke-all button is off", async () => {
    mount(api());
    expect((await screen.findByLabelText("Активность агентов")).textContent).toContain("Агенты не видят и не используют подключения");
    expect((screen.getByRole("button", { name: "Отозвать весь доступ агентов" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("lists grants with profile names and revokes one", async () => {
    const a = api({ grants: [{ profileId: P1, level: "observe", recordCommands: false, updatedAt: "x" }] });
    mount(a);
    const list = await screen.findByLabelText("Разрешённые подключения");
    expect(list.textContent).toContain("build box");
    expect(list.textContent).toContain("observe");
    fireEvent.click(screen.getByLabelText("Отозвать доступ: build box"));
    await waitFor(() => expect(a.set).toHaveBeenCalledWith(P1, "none", false));
    await waitFor(() => expect(screen.getByLabelText("Активность агентов").textContent).toContain("Агенты не видят и не используют подключения"));
  });

  it("revoke all switches everything off and reports how many", async () => {
    const a = api({ grants: [{ profileId: P1, level: "observe", recordCommands: false, updatedAt: "x" }, { profileId: "p2", level: "exec", recordCommands: true, updatedAt: "x" }] });
    mount(a);
    await screen.findByLabelText("Разрешённые подключения");
    fireEvent.click(screen.getByRole("button", { name: "Отозвать весь доступ агентов" }));
    expect((await screen.findByRole("status")).textContent).toBe("Доступ агентов выключен, подключений: 2.");
    expect(a.revokeAll).toHaveBeenCalledTimes(1);
  });

  it("shows the thread, the tool, the connection and the outcome of each call, and calls that never finished", async () => {
    mount(api({ rows: [row({ id: 3, outcome: null, tool: "remote_rdp_screenshot", threadId: "thr_b" }), row({ id: 2, outcome: "agent_access_denied", profileId: null, sessionKey: null }), row({ id: 1, outcome: "rate_limited", count: 40 })] }));
    const list = await screen.findByLabelText("Список активности агентов");
    const text = list.textContent ?? "";
    expect(text).toContain("remote_rdp_screenshot");
    expect(text).toContain("не завершён (итог не записан)");
    expect(text).toContain("тред thr_b");
    expect(text).toContain("agent_access_denied");
    expect(text).toContain("×40");
    expect(text).toContain("build box");
    expect(text).toContain("сессия g.1");
  });

  it("says which recording mode was in effect for a recorded input, and never invents text", async () => {
    mount(api({ rows: [row({ id: 2, tool: "remote_ssh_exec", detailMode: "text", detail: "uptime" }), row({ id: 1, tool: "remote_terminal_input", detailMode: "length", detail: "len 4" })] }));
    const text = (await screen.findByLabelText("Список активности агентов")).textContent ?? "";
    expect(text).toContain("команда: uptime");
    expect(text).toContain("записана только длина");
    expect(text).not.toContain("1a2b");
  });

  it("an empty activity list says so, and a failing load is shown as an error", async () => {
    mount(api());
    expect((await screen.findByLabelText("Активность агентов")).textContent).toContain("Агенты ещё не вызывали инструменты Remote Hub.");
    cleanup();
    mount(api({ list: vi.fn(async () => { throw new Error("helper_unavailable: x"); }) }));
    expect((await screen.findByRole("alert")).textContent).not.toBe("");
  });
});


describe("AgentPanel: sessions agents opened or drive (stage 4b-1)", () => {
  const GEN = "a".repeat(32);
  const base: AgentSessionView = {
    generation: GEN, sessionId: 4, kind: "ssh", connectionId: P1, state: "running", openedByThread: "thr_a", controlledBy: "human",
    leaseThreadId: null, leaseExpiresAt: null, questions: [], certificate: null, openedByArchivedThread: false, holdUntil: null, watching: false, watchingRequired: true,
  };

  it("says whether anybody is watching each session, and that an unwatched one cannot be acted on", async () => {
    mount(api({ sessions: vi.fn(async () => [{ ...base, controlledBy: "agent" as const, leaseThreadId: "thr_a", watching: false }, { ...base, sessionId: 5, watching: true }]) }));
    await screen.findByText(/управляет агент/);
    const text = document.body.textContent ?? "";
    expect(text).toContain("никто не смотрит: агент не может действовать");
    expect(text).toContain("вы смотрите");
  });

  it("with the rule OFF an unwatched session is described as one an agent can act on anyway", async () => {
    mount(api({ sessionRows: [{ ...base, controlledBy: "agent" as const, leaseThreadId: "thr_a", watching: false, watchingRequired: false }] }));
    await screen.findByText(/управляет агент/);
    expect(document.body.textContent).toContain("ваша настройка разрешает агенту действовать");
  });

  it("says there are none when no agent opened or holds a session", async () => {
    mount(api());
    expect((await screen.findByLabelText("Сессии агентов")).textContent).toBe("");
    expect(screen.getByText(/Ни один агент не открыл и не ведёт сессию/)).toBeTruthy();
  });

  it("lists a session with its connection name, who opened it and who drives it; Take control calls the RPC with its handle", async () => {
    const a = api({ sessionRows: [{ ...base, controlledBy: "agent", leaseThreadId: "thr_a", leaseExpiresAt: 1_700_000_000_000 }] });
    mount(a);
    const list = await screen.findByLabelText("Сессии агентов");
    expect(list.textContent).toContain("build box");
    expect(list.textContent).toContain("открыта тредом агента thr_a");
    expect(list.textContent).toContain("управляет агент");
    fireEvent.click(screen.getByRole("button", { name: "Взять управление: build box" }));
    await waitFor(() => expect(a.takeover).toHaveBeenCalledWith({ generation: GEN, sessionId: 4 }));
  });

  it("there is no Take control when the human already drives, and Disconnect closes the session", async () => {
    const a = api({ sessionRows: [base] });
    mount(a);
    await screen.findByLabelText("Сессии агентов");
    expect(screen.queryByRole("button", { name: "Взять управление: build box" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Отключить: build box" }));
    await waitFor(() => expect(a.disconnect).toHaveBeenCalledWith({ generation: GEN, sessionId: 4 }));
  });

  it("a host-key question waits for the owner: the text is shown and the answer goes back with the prompt id", async () => {
    const a = api({ sessionRows: [{ ...base, state: "connecting", questions: [{ kind: "host_key", promptId: 7, text: "Are you sure you want to continue connecting (yes/no)?" }] }] });
    mount(a);
    expect((await screen.findByTestId("ssh-prompt-text")).textContent).toContain("Are you sure you want to continue connecting");
    fireEvent.change(screen.getByLabelText("Введите yes, чтобы продолжить"), { target: { value: "yes" } });
    fireEvent.keyDown(screen.getByLabelText("Введите yes, чтобы продолжить"), { key: "Enter" });
    await waitFor(() => expect(a.answer).toHaveBeenCalledWith({ generation: GEN, sessionId: 4 }, 7, "yes"));
  });

  it("a login question (one-time code) is typed here, masked, and sent once", async () => {
    const a = api({ sessionRows: [{ ...base, questions: [{ kind: "login_prompt", promptId: 9, text: "One-time code:" }] }] });
    mount(a);
    const field = (await screen.findByLabelText("Ответ")) as HTMLInputElement;
    expect(field.type).toBe("password");
    fireEvent.change(field, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
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
    fireEvent.click(screen.getByRole("button", { name: /Отклонить/ }));
    await waitFor(() => expect(a.decideCertificate).toHaveBeenCalledWith({ generation: GEN, sessionId: 4 }, fp, "reject"));
  });

  it("two sessions that ask at once open one dialog; the other says it is waiting", async () => {
    const q = (promptId: number) => [{ kind: "host_key" as const, promptId, text: "Are you sure (yes/no)?" }];
    mount(api({ sessionRows: [{ ...base, sessionId: 4, questions: q(1) }, { ...base, sessionId: 5, questions: q(2) }] }));
    await screen.findByRole("alertdialog");
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    expect(screen.getByText(/откроется после ответа на предыдущий/)).toBeTruthy();
  });

  it("a session opened by an archived thread says so and can be disconnected", async () => {
    const a = api({ sessionRows: [{ ...base, openedByArchivedThread: true }] });
    mount(a);
    const list = await screen.findByLabelText("Сессии агентов");
    expect(list.textContent).toContain("открыта архивным тредом (thr_a)");
    fireEvent.click(screen.getByRole("button", { name: "Отключить: build box" }));
    await waitFor(() => expect(a.disconnect).toHaveBeenCalled());
  });

  it("a session the owner took back shows the hold and offers to let agents drive again", async () => {
    const a = api({ sessionRows: [{ ...base, holdUntil: 1_700_000_000_000 }] });
    mount(a);
    const list = await screen.findByLabelText("Сессии агентов");
    expect(list.textContent).toContain("удерживаете вы до");
    fireEvent.click(screen.getByRole("button", { name: "Снова разрешить агентам: build box" }));
    await waitFor(() => expect(a.allowAgents).toHaveBeenCalledWith({ generation: GEN, sessionId: 4 }));
  });
});
