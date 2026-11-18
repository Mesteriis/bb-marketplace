// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "../core/profile.ts";
import type { SessionInfo } from "../core/rpc.ts";
import { useProfiles, type ProfilesApi } from "./use-profiles.ts";

afterEach(cleanup);

const row = (id: string, name: string) => ({ id, name }) as Profile;
const A = row("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "a");
const B = row("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "b");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("useProfiles drops superseded responses (P3)", () => {
  it("an older list refresh resolving after a newer one cannot bring a deleted row back", async () => {
    const first = deferred<Profile[]>();
    const second = deferred<Profile[]>();
    const lists = [first, second];
    const api = {
      list: vi.fn(() => (lists.shift() as ReturnType<typeof deferred<Profile[]>>).promise),
      save: vi.fn(),
      remove: vi.fn(),
      duplicate: vi.fn(),
      sessions: vi.fn(async () => [] as SessionInfo[]),
    } satisfies ProfilesApi;
    const { result } = renderHook(() => useProfiles(api));
    // The first refresh (mount) is slow. A second one starts after a delete.
    let secondReload!: Promise<void>;
    act(() => {
      secondReload = result.current.reload();
    });
    await act(async () => {
      second.resolve([B]); // the newer answer: A is gone
      await secondReload;
    });
    expect(result.current.profiles?.map((p) => p.name)).toEqual(["b"]);
    await act(async () => {
      first.resolve([A, B]); // the older answer arrives late
      await Promise.resolve();
    });
    expect(result.current.profiles?.map((p) => p.name)).toEqual(["b"]);
  });

  it("an older session-status response cannot replace a newer one", async () => {
    const slow = deferred<SessionInfo[]>();
    const fastSession = { sessionId: 7 } as SessionInfo;
    const answers = [Promise.resolve([] as SessionInfo[]), slow.promise, Promise.resolve([fastSession])];
    const api = {
      list: vi.fn(async () => [] as Profile[]),
      save: vi.fn(),
      remove: vi.fn(),
      duplicate: vi.fn(),
      sessions: vi.fn(() => answers.shift() as Promise<SessionInfo[]>),
    } satisfies ProfilesApi;
    const { result } = renderHook(() => useProfiles(api));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => void result.current.reloadSessions()); // slow
    await act(async () => {
      await result.current.reloadSessions(); // fast and newer
    });
    expect(result.current.sessions).toEqual([fastSession]);
    await act(async () => {
      slow.resolve([{ sessionId: 1 } as SessionInfo]);
      await Promise.resolve();
    });
    expect(result.current.sessions).toEqual([fastSession]);
  });
});
