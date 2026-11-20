// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SettingRow, SettingsGroup, SettingsSection } from "./primitives.tsx";

afterEach(cleanup);

describe("settings primitives", () => {
  it("a section has its title as a heading and one sentence under it", () => {
    render(
      <SettingsSection title="Inbox" description="What happens to new mail.">
        <p>content</p>
      </SettingsSection>,
    );
    expect(screen.getByRole("heading", { level: 2, name: "Inbox" })).toBeTruthy();
    expect(screen.getByText("What happens to new mail.")).toBeTruthy();
    expect(screen.getByText("content")).toBeTruthy();
  });

  it("a row ties its label and hint to the control, and says a refusal and a note", () => {
    render(
      <SettingRow
        label="Hide quoted text"
        hint="In replies."
        problem="BB refused the change."
        note="Saved"
        control={({ id, describedBy }) => <input id={id} aria-describedby={describedBy} type="checkbox" />}
      />,
    );
    const control = screen.getByLabelText("Hide quoted text");
    expect(control.getAttribute("type")).toBe("checkbox");
    expect(document.getElementById(control.getAttribute("aria-describedby")!)!.textContent).toBe("In replies.");
    expect(screen.getByRole("alert").textContent).toBe("BB refused the change.");
    expect(screen.getByRole("status").textContent).toBe("Saved");
  });

  it("a row without a hint, problem or note has none of them", () => {
    render(<SettingRow label="Plain" control={({ id }) => <input id={id} />} />);
    expect(screen.getByLabelText("Plain").getAttribute("aria-describedby")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("a group has its title as a heading and its action beside it", () => {
    render(
      <SettingsGroup title="Rules" action={<button type="button">New rule</button>}>
        <ul />
      </SettingsGroup>,
    );
    expect(screen.getByRole("heading", { level: 3, name: "Rules" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New rule" })).toBeTruthy();
  });
});
