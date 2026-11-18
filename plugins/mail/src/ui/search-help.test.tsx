// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it } from "vitest";
import { SearchHelpButton, SearchNotes, searchNoteText } from "./search-help.tsx";

installTestPluginRuntime();
afterEach(cleanup);

describe("search notes", () => {
  it("says why a word stayed text", () => {
    expect(searchNoteText({ kind: "bad_value", term: "larger:abc" })).toBe(
      "larger:abc \u2014 not understood (sizes look like 10K or 2M)",
    );
    expect(searchNoteText({ kind: "bad_value", term: "-newer_than:x" })).toBe(
      "-newer_than:x \u2014 not understood (use a number and d, w, m or y, like 3m)",
    );
    expect(searchNoteText({ kind: "unknown_operator", term: "foo:bar" })).toBe("foo:bar \u2014 not an operator; searched as text");
  });

  it("renders notes as text, never as markup", () => {
    render(<SearchNotes notes={[{ kind: "unknown_operator", term: "<b>x</b>:1" }]} />);
    const list = screen.getByRole("list", { name: "Search notes" });
    expect(list.querySelector("b")).toBeNull();
    expect(within(list).getByText(/<b>x<\/b>:1/)).toBeTruthy();
  });

  it("renders nothing without notes", () => {
    const { container } = render(<SearchNotes notes={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("lists the operators in the help", () => {
    render(<SearchHelpButton />);
    fireEvent.click(screen.getByRole("button", { name: "Search help" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("has:attachment")).toBeTruthy();
    expect(within(dialog).getByText("-in:trash")).toBeTruthy();
  });
});
