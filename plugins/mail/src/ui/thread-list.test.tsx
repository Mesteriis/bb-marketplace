// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadSummary } from "../core/index.ts";
import { ListDensityContext, LOAD_MORE_MARGIN_PX, ThreadList, offscreenRowStyle } from "./thread-list.tsx";

installTestPluginRuntime();
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const thread = (n: number): ThreadSummary => ({
  id: `th-${n}`,
  accountId: "acc_1",
  subject: `Invented subject ${n}`,
  lastDate: "2026-11-17T10:00:00.000Z",
  messageCount: 1,
  unreadCount: 0,
  participants: [{ name: "Sender", address: "sender@example.org" }],
  snippet: `Invented preview ${n}`,
  flagged: false,
  snoozedUntil: null,
  category: null,
  categorySuggestion: null,
  projectId: null,
});

function list(overrides: Partial<Parameters<typeof ThreadList>[0]> = {}) {
  return (
    <ThreadList
      threads={[thread(1), thread(2)]}
      selectedThreadId={null}
      ownAddress={() => null}
      marker={() => null}
      onSelect={() => undefined}
      hasMore
      loadingMore={false}
      onLoadMore={() => undefined}
      checked={new Set()}
      onToggleChecked={() => undefined}
      onToggleFlag={() => undefined}
      focusedId={null}
      {...overrides}
    />
  );
}

describe("ThreadList: read statuses", () => {
  it("marks a conversation whose sent message was opened, with how often and when", () => {
    vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
    render(list({ threads: [{ ...thread(1), opens: { count: 2, lastAt: "2026-11-20T14:05:00.000Z" } }, thread(2)] }));
    const marks = screen.getAllByLabelText("Opened");
    expect(marks).toHaveLength(1);
    expect(marks[0]!.getAttribute("title")).toMatch(/^Opened 2 times \u00b7 last /);
  });
});

describe("ThreadList: AI sorts the inbox", () => {
  it("shows the model's line in place of the snippet (the snippet one hover away) and the AI labels, two and a count", () => {
    vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
    render(list({ threads: [{ ...thread(1), aiSummary: "A vendor offers widgets.", aiLabels: ["Pitch", "Invoice", "Team"] }, thread(2)] }));
    const line = screen.getByText("A vendor offers widgets.");
    expect(line.getAttribute("title")).toBe("Invented preview 1");
    expect(screen.queryByText("Invented preview 1")).toBeNull();
    expect(screen.getByText("Invented preview 2")).toBeTruthy();
    expect(screen.getAllByLabelText("AI labels")).toHaveLength(1);
    expect(screen.getByLabelText("AI labels").textContent).toBe("PitchInvoice+1");
  });
});

/** A stand-in observer the test fires by hand. */
function stubObserver() {
  const observers: { fire: (isIntersecting: boolean) => void; options: IntersectionObserverInit | undefined; disconnected: boolean }[] = [];
  class Stub {
    private readonly entry: (typeof observers)[number];
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      this.entry = {
        options,
        disconnected: false,
        fire: (isIntersecting) =>
          callback([{ isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver),
      };
      observers.push(this.entry);
    }
    observe() {}
    unobserve() {}
    disconnect() {
      this.entry.disconnected = true;
    }
  }
  vi.stubGlobal("IntersectionObserver", Stub);
  return observers;
}

describe("the focused row", () => {
  it("draws no outline of its own: BB's page-wide focus outline would show as two lines cut by the row", () => {
    render(list({ focusedId: "th-1" }));
    const button = screen.getByRole("button", { name: /Invented subject 1/ });
    // Inline, because BB's `:focus-visible` rule is outside any layer and beats a utility class.
    expect(button.style.outlineStyle).toBe("none");
    // The row itself shows where the keys are.
    expect(button.closest("li")!.className).toContain("bg-state-hover");
  });
});

describe("big lists (slice 3j)", () => {
  it("lets the browser skip rows that are far from view, at the row's own height", () => {
    expect(offscreenRowStyle(false)).toEqual({ contentVisibility: "auto", containIntrinsicSize: "auto 68px" });
    expect(offscreenRowStyle(true)).toEqual({ contentVisibility: "auto", containIntrinsicSize: "auto 44px" });
    render(<ListDensityContext.Provider value="compact">{list()}</ListDensityContext.Provider>);
    const row = screen.getByRole("button", { name: /Invented subject 1/ }).closest("li")!;
    expect(row.style.getPropertyValue("content-visibility")).toBe("auto");
    // Every loaded row stays in the document: the keys and the selection reach it.
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("asks for the next page when the end of the list comes near, not while one is loading", () => {
    const observers = stubObserver();
    const onLoadMore = vi.fn();
    const view = render(list({ onLoadMore }));
    expect(observers).toHaveLength(1);
    expect(observers[0]!.options?.rootMargin).toBe(`0px 0px ${LOAD_MORE_MARGIN_PX}px 0px`);

    observers[0]!.fire(false);
    expect(onLoadMore).not.toHaveBeenCalled();
    observers[0]!.fire(true);
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    view.rerender(list({ onLoadMore, loadingMore: true }));
    observers[0]!.fire(true);
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    view.rerender(list({ onLoadMore, hasMore: false }));
    expect(observers[0]!.disconnected).toBe(true);
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("keeps the Load more button where the browser cannot watch the list", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const onLoadMore = vi.fn();
    render(list({ onLoadMore }));
    screen.getByRole("button", { name: "Load more" }).click();
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});
