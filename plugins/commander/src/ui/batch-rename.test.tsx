// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { Entry } from "../core/model.ts";
import type { RenamePattern } from "../core/rename-pattern.ts";
import { BatchRenameDialog } from "./batch-rename.tsx";

// The same icon stand-in as the other UI tests: the plugin runtime is not available here.
vi.mock("@get-bb/plugin-sdk/app", () => ({
  experimental_Icon: ({ name }: { name: string }) => <svg aria-hidden="true" data-test-icon={name} />,
}));

afterEach(cleanup);

function file(name: string): Entry {
  return {
    name: { t: name }, kind: "file", size: "3", mtimeNs: "1", mtimePrecision: "ns",
    mode: null, linkTarget: null, hidden: false,
  };
}

function setField(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label, { exact: false }), { target: { value } });
}

function renderDialog(submit = vi.fn()) {
  const entries = [file("a.txt"), file("b.txt")];
  render(<BatchRenameDialog entries={entries} directory={entries} caseSensitive busy={false} error={null}
    submit={submit} close={() => {}} />);
  return submit;
}

test("the preview shows each new name, and a shared target blocks the plan", () => {
  renderDialog();
  setField("Шаблон имени", "x");
  expect(screen.getAllByText("x.txt", { selector: "td" })).toHaveLength(2);
  expect(screen.getAllByText("Совпадает с именем другого файла пачки")).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Создать план" }).hasAttribute("disabled")).toBe(true);
});

test("a counter pattern previews a_001 and b_002 and submits exactly that pattern", () => {
  const submit = renderDialog();
  setField("Шаблон имени", "[N]_[C]");
  expect(screen.getByText("a_001.txt")).toBeTruthy();
  expect(screen.getByText("b_002.txt")).toBeTruthy();
  const button = screen.getByRole("button", { name: "Создать план" });
  expect(button.hasAttribute("disabled")).toBe(false);
  fireEvent.click(button);
  const expected: RenamePattern = {
    template: "[N]_[C]", case: "keep", counter: { start: 1, step: 1, width: 3 },
  };
  expect(submit).toHaveBeenCalledWith(expected);
});

test("a regex that can backtrack too long is shown as refused and blocks the plan", () => {
  renderDialog();
  fireEvent.click(screen.getByRole("checkbox", { name: /регулярное выражение/ }));
  setField("Найти", "(a+)+$");
  setField("Заменить на", "x");
  expect(screen.getAllByText("Регулярное выражение отклонено: допустим плоский вид с одним повтором без групп и альтернатив").length).toBeGreaterThan(0);
  expect(screen.getByRole("button", { name: "Создать план" }).hasAttribute("disabled")).toBe(true);
});

test("the second-phase cancel refusal reaches the owner in Russian; the core message stays English", async () => {
  const { CommanderError } = await import("../core/errors.ts");
  const { problemOf } = await import("./model.ts");
  const problem = problemOf(new CommanderError("unsupported", "Batch rename cancel is unavailable: the second phase is running"));
  expect(problem).toEqual({ code: "unsupported", message: "Отмена недоступна: идёт вторая фаза переименования" });
});
