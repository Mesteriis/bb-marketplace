// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MailAddress } from "../core/model.ts";
import {
  addChips,
  chipText,
  RecipientInput,
  splitTyped,
  SUGGEST_DEBOUNCE_MS,
} from "./recipient-input.tsx";

installTestPluginRuntime();
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

let latest = { chips: [] as string[], text: "" };

function Harness({
  initial = [],
  suggest = () => Promise.resolve([]),
}: {
  initial?: string[];
  suggest?: (prefix: string) => Promise<MailAddress[]>;
}) {
  const [field, setField] = useState({ chips: initial, text: "" });
  latest = field;
  return <RecipientInput label="To" chips={field.chips} text={field.text} onChange={setField} suggest={suggest} />;
}

const input = () => screen.getByRole("combobox", { name: "To" }) as HTMLInputElement;
const type = (text: string) => fireEvent.change(input(), { target: { value: text } });
const chipItems = () =>
  Array.from(screen.getByRole("list", { name: "To recipients" }).querySelectorAll("li")).filter(
    (li) => !li.contains(input()),
  );

describe("RecipientInput chips", () => {
  it("commits on comma, semicolon, Enter and Tab", () => {
    render(<Harness />);
    type("ada@example.org,");
    expect(latest).toEqual({ chips: ["ada@example.org"], text: "" });
    type("bo@example.org;");
    expect(latest.chips).toEqual(["ada@example.org", "bo@example.org"]);
    type("cy@example.org");
    fireEvent.keyDown(input(), { key: "Enter" });
    type("Dee <dee@example.net>");
    fireEvent.keyDown(input(), { key: "Tab" });
    expect(latest).toEqual({
      chips: ["ada@example.org", "bo@example.org", "cy@example.org", "Dee <dee@example.net>"],
      text: "",
    });
    expect(chipItems().map((li) => li.textContent)).toEqual(["ada@example.org", "bo@example.org", "cy@example.org", "Dee"]);
  });

  it("keeps a comma inside a quoted name, and text under three characters as typed", () => {
    render(<Harness />);
    type('"Doe, Jo" <jo@example.org>');
    expect(latest.chips).toEqual([]);
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(latest.chips).toEqual(['"Doe, Jo" <jo@example.org>']);
    type("ab");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(latest).toEqual({ chips: ['"Doe, Jo" <jo@example.org>'], text: "ab" });
  });

  it("splits a pasted list", () => {
    render(<Harness />);
    fireEvent.paste(input(), {
      clipboardData: { getData: () => "ada@example.org; Bo <bo@example.org>\ncy@example.net, ada@example.org" },
    });
    expect(latest).toEqual({ chips: ["ada@example.org", "Bo <bo@example.org>", "cy@example.net"], text: "" });
  });

  it("shows an invalid address as an error chip with its reason as the description", () => {
    render(<Harness />);
    type("not-an-address,");
    type("иван@example.org,");
    const [bad, cyrillic] = chipItems();
    expect(bad!.getAttribute("aria-invalid")).toBe("true");
    const described = document.getElementById(bad!.getAttribute("aria-describedby")!);
    expect(described?.textContent).toBe("This is not an email address");
    expect(document.getElementById(cyrillic!.getAttribute("aria-describedby")!)?.textContent).toMatch(/non-Latin/);
  });

  it("selects the last chip on Backspace in an empty field, then removes it", () => {
    render(<Harness initial={["ada@example.org", "bo@example.org"]} />);
    fireEvent.keyDown(input(), { key: "Backspace" });
    expect(chipItems()[1]!.hasAttribute("data-selected")).toBe(true);
    expect(latest.chips).toHaveLength(2);
    fireEvent.keyDown(input(), { key: "Backspace" });
    expect(latest.chips).toEqual(["ada@example.org"]);
  });

  it("removes a chip with its button", () => {
    render(<Harness initial={["ada@example.org", "bo@example.org"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove ada@example.org" }));
    expect(latest.chips).toEqual(["bo@example.org"]);
  });
});

describe("RecipientInput suggestions", () => {
  it("asks once per pause, then offers a listbox the arrows and Enter drive", async () => {
    vi.useFakeTimers();
    const suggest = vi.fn((prefix: string) =>
      Promise.resolve([
        { name: "Ada Example", address: `${prefix}a@example.org` },
        { name: null, address: `${prefix}b@example.org` },
      ]),
    );
    render(<Harness suggest={suggest} />);
    type("a");
    type("ad");
    await act(async () => {
      vi.advanceTimersByTime(SUGGEST_DEBOUNCE_MS - 1);
    });
    expect(suggest).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(suggest).toHaveBeenCalledTimes(1);
    expect(suggest).toHaveBeenCalledWith("ad");

    const listbox = screen.getByRole("listbox", { name: "To suggestions" });
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0]!.getAttribute("aria-selected")).toBe("true");
    expect(input().getAttribute("aria-expanded")).toBe("true");
    expect(input().getAttribute("aria-activedescendant")).toBe(options[0]!.id);
    expect(listbox).toBeTruthy();

    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(latest).toEqual({ chips: ["adb@example.org"], text: "" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes on Escape without letting the key reach the composer", async () => {
    vi.useFakeTimers();
    const outer = vi.fn();
    render(
      <div onKeyDown={outer}>
        <Harness suggest={() => Promise.resolve([{ name: null, address: "ada@example.org" }])} />
      </div>,
    );
    type("ad");
    await act(async () => {
      vi.advanceTimersByTime(SUGGEST_DEBOUNCE_MS);
    });
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(outer).not.toHaveBeenCalled();
  });
});

describe("chip helpers", () => {
  it("formats stored addresses, quoting names that need it", () => {
    expect(chipText({ name: null, address: "ada@example.org" })).toBe("ada@example.org");
    expect(chipText({ name: "Ada Example", address: "ada@example.org" })).toBe("Ada Example <ada@example.org>");
    expect(chipText({ name: 'Doe, "Jo"', address: "jo@example.org" })).toBe('"Doe, \\"Jo\\"" <jo@example.org>');
  });

  it("splits typed text into complete pieces and the rest", () => {
    expect(splitTyped("a@example.org, b@exa")).toEqual({ complete: ["a@example.org"], rest: "b@exa" });
    expect(splitTyped("a@example.org;")).toEqual({ complete: ["a@example.org"], rest: "" });
    expect(splitTyped("plain")).toEqual({ complete: [], rest: "plain" });
  });

  it("drops duplicates and keeps short pieces as text", () => {
    expect(addChips(["Ada <ada@example.org>"], ["ADA@example.org", "x", "bo@example.org"])).toEqual({
      chips: ["Ada <ada@example.org>", "bo@example.org"],
      kept: ["x"],
    });
  });
});
