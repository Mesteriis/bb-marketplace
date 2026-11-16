// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PatchViewOutput } from "../core/contract.ts";
import { BB_TEXT, type CodeRenderers } from "./bb-ports.ts";
import { CHECKOUT_WARNING, PatchCard, PatchDialog, patchSummaryText, type PatchRequest } from "./patch-dialog.tsx";
import { fakeCall, type BbHandlers } from "./testing/bb-fixtures.ts";

installTestPluginRuntime();
afterEach(cleanup);

const REF = "b".repeat(64);
const VIEW: PatchViewOutput = {
  files: [
    { oldPath: "src/a.ts", newPath: "src/a.ts", added: 2, removed: 1, status: "modified", binary: false, symlink: false, executable: false, patch: "@@ -1 +1,2 @@\n-a\n+b\n+c" },
    { oldPath: null, newPath: "run.sh", added: 1, removed: 0, status: "added", binary: false, symlink: false, executable: true, patch: "@@ -0,0 +1 @@\n+echo hi" },
  ],
  warnings: ["adds an executable file: run.sh"],
  refused: null,
  commitMessage: "Fix <b>login</b>",
  patchRef: REF,
};

function mount(request: Partial<PatchRequest> = {}, handlers: BbHandlers = {}, renderers: CodeRenderers = {}) {
  const fake = fakeCall({
    patch_view: () => VIEW,
    patch_save: () => ({ path: "mail-patches/2026-11-16-fix.patch" }),
    patch_handoff: () => ({ bbThreadId: "bbt-2", environment: "worktree" }),
    ...handlers,
  });
  const props = { onSaved: vi.fn(), onHandedOff: vi.fn(), onClose: vi.fn() };
  render(
    <PatchDialog
      request={{ messageId: "m-1", projectId: "p-api", inAiScope: true, ...request }}
      call={fake.call}
      renderers={renderers}
      {...props}
    />,
  );
  return { ...fake, ...props };
}

describe("PatchCard", () => {
  it("summarizes the patch and opens the review", () => {
    const onReview = vi.fn();
    render(<PatchCard patch={{ files: 3, added: 40, removed: 12 }} onReview={onReview} />);
    expect(screen.getByText(patchSummaryText({ files: 3, added: 40, removed: 12 }))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(onReview).toHaveBeenCalled();
  });
});

describe("PatchDialog", () => {
  it("renders each file through the injected diff viewer, with the warnings, as text", async () => {
    const renderDiff = vi.fn((patch: string, path: string) => <div data-testid={`diff-${path}`}>{patch}</div>);
    mount({}, {}, { renderDiff });
    expect(await screen.findByTestId("diff-src/a.ts")).toBeTruthy();
    expect(renderDiff).toHaveBeenCalledWith(VIEW.files[1]!.patch, "run.sh");
    expect(screen.getByText("adds an executable file: run.sh")).toBeTruthy();
    expect(screen.getByText("Fix <b>login</b>")).toBeTruthy();
  });

  it("falls back to <pre> without the host viewer", async () => {
    mount();
    expect((await screen.findByText(/echo hi/)).tagName).toBe("PRE");
  });

  it("a refused patch says why and offers no action", async () => {
    mount({}, { patch_view: () => ({ ...VIEW, refused: "touches .git/" }) });
    expect((await screen.findByRole("alert")).textContent).toBe("Refused: touches .git/");
    expect(screen.queryByRole("button", { name: "Apply with an agent" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save .patch to project" })).toBeNull();
  });

  it("saves the .patch and hands it to an agent with the shown patchRef", async () => {
    const { to, onSaved, onHandedOff } = mount();
    await screen.findByText("adds an executable file: run.sh");
    await waitFor(() => expect((screen.getByRole("button", { name: "Save .patch to project" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Save .patch to project" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith("mail-patches/2026-11-16-fix.patch", "api"));
    expect(to("patch_save")[0]).toEqual({ messageId: "m-1", projectId: "p-api", patchRef: REF });
    fireEvent.click(screen.getByRole("button", { name: "Apply with an agent" }));
    await waitFor(() => expect(onHandedOff).toHaveBeenCalledWith("bbt-2", "worktree"));
    expect(to("patch_handoff")[0]).toEqual({ messageId: "m-1", projectId: "p-api", patchRef: REF });
  });

  it("offers the checkout only after the worktree is refused, with the warning", async () => {
    const { to, onHandedOff } = mount(
      { projectId: "p-docs" },
      {
        patch_handoff: (input) =>
          input.environment === "checkout" ? { bbThreadId: "bbt-3", environment: "checkout" } : Promise.reject(new Error(BB_TEXT.no_tree)),
      },
    );
    await screen.findByText("adds an executable file: run.sh");
    fireEvent.click(screen.getByRole("button", { name: "Apply with an agent" }));
    expect(await screen.findByText(CHECKOUT_WARNING)).toBeTruthy();
    expect(to("patch_handoff")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Apply in my checkout" }));
    await waitFor(() => expect(onHandedOff).toHaveBeenCalledWith("bbt-3", "checkout"));
    expect(to("patch_handoff")[1]).toMatchObject({ environment: "checkout" });
  });

  it("out of AI access: Apply is off, Save stays", async () => {
    mount({ inAiScope: false });
    await screen.findByText("adds an executable file: run.sh");
    await waitFor(() => expect((screen.getByRole("button", { name: "Save .patch to project" }) as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByRole("button", { name: "Apply with an agent" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(BB_TEXT.out_of_scope)).toBeTruthy();
  });
});
