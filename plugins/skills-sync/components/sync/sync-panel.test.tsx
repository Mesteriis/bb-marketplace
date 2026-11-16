// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  loadPluginApp,
  renderSlot,
  type PluginRpcTestHandlers,
} from "@get-bb/plugin-sdk/testing/app";
import { toast } from "sonner";
import type { rpcContract } from "@/contract";
import type { CatalogueEntry, Merge, SkillStatus, Status } from "./model";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

type Contract = typeof rpcContract;

function skill(name: string, overrides: Partial<SkillStatus> = {}): SkillStatus {
  return {
    name,
    bucket: "clean",
    upstreamBucket: "",
    substantiveFiles: ["SKILL.md"],
    cosmeticFiles: [],
    localEditedFiles: [],
    ...overrides,
  };
}

function entry(
  name: string,
  overrides: Partial<CatalogueEntry> = {},
): CatalogueEntry {
  return {
    name,
    upstreamBucket: "writing",
    description: `What ${name} does.`,
    offered: false,
    ...overrides,
  };
}


/** One `mergeState` answer. A merge is staged outside the skills folder. */
function merge(
  state: "none" | "running" | "ready" | "failed",
  overrides: Partial<Merge> = {},
): Merge {
  return {
    state,
    threadId: state === "none" ? null : "thread-42",
    stagingDir: state === "ready" ? "/tmp/cache/merge/conflicted" : null,
    error: null,
    ...overrides,
  };
}

const STATUS: Status = {
  sourceId: "matt",
  pinned: "aaaaaaaaaaaa",
  head: "bbbbbbbbbbbb",
  commits: [{ sha: "bbbbbbbbbbbb", subject: "Add tdd skill" }],
  skills: [
    skill("brand-new", { bucket: "new", substantiveFiles: [] }),
    skill("retired", { bucket: "deprecated", substantiveFiles: [] }),
    skill("clean-one"),
    skill("clean-cosmetic", { substantiveFiles: [], cosmeticFiles: ["SKILL.md"] }),
    skill("conflicted", {
      bucket: "dirty-conflict",
      localEditedFiles: ["SKILL.md"],
    }),
    skill("mine-only", {
      bucket: "dirty-only",
      substantiveFiles: [],
      localEditedFiles: ["SKILL.md"],
    }),
  ],
  foreign: ["some-other-skill", "and-another"],
  catalogue: [
    entry("declined-once"),
    entry("brand-new", { offered: true, upstreamBucket: "" }),
  ],
  // Overridden per call in `handlers` so the age line is relative to now.
  fetchedAt: null,
  autoFetchHours: 0,
};

const SOURCE = {
  id: "matt",
  url: "https://example.test/skills.git",
  ref: "HEAD",
  skillsDir: "skills",
  nested: true,
  skipBuckets: [],
  installRoot: "/tmp/skills",
  marker: ".pin",
};

function handlers(overrides: Partial<PluginRpcTestHandlers<Contract>> = {}) {
  return {
    listSources: () => ({ sources: [SOURCE] }),
    status: () => ({ ...STATUS, fetchedAt: Date.now() - 4 * 60_000 }),
    diff: () => ({ patch: "" }),
    apply: () => ({
      applied: [],
      failed: [],
      markerRefusal: null,
      marker: "bbbbbbbbbbbb",
    }),
    mergeStart: () => merge("running"),
    mergeState: () => merge("none"),
    mergeDiff: () => ({ patch: "" }),
    mergeAccept: () => ({ backup: "/tmp/skills/.backups/conflicted" }),
    mergeCancel: () => ({ ok: true as const }),
    mergeDiscard: () => ({ ok: true as const }),
    ...overrides,
  } as PluginRpcTestHandlers<Contract>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = (value) => resolvePromise(value);
    reject = (cause) => rejectPromise(cause);
  });
  return { promise, resolve, reject };
}

