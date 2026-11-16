// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PresendDialog, presendIssueText, type PresendIssue } from "./presend-dialog.tsx";

installTestPluginRuntime();
afterEach(cleanup);

const ISSUES: PresendIssue[] = [
  { kind: "attachment_mentioned", phrase: "see attached" },
  { kind: "empty_subject" },
  { kind: "outside_conversation", addresses: ["bo@example.org"] },
  { kind: "new_recipients", addresses: ["cy@example.com", "di@example.com"] },
];

describe("PresendDialog", () => {
  it("lists every issue with its Fix; Back to editing has the focus", () => {
    const onFix = vi.fn();
    render(<PresendDialog issues={ISSUES} onFix={onFix} onBack={vi.fn()} onSendAnyway={vi.fn()} />);
    const items = screen.getByRole("list", { name: "Issues" }).querySelectorAll("li");
    expect(Array.from(items).map((li) => li.textContent)).toEqual([
      "You wrote “see attached”, but nothing is attached.Attach a file",
      "The subject is empty.Add a subject",
      "Not in this conversation: bo@example.orgCheck recipients",
      "You have not written to cy@example.com, di@example.com before.Check recipients",
    ]);
    expect(document.activeElement?.textContent).toBe("Back to editing");
    fireEvent.click(screen.getByRole("button", { name: "Add a subject" }));
    expect(onFix).toHaveBeenCalledWith({ kind: "empty_subject" });
  });

  it("Escape is Back to editing; Cmd/Ctrl+Enter does nothing; Send anyway sends", () => {
    const onBack = vi.fn();
    const onSendAnyway = vi.fn();
    render(<PresendDialog issues={ISSUES} onFix={vi.fn()} onBack={onBack} onSendAnyway={onSendAnyway} />);
    const send = screen.getByRole("button", { name: "Send anyway" });
    const ctrl = new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true });
    send.dispatchEvent(ctrl);
    expect(ctrl.defaultPrevented).toBe(true);
    expect(onSendAnyway).not.toHaveBeenCalled();
    fireEvent.click(send);
    expect(onSendAnyway).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(onBack).toHaveBeenCalled();
  });

  it("lists BB files and secret-looking text (slice 3g)", () => {
    expect(presendIssueText({ kind: "bb_files", count: 2, origins: ["api", "Fix login"] }).text).toBe("2 files from BB: api, Fix login");
    expect(presendIssueText({ kind: "looks_secret", count: 2 }).text).toBe("The text looks like it holds a password, token or code (2)");
    render(<PresendDialog issues={[{ kind: "bb_files", count: 1, origins: ["api"] }, { kind: "looks_secret", count: 1 }]} onFix={vi.fn()} onBack={vi.fn()} onSendAnyway={vi.fn()} />);
    expect(screen.getByText("1 file from BB: api")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check the text" })).toBeTruthy();
  });

  it("is closed without issues", () => {
    render(<PresendDialog issues={null} onFix={vi.fn()} onBack={vi.fn()} onSendAnyway={vi.fn()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(presendIssueText({ kind: "empty_subject" }).fix).toBe("Add a subject");
  });
});
