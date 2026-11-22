// The page side of chertog.open.v1: validate a request, ask the session,
// answer in the detail object before dispatch returns.
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OPEN_EVENT } from "../../../src/core/wire/index.ts";
import { useOpenRequests, type OpenTarget } from "../../../src/adapters/bb/app/open-requests.ts";

type Outcome = "opened" | "focused" | "refused" | "not-shown" | "unsupported";

function fakeSession(outcome: Outcome) {
  const calls: unknown[] = [];
  const session: OpenTarget = {
    openThread: (id) => { calls.push(["thread", id]); return outcome === "unsupported" ? "opened" : outcome; },
    openPanel: (ref) => { calls.push(["panel", ref]); return outcome; },
  };
  return { session, calls };
}

function send(detail: unknown) {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail }));
  return detail as { accepted: boolean; outcome: string | null };
}
const thread = () => ({ kind: "thread", threadId: "thr_1", accepted: false, outcome: null });
const panel = () => ({ kind: "panel", ref: { provider: "bb-diff", params: { path: "a.md" } }, accepted: false, outcome: null });

describe("useOpenRequests", () => {
  it("opens a thread on a shown page and accepts", () => {
    const { session, calls } = fakeSession("opened");
    renderHook(() => useOpenRequests(session));
    const detail = send(thread());
    expect(calls).toEqual([["thread", "thr_1"]]);
    expect(detail).toMatchObject({ accepted: true, outcome: "opened" });
  });

  it("opens a panel reference and accepts a focus", () => {
    const { session, calls } = fakeSession("focused");
    renderHook(() => useOpenRequests(session));
    const detail = send(panel());
    expect(calls).toEqual([["panel", panel().ref]]);
    expect(detail).toMatchObject({ accepted: true, outcome: "focused" });
  });

  it("accepts a refusal, because the page shows the notice", () => {
    const { session } = fakeSession("refused");
    renderHook(() => useOpenRequests(session));
    expect(send(thread())).toMatchObject({ accepted: true, outcome: "refused" });
  });

  it("leaves a request unaccepted when the page is not shown", () => {
    const { session } = fakeSession("not-shown");
    renderHook(() => useOpenRequests(session));
    expect(send(thread())).toMatchObject({ accepted: false, outcome: "not-shown" });
  });

  it("answers an unknown provider as unsupported and not accepted", () => {
    const { session } = fakeSession("unsupported");
    renderHook(() => useOpenRequests(session));
    expect(send(panel())).toMatchObject({ accepted: false, outcome: "unsupported" });
  });

  it("answers an invalid detail as invalid without throwing, and ignores a non-object", () => {
    const { session, calls } = fakeSession("opened");
    renderHook(() => useOpenRequests(session));
    expect(send({ kind: "thread", threadId: "", accepted: false, outcome: null })).toMatchObject({ accepted: false, outcome: "invalid" });
    expect(() => send(null)).not.toThrow();
    expect(() => send("thread")).not.toThrow();
    expect(calls).toEqual([]);
  });

  it("leaves a request another listener already accepted alone", () => {
    const { session, calls } = fakeSession("opened");
    renderHook(() => useOpenRequests(session));
    const detail = send({ ...thread(), accepted: true, outcome: "opened" });
    expect(calls).toEqual([]);
    expect(detail).toMatchObject({ accepted: true, outcome: "opened" });
  });

  it("stops listening on unmount", () => {
    const { session, calls } = fakeSession("opened");
    const view = renderHook(() => useOpenRequests(session));
    view.unmount();
    expect(send(thread())).toMatchObject({ accepted: false, outcome: null });
    expect(calls).toEqual([]);
  });
});