function patchFor(path: string): string {
  return `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;
}

async function mountPanel(rpc: PluginRpcTestHandlers<Contract>) {
  const app = await loadPluginApp(() => import("@/app"));
  const panel = app.navPanels.find((entry) => entry.id === "sync");
  expect(panel).toBeDefined();
  const rendered = renderSlot<{ subPath: string }, Contract>(
    panel!,
    { subPath: "" },
    { rpc },
  );
  await screen.findByRole("region", { name: "Clean updates" });
  return rendered;
}

/** Radix renders a checkbox as a button carrying aria-checked. */
function checkedState(label: string): string | null {
  return screen.getByLabelText(label).getAttribute("aria-checked");
}

function section(title: string): HTMLElement {
  return screen.getByRole("region", { name: title });
}

function rowNames(title: string): string[] {
  return within(section(title))
    .getAllByRole("listitem")
    .map((item) => item.querySelector(".font-mono")?.textContent ?? "");
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Skills Sync panel", () => {
  it("registers one nav panel at sync", async () => {
    const app = await loadPluginApp(() => import("@/app"));
    expect(app.navPanels).toHaveLength(1);
    expect(app.navPanels[0]).toMatchObject({
      id: "sync",
      path: "sync",
      title: "Skills Sync",
      icon: "RefreshCw",
    });
  });

  it("puts each skill in its own titled section", async () => {
    await mountPanel(handlers());
    expect(rowNames("New")).toEqual(["brand-new"]);
    expect(rowNames("Deprecated")).toEqual(["retired"]);
    expect(rowNames("Clean updates")).toEqual(["clean-one", "clean-cosmetic"]);
    expect(rowNames("Needs a merge")).toEqual(["conflicted"]);
    // dirty-only starts folded, so only its heading is on screen.
    expect(section("Your edits, untouched upstream")).toBeTruthy();
    expect(screen.queryByLabelText("Apply mine-only")).toBeNull();
  });

  it("checks clean rows by default and leaves new rows unchecked", async () => {
    await mountPanel(handlers());
    expect(checkedState("Apply clean-one")).toBe("true");
    expect(checkedState("Apply clean-cosmetic")).toBe("true");
    expect(checkedState("Apply brand-new")).toBe("false");
  });

  it("gives conflicted and deprecated rows no checkbox", async () => {
    await mountPanel(handlers());
    expect(screen.queryByLabelText("Apply conflicted")).toBeNull();
    expect(screen.queryByLabelText("Apply retired")).toBeNull();
    expect(within(section("Needs a merge")).queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("labels a purely cosmetic change as punctuation only", async () => {
    await mountPanel(handlers());
    const rows = within(section("Clean updates")).getAllByRole("listitem");
    expect(rows[1].textContent).toContain("punctuation only");
    expect(rows[0].textContent).toContain("1 file changed");
  });

  it("applies exactly the checked names", async () => {
    const apply = vi.fn(() => ({
      applied: ["clean-one", "clean-cosmetic", "brand-new"],
      failed: [],
      markerRefusal: null,
      marker: "bbbbbbbbbbbb",
    }));
    const rendered = await mountPanel(handlers({ apply }));
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Apply brand-new"));
    await user.click(screen.getByLabelText("Apply clean-cosmetic"));
    await user.click(screen.getByRole("button", { name: /Apply 2 skills/ }));
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    const call = rendered.rpcCalls.find((entry) => entry.method === "apply");
    expect(call?.input).toEqual({
      sourceId: "matt",
      names: ["brand-new", "clean-one"],
      // A conflict is still outstanding, so the pin must not move.
      bumpMarker: false,
      allowConflictOverwrite: false,
    });
  });

  it("reports a marker refusal separately from real skill failures", async () => {
    const apply = vi.fn(() => ({
      applied: ["clean-one"],
      failed: [{ name: "clean-cosmetic", error: "permission denied" }],
      markerRefusal: "clean-cosmetic still needs attention",
      marker: "aaaaaaaaaaaa",
    }));
    await mountPanel(handlers({ apply }));
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /Apply 2 skills/ }));
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(toast.error).toHaveBeenCalledWith(
      "Applied 1, 1 failed: clean-cosmetic (permission denied)",
    );
    expect(toast.warning).toHaveBeenCalledWith(
      "The pin did not move: clean-cosmetic still needs attention",
    );
  });

  it("does not let an old diff settle overwrite a newer status generation", async () => {
    const firstDiff = deferred<{ patch: string }>();
    const secondDiff = deferred<{ patch: string }>();
    let diffCalls = 0;
    const diff = vi.fn(() =>
      diffCalls++ === 0 ? firstDiff.promise : secondDiff.promise,
    );
    const replacementStatus = deferred<Status>();
    let statusCalls = 0;
    const status = vi.fn(() =>
      statusCalls++ === 0 ? STATUS : replacementStatus.promise,
    );
    const rendered = await mountPanel(handlers({ status, diff }));
    const user = userEvent.setup();
    const cleanOne = () =>
      within(section("Clean updates")).getByRole("button", { name: /clean-one/ });

    await user.click(cleanOne());
    await waitFor(() => expect(diff).toHaveBeenCalledTimes(1));

    await rendered.emitRealtime("skills-applied", null);
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2));
    replacementStatus.resolve({ ...STATUS, head: "cccccccccccc" });
    expect(await screen.findByText("ccccccc")).toBeTruthy();

    await user.click(cleanOne());
    await waitFor(() => expect(diff).toHaveBeenCalledTimes(2));
    await act(async () => {
      secondDiff.resolve({ patch: patchFor("new-file.md") });
      await secondDiff.promise;
    });
    expect(await screen.findByText("new-file.md")).toBeTruthy();

    await act(async () => {
      firstDiff.resolve({ patch: patchFor("old-file.md") });
      await firstDiff.promise;
    });
    expect(screen.getByText("new-file.md")).toBeTruthy();
    expect(screen.queryByText("old-file.md")).toBeNull();
  });

  it("can load a diff again after a refetch fails", async () => {
    const firstDiff = deferred<{ patch: string }>();
    const secondDiff = deferred<{ patch: string }>();
    let diffCalls = 0;
    const diff = vi.fn(() =>
      diffCalls++ === 0 ? firstDiff.promise : secondDiff.promise,
    );
    const failedStatus = deferred<Status>();
    let statusCalls = 0;
    const status = vi.fn(() =>
      statusCalls++ === 0 ? STATUS : failedStatus.promise,
    );
    const rendered = await mountPanel(handlers({ status, diff }));
    const user = userEvent.setup();
    const cleanOne = () =>
      within(section("Clean updates")).getByRole("button", { name: /clean-one/ });

    await user.click(cleanOne());
    await waitFor(() => expect(diff).toHaveBeenCalledTimes(1));

    await rendered.emitRealtime("skills-applied", null);
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2));
    failedStatus.reject(new Error("refresh failed"));
    expect(await screen.findByText("refresh failed")).toBeTruthy();

    await user.click(cleanOne());
    await user.click(cleanOne());
    await waitFor(() => expect(diff).toHaveBeenCalledTimes(2));
    await act(async () => {
      secondDiff.resolve({ patch: patchFor("retry-file.md") });
      await secondDiff.promise;
    });
    expect(await screen.findByText("retry-file.md")).toBeTruthy();

    await act(async () => {
      firstDiff.resolve({ patch: patchFor("stale-file.md") });
      await firstDiff.promise;
    });
    expect(screen.getByText("retry-file.md")).toBeTruthy();
    expect(screen.queryByText("stale-file.md")).toBeNull();
  });

  it("fetches a diff on first expand", async () => {
    const diff = vi.fn(() => ({ patch: "diff --git a/SKILL.md b/SKILL.md\n" }));
    const rendered = await mountPanel(handlers({ diff }));
    const user = userEvent.setup();
    await user.click(
      within(section("Clean updates")).getByRole("button", { name: /clean-one/ }),
    );
    await waitFor(() => expect(diff).toHaveBeenCalledTimes(1));
    expect(rendered.rpcCalls.at(-1)?.input).toEqual({
      sourceId: "matt",
      name: "clean-one",
      kind: "upstream",
    });
  });

  it("fetches a diff again after status refetch clears the cache", async () => {
    const diff = vi.fn(() => ({
      patch: "diff --git a/SKILL.md b/SKILL.md\nindex 1111111..2222222 100644\n--- a/SKILL.md\n+++ b/SKILL.md\n@@ -1 +1 @@\n-old\n+new\n",
    }));
    const rendered = await mountPanel(handlers({ diff }));
    const user = userEvent.setup();
    const cleanOne = () =>
      within(section("Clean updates")).getByRole("button", { name: /clean-one/ });

    await user.click(cleanOne());
    await waitFor(() => expect(diff).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("SKILL.md")).toBeTruthy();

    await rendered.emitRealtime("skills-applied", null);
    await waitFor(() =>
      expect(
        rendered.rpcCalls.filter((entry) => entry.method === "status"),
      ).toHaveLength(2),
    );

    await user.click(cleanOne());
    await waitFor(() => expect(diff).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("SKILL.md")).toBeTruthy();
  });

  it("mentions the untouched skills from other sources", async () => {
    await mountPanel(handlers());
    expect(
      screen.getByText(
        "2 other skills from different sources, never touched by this plugin",
      ),
    ).toBeTruthy();
  });

  it("shows the all-clear when no skill differs", async () => {
    const app = await loadPluginApp(() => import("@/app"));
    renderSlot<{ subPath: string }, Contract>(
      app.navPanels[0],
      { subPath: "" },
      {
        rpc: handlers({
          status: () => ({ ...STATUS, skills: [], commits: [], foreign: [] }),
        }),
      },
    );
    expect(await screen.findByText(/Up to date with bbbbbbb/)).toBeTruthy();
  });

  it("says how long ago upstream was checked", async () => {
    await mountPanel(handlers());
    expect(screen.getByText("checked 4 minutes ago")).toBeTruthy();
    expect(
      screen.queryByText(/come from the last check, not from upstream/),
    ).toBeNull();
  });

  it("marks an old check as not a live answer", async () => {
    await mountPanel(
      handlers({
        status: () => ({
          ...STATUS,
          fetchedAt: Date.now() - 3 * 24 * 60 * 60 * 1000,
        }),
      }),
    );
    expect(screen.getByText("checked 3 days ago")).toBeTruthy();
    expect(
      screen.getByText(
        "Those numbers come from the last check, not from upstream right now.",
      ),
    ).toBeTruthy();
  });

  it("says so when the clone has never fetched", async () => {
    await mountPanel(handlers({ status: () => STATUS }));
    expect(screen.getByText("never checked")).toBeTruthy();
  });

  it("loads the panel from the cache, never from the network", async () => {
    const rendered = await mountPanel(handlers());
    expect(
      rendered.rpcCalls.filter((entry) => entry.method === "status"),
    ).toEqual([{ method: "status", input: { sourceId: "matt", refresh: false } }]);
  });

  it("checks upstream on request, and says it is working", async () => {
    const refreshed = deferred<Status>();
    let calls = 0;
    const status = vi.fn(() =>
      calls++ === 0
        ? { ...STATUS, fetchedAt: Date.now() - 4 * 60_000 }
        : refreshed.promise,
    );
    const rendered = await mountPanel(handlers({ status }));
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /Check upstream/ }));
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2));
    expect(
      rendered.rpcCalls.filter((entry) => entry.method === "status").at(-1),
    ).toEqual({
      method: "status",
      input: { sourceId: "matt", refresh: true },
    });
    expect(screen.getByRole("button", { name: /Checking/ })).toBeTruthy();

    await act(async () => {
      refreshed.resolve({ ...STATUS, head: "cccccccccccc", fetchedAt: Date.now() });
      await refreshed.promise;
    });
    expect(await screen.findByText("ccccccc")).toBeTruthy();
    expect(screen.getByText("checked just now")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Check upstream/ })).toBeTruthy();
  });

  it("leaves the panel usable when a check upstream fails", async () => {
    const failed = deferred<Status>();
    let calls = 0;
    const status = vi.fn(() =>
      calls++ === 0
        ? { ...STATUS, fetchedAt: Date.now() - 4 * 60_000 }
        : failed.promise,
    );
    await mountPanel(handlers({ status }));
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /Check upstream/ }));
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2));
    failed.reject(new Error("could not reach the remote"));

    expect(await screen.findByText("could not reach the remote")).toBeTruthy();
    // The button comes back out of its pending state so it can be tried again.
    expect(
      screen.getByRole("button", { name: /Check upstream/ }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("keeps the not-installed catalogue folded away and unticked", async () => {
    await mountPanel(handlers());
    expect(screen.queryByLabelText("Install declined-once")).toBeNull();
    const user = userEvent.setup();
    await user.click(
      screen.getByText("2 more skills upstream you have not installed"),
    );
    expect(checkedState("Install declined-once")).toBe("false");
    expect(checkedState("Install brand-new")).toBe("false");
    expect(screen.getByText("What declined-once does.")).toBeTruthy();
    expect(within(section("Available, not installed")).getByText("writing")).toBeTruthy();
  });

  it("installs a catalogue pick through the same Apply button", async () => {
    const apply = vi.fn(() => ({
      applied: ["clean-one", "clean-cosmetic", "declined-once"],
      failed: [],
      markerRefusal: null,
      marker: "bbbbbbbbbbbb",
    }));
    const rendered = await mountPanel(handlers({ apply }));
    const user = userEvent.setup();
    await user.click(
      screen.getByText("2 more skills upstream you have not installed"),
    );
    await user.click(screen.getByLabelText("Install declined-once"));
    await user.click(screen.getByRole("button", { name: /Apply 3 skills/ }));
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    const call = rendered.rpcCalls.find((entry) => entry.method === "apply");
    expect(call?.input).toEqual({
      sourceId: "matt",
      names: ["clean-one", "clean-cosmetic", "declined-once"],
      bumpMarker: false,
      allowConflictOverwrite: false,
    });
  });

  it("ticks a catalogue row and its New row together", async () => {
    await mountPanel(handlers());
    const user = userEvent.setup();
    await user.click(
      screen.getByText("2 more skills upstream you have not installed"),
    );
    await user.click(screen.getByLabelText("Install brand-new"));
    expect(checkedState("Apply brand-new")).toBe("true");
  });

  it("still refuses a checkbox on a skill with local edits", async () => {
    await mountPanel(handlers());
    const user = userEvent.setup();
    expect(screen.queryByLabelText("Apply conflicted")).toBeNull();
    await user.click(
      within(section("Needs a merge")).getByRole("button", { name: /conflicted/ }),
    );
    expect(
      screen.getByText(/Applying this would overwrite your edit/),
    ).toBeTruthy();
  });

  it("refetches after the realtime connection comes back", async () => {
    const rendered = await mountPanel(handlers());
    const statusCalls = () =>
      rendered.rpcCalls.filter((entry) => entry.method === "status").length;
    expect(statusCalls()).toBe(1);

    // The first connect is the mount itself; the initial load already covers it.
    await rendered.setRealtimeConnectionState("connected");
    expect(statusCalls()).toBe(1);

    await rendered.setRealtimeConnectionState("reconnecting");
    await rendered.setRealtimeConnectionState("connected");
    await waitFor(() => expect(statusCalls()).toBe(2));
    // A reconnect must not turn into network work of its own.
    expect(
      rendered.rpcCalls.filter((entry) => entry.method === "status").at(-1)?.input,
    ).toEqual({ sourceId: "matt", refresh: false });
  });

  it("shows the error message and offers a retry", async () => {
    const app = await loadPluginApp(() => import("@/app"));
    renderSlot<{ subPath: string }, Contract>(
      app.navPanels[0],
      { subPath: "" },
      {
        rpc: handlers({
          status: () => {
            throw new Error("git fetch failed");
          },
        }),
      },
    );
    expect(await screen.findByText("git fetch failed")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Retry/ })).toBeTruthy();
  });

  it("retries against upstream, not against the cache that failed", async () => {
    let calls = 0;
    const status = vi.fn(() => {
      // The cache is broken: reading it again would fail again forever.
      if (calls++ === 0) throw new Error("cached clone is corrupt");
      return { ...STATUS, fetchedAt: Date.now() };
    });
    const app = await loadPluginApp(() => import("@/app"));
    const rendered = renderSlot<{ subPath: string }, Contract>(
      app.navPanels[0],
      { subPath: "" },
      { rpc: handlers({ status }) },
    );
    expect(await screen.findByText("cached clone is corrupt")).toBeTruthy();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Retry/ }));
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2));
    expect(
      rendered.rpcCalls.filter((entry) => entry.method === "status").at(-1),
    ).toEqual({
      method: "status",
      input: { sourceId: "matt", refresh: true },
    });
    expect(await screen.findByRole("region", { name: "Clean updates" })).toBeTruthy();
  });

  it("retries the source list itself when that is what failed", async () => {
    let calls = 0;
    const listSources = vi.fn(() => {
      if (calls++ === 0) throw new Error("no sources file");
      return { sources: [SOURCE] };
    });
    const app = await loadPluginApp(() => import("@/app"));
    const rendered = renderSlot<{ subPath: string }, Contract>(
      app.navPanels[0],
      { subPath: "" },
      { rpc: handlers({ listSources }) },
    );
    expect(await screen.findByText("no sources file")).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Retry/ }));
    await waitFor(() => expect(listSources).toHaveBeenCalledTimes(2));
    expect(
      rendered.rpcCalls.filter((entry) => entry.method === "listSources"),
    ).toHaveLength(2);
    expect(await screen.findByRole("region", { name: "Clean updates" })).toBeTruthy();
  });
});

/** Open the one route that can overwrite a skill the user edited. */
async function openConflictFlow(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    within(section("Needs a merge")).getByRole("button", { name: /conflicted/ }),
  );
  await user.click(
    screen.getByRole("button", { name: /Replace conflicted with upstream/ }),
  );
  return screen.findByRole("dialog");
}

describe("resolving a conflict from the panel", () => {
  it("asks before it overwrites, and names what is lost", async () => {
    const apply = vi.fn(() => ({
      applied: [],
      failed: [],
      markerRefusal: null,
      marker: null,
    }));
    await mountPanel(handlers({ apply }));
    const user = userEvent.setup();
    const dialog = await openConflictFlow(user);

    expect(
      within(dialog).getByText("Replace your conflicted with upstream"),
    ).toBeTruthy();
    expect(within(dialog).getByText(/what you wrote is what you lose/)).toBeTruthy();
    // Both sides are on screen before the question is answered.
    expect(within(dialog).getByText("Your changes — these go")).toBeTruthy();
    expect(
      within(dialog).getByText("Upstream changes — these arrive"),
    ).toBeTruthy();
    expect(apply).not.toHaveBeenCalled();
  });

  it("overwrites exactly the one skill, and only on confirmation", async () => {
    const apply = vi.fn(() => ({
      applied: ["conflicted"],
      failed: [],
      markerRefusal: null,
      marker: null,
    }));
    const rendered = await mountPanel(handlers({ apply }));
    const user = userEvent.setup();
    const dialog = await openConflictFlow(user);

    await user.click(
      within(dialog).getByRole("button", { name: /Replace conflicted/ }),
    );
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    const call = rendered.rpcCalls.find((entry) => entry.method === "apply");
    expect(call?.input).toEqual({
      sourceId: "matt",
      names: ["conflicted"],
      bumpMarker: false,
      allowConflictOverwrite: true,
    });
    expect(toast.success).toHaveBeenCalledWith("conflicted now matches upstream.");
  });

  it("keeps the user's version when they back out", async () => {
    const apply = vi.fn(() => ({
      applied: [],
      failed: [],
      markerRefusal: null,
      marker: null,
    }));
    await mountPanel(handlers({ apply }));
    const user = userEvent.setup();
    const dialog = await openConflictFlow(user);

    await user.click(
      within(dialog).getByRole("button", { name: "Keep my version" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(apply).not.toHaveBeenCalled();
  });

  it("says where the replaced version was saved", async () => {
    const apply = vi.fn(() => ({
      applied: ["conflicted"],
      failed: [],
      markerRefusal: null,
      marker: null,
      // Not in the RPC contract yet; the panel reads it if the backend sends it.
      backups: [{ name: "conflicted", path: "/tmp/skills/.backups/conflicted" }],
    }));
    await mountPanel(handlers({ apply }));
    const user = userEvent.setup();
    const dialog = await openConflictFlow(user);
    await user.click(
      within(dialog).getByRole("button", { name: /Replace conflicted/ }),
    );
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Your old version was saved.")).toBeTruthy();
    expect(
      screen.getByText("/tmp/skills/.backups/conflicted"),
    ).toBeTruthy();
  });

  it("claims no backup path when the backend reports none", async () => {
    await mountPanel(handlers());
    const user = userEvent.setup();
    const dialog = await openConflictFlow(user);
    await user.click(
      within(dialog).getByRole("button", { name: /Replace conflicted/ }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(screen.queryByText("Your old version was saved.")).toBeNull();
  });

  it("reports a refused overwrite instead of claiming success", async () => {
    const apply = vi.fn(() => ({
      applied: [],
      failed: [{ name: "conflicted", error: "permission denied" }],
      markerRefusal: null,
      marker: null,
    }));
    await mountPanel(handlers({ apply }));
    const user = userEvent.setup();
    const dialog = await openConflictFlow(user);
    await user.click(
      within(dialog).getByRole("button", { name: /Replace conflicted/ }),
    );
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(toast.error).toHaveBeenCalledWith(
      "conflicted was not replaced: permission denied",
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("offers the overwrite one skill at a time, never in bulk", async () => {
    await mountPanel(
      handlers({
        status: () => ({
          ...STATUS,
          fetchedAt: Date.now(),
          skills: [
            skill("conflicted", {
              bucket: "dirty-conflict",
              localEditedFiles: ["SKILL.md"],
            }),
            skill("also-conflicted", {
              bucket: "dirty-conflict",
              localEditedFiles: ["SKILL.md"],
            }),
            skill("clean-one"),
          ],
        }),
      }),
    );
    const merge = section("Needs a merge");
    // No checkbox and no select-all: two conflicts cannot be swept away at once.
    expect(within(merge).queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.queryByLabelText("Apply conflicted")).toBeNull();
    expect(screen.queryByLabelText("Apply also-conflicted")).toBeNull();

    const user = userEvent.setup();
    await user.click(within(merge).getByRole("button", { name: /^conflicted/ }));
    const buttons = screen.getAllByRole("button", {
      name: /Replace .* with upstream/,
    });
    expect(buttons).toHaveLength(1);
  });
});

/** Open the conflicted row so its three ways out are on screen. */
async function expandConflict(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    within(section("Needs a merge")).getByRole("button", { name: /^conflicted/ }),
  );
}

function mergeRegion(): HTMLElement {
  return screen.getByRole("region", { name: "Agent merge for conflicted" });
}

describe("handing a conflict to an agent", () => {
  it("starts a merge for exactly one skill and shows it working", async () => {
    const mergeStart = vi.fn(() => merge("running"));
    const rendered = await mountPanel(handlers({ mergeStart }));
    const user = userEvent.setup();
    await expandConflict(user);

    // Nothing is started until the user asks for it, and only the one open
    // row offers it: there is no gesture that merges several skills at once.
    expect(mergeStart).not.toHaveBeenCalled();
    expect(
      screen.getAllByRole("button", { name: /Merge .* with an agent/ }),
    ).toHaveLength(1);
    await user.click(
      screen.getByRole("button", { name: /Merge conflicted with an agent/ }),
    );
    await waitFor(() => expect(mergeStart).toHaveBeenCalledTimes(1));
    const calls = rendered.rpcCalls.filter(
      (entry) => entry.method === "mergeStart",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toEqual({ sourceId: "matt", name: "conflicted" });
  });

  it("says it is working, that it may ask, and that nothing was written", async () => {
    await mountPanel(handlers());
    const user = userEvent.setup();
    await expandConflict(user);
    await user.click(
      screen.getByRole("button", { name: /Merge conflicted with an agent/ }),
    );

    const region = await screen.findByRole("region", {
      name: "Agent merge for conflicted",
    });
    expect(within(region).getByText(/An agent is merging conflicted/)).toBeTruthy();
    expect(within(region).getByText(/may stop and ask you a question/)).toBeTruthy();
    expect(within(region).getByText(/has not been touched/)).toBeTruthy();
  });

  it("embeds the agent's thread so the user can answer it", async () => {
    await mountPanel(handlers());
    const user = userEvent.setup();
    await expandConflict(user);
    await user.click(
      screen.getByRole("button", { name: /Merge conflicted with an agent/ }),
    );

    const chat = await screen.findByTestId("bb-thread-chat");
    expect(chat.getAttribute("data-thread-id")).toBe("thread-42");
    expect(mergeRegion().contains(chat)).toBe(true);
  });

  it("picks up a merge that finished while the panel was elsewhere", async () => {
    await mountPanel(handlers({ mergeState: () => merge("ready") }));
    const user = userEvent.setup();
    await expandConflict(user);
    expect(
      await screen.findByText(/The agent finished merging conflicted/),
    ).toBeTruthy();
    // The offer to start one is gone: there is already a merge to look at.
    expect(
      screen.queryByRole("button", { name: /Merge conflicted with an agent/ }),
    ).toBeNull();
  });

  it("shows a finished merge when the backend signals, without polling for it", async () => {
    let state: "none" | "running" | "ready" = "none";
    const mergeStart = vi.fn(() => {
      state = "running";
      return merge("running");
    });
    const mergeState = vi.fn(() => merge(state));
    const rendered = await mountPanel(handlers({ mergeStart, mergeState }));
    const user = userEvent.setup();
    await expandConflict(user);
    await user.click(
      screen.getByRole("button", { name: /Merge conflicted with an agent/ }),
    );
    await screen.findByText(/An agent is merging conflicted/);

    // Longer than the 2s timer this panel used to run: nothing asks on its own.
    state = "ready";
    const asked = mergeState.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(mergeState.mock.calls.length).toBe(asked);
    expect(screen.queryByText(/The agent finished merging conflicted/)).toBeNull();

    await rendered.emitRealtime("skills-applied", { sourceId: "matt", merge: "conflicted" });
    expect(
      await screen.findByText(/The agent finished merging conflicted/),
    ).toBeTruthy();
  }, 10_000);

  it("catches up on a merge whose signal was missed while disconnected", async () => {
    let state: "none" | "running" | "ready" = "none";
    const mergeStart = vi.fn(() => {
      state = "running";
      return merge("running");
    });
    const rendered = await mountPanel(
      handlers({ mergeStart, mergeState: () => merge(state) }),
    );
    const user = userEvent.setup();
    await expandConflict(user);
    await user.click(
      screen.getByRole("button", { name: /Merge conflicted with an agent/ }),
    );
    await screen.findByText(/An agent is merging conflicted/);

    // The merge finished while the socket was down, so its signal is gone.
    state = "ready";
    await rendered.setRealtimeConnectionState("reconnecting");
    await rendered.setRealtimeConnectionState("connected");

    // Reconnecting reloads the status, which folds every open row, so the
    // merge is found again on the way back in rather than left on "running".
    await user.click(
      within(section("Needs a merge")).getByRole("button", { name: /^conflicted/ }),
    );
    expect(
      await screen.findByText(/The agent finished merging conflicted/),
    ).toBeTruthy();
  }, 10_000);

  it("cancels a running merge and offers the conflict again", async () => {
    const mergeCancel = vi.fn(() => ({ ok: true as const }));
    const mergeAccept = vi.fn(() => ({ backup: "/tmp/never" }));
    const rendered = await mountPanel(
      handlers({ mergeStart: () => merge("running"), mergeCancel, mergeAccept }),
    );
    const user = userEvent.setup();
    await expandConflict(user);
    await user.click(
      screen.getByRole("button", { name: /Merge conflicted with an agent/ }),
    );
    await screen.findByText(/An agent is merging conflicted/);

    await user.click(
      await screen.findByRole("button", { name: /Cancel the merge/ }),
    );
    await waitFor(() => expect(mergeCancel).toHaveBeenCalledTimes(1));
    expect(
      rendered.rpcCalls.find((entry) => entry.method === "mergeCancel")?.input,
    ).toEqual({ sourceId: "matt", name: "conflicted" });
    // Nothing was written, so no backup note and no accept.
    expect(mergeAccept).not.toHaveBeenCalled();
    expect(screen.queryByText("Your old version was saved.")).toBeNull();
    expect(
      await screen.findByRole("button", { name: /Merge conflicted with an agent/ }),
    ).toBeTruthy();
  });

  it("offers no cancel once the merge is staged", async () => {
    await mountPanel(handlers({ mergeState: () => merge("ready") }));
    const user = userEvent.setup();
    await expandConflict(user);
    await screen.findByText(/The agent finished merging conflicted/);
    expect(screen.queryByRole("button", { name: /Cancel the merge/ })).toBeNull();
  });

  it("shows the merge against what is installed, and offers both ways out", async () => {
    const mergeDiff = vi.fn(() => ({ patch: patchFor("skills/conflicted/SKILL.md") }));
    const rendered = await mountPanel(
      handlers({ mergeStart: () => merge("ready"), mergeDiff }),
    );
    const user = userEvent.setup();
    await expandConflict(user);
    await user.click(
      screen.getByRole("button", { name: /Merge conflicted with an agent/ }),
    );

    await waitFor(() => expect(mergeDiff).toHaveBeenCalledTimes(1));
    expect(
      rendered.rpcCalls.find((entry) => entry.method === "mergeDiff")?.input,
    ).toEqual({ sourceId: "matt", name: "conflicted" });
    const region = mergeRegion();
    expect(
      within(region).getByText("The merge, against what you have installed"),
    ).toBeTruthy();
    expect(within(region).getByText(/Nothing has been written yet/)).toBeTruthy();
    expect(within(region).getByRole("button", { name: /Accept the merge/ })).toBeTruthy();
    expect(within(region).getByRole("button", { name: /Discard it/ })).toBeTruthy();
  });

  it("accepts one skill and says where the old version went", async () => {
    const mergeAccept = vi.fn(() => ({
      backup: "/tmp/skills/.backups/conflicted-1",
    }));
    const apply = vi.fn(() => ({
      applied: [],
      failed: [],
      markerRefusal: null,
      marker: null,
    }));
    const rendered = await mountPanel(
      handlers({ mergeStart: () => merge("ready"), mergeAccept, apply }),
    );
    const user = userEvent.setup();
    await expandConflict(user);
    await user.click(
      screen.getByRole("button", { name: /Merge conflicted with an agent/ }),
    );
    await user.click(
      await screen.findByRole("button", { name: /Accept the merge/ }),
    );

    await waitFor(() => expect(mergeAccept).toHaveBeenCalledTimes(1));
    const calls = rendered.rpcCalls.filter(
      (entry) => entry.method === "mergeAccept",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toEqual({ sourceId: "matt", name: "conflicted" });
    // The destructive path never goes through the overwrite RPC.
    expect(apply).not.toHaveBeenCalled();
    // Durable, not a toast: the path is the thing the user must not miss.
    expect(await screen.findByText("Your old version was saved.")).toBeTruthy();
    expect(screen.getByText("/tmp/skills/.backups/conflicted-1")).toBeTruthy();
  });

  it("writes nothing when the merge is discarded", async () => {
    const mergeDiscard = vi.fn(() => ({ ok: true as const }));
    const mergeAccept = vi.fn(() => ({ backup: "/tmp/never" }));
    const apply = vi.fn(() => ({
      applied: [],
      failed: [],
      markerRefusal: null,
      marker: null,
    }));
    await mountPanel(
      handlers({
        mergeStart: () => merge("ready"),
        mergeState: () => merge("none"),
        mergeDiscard,
        mergeAccept,
        apply,
      }),
    );
    const user = userEvent.setup();
    await expandConflict(user);
    await user.click(
      screen.getByRole("button", { name: /Merge conflicted with an agent/ }),
    );
    await user.click(await screen.findByRole("button", { name: /Discard it/ }));

    await waitFor(() => expect(mergeDiscard).toHaveBeenCalledTimes(1));
    expect(mergeAccept).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(screen.queryByText("Your old version was saved.")).toBeNull();
    // Back to the offer, with the skill untouched.
    expect(
      await screen.findByRole("button", { name: /Merge conflicted with an agent/ }),
    ).toBeTruthy();
  });

  it("reports a failed merge and leaves the original two choices", async () => {
    await mountPanel(
      handlers({
        mergeStart: () =>
          merge("failed", { error: "the two SKILL.md files disagree everywhere" }),
      }),
    );
    const user = userEvent.setup();
    await expandConflict(user);
    await user.click(
      screen.getByRole("button", { name: /Merge conflicted with an agent/ }),
    );

    const region = await screen.findByRole("region", {
      name: "Agent merge for conflicted",
    });
    expect(
      within(region).getByText(/could not merge conflicted/),
    ).toBeTruthy();
    expect(
      within(region).getByText("the two SKILL.md files disagree everywhere"),
    ).toBeTruthy();
    expect(within(region).getByText(/Nothing was written/)).toBeTruthy();
    // Choice one: take upstream. Choice two: keep mine.
    expect(
      screen.getByRole("button", { name: /Replace conflicted with upstream/ }),
    ).toBeTruthy();
    await user.click(within(region).getByRole("button", { name: "Keep my version" }));
    expect(
      await screen.findByRole("button", { name: /Merge conflicted with an agent/ }),
    ).toBeTruthy();
  });
});
