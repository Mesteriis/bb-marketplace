import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { EntryCard } from "../../../src/ui/panels/EntryCard.tsx";

it("shows the refusal and retries only on a second explicit gesture", async () => {
  const open = vi.fn().mockRejectedValueOnce(Error("Терминал завершён")).mockResolvedValueOnce("Запрос обработан");
  render(<EntryCard title="BB терминал" purpose="Открыть терминал tty" check={async () => {}} actions={[{ label: "Открыть", run: open }]} />);
  const button = await screen.findByRole("button", { name: "Открыть" });
  expect(open).toHaveBeenCalledTimes(0);
  fireEvent.click(button);
  await screen.findByText("Терминал завершён");
  expect(open).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
  await screen.findByText("Запрос обработан");
  expect(open).toHaveBeenCalledTimes(2);
});

it("keeps an unavailable provider's link and retry checks availability without opening it", async () => {
  const run = vi.fn();
  const check = vi.fn().mockRejectedValueOnce(Error("Zoom выключен. Ссылка сохранена.")).mockResolvedValue(undefined);
  render(<EntryCard title="Zoom" purpose="Открыть календарь" check={check} actions={[{ label: "Открыть раздел", href: "/plugins/makosh-zoom/zoom", run }]} />);
  await screen.findByText("Zoom выключен. Ссылка сохранена.");
  expect(screen.queryByRole("link")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
  expect((await screen.findByRole("link")).getAttribute("href")).toBe("/plugins/makosh-zoom/zoom");
  expect(run).toHaveBeenCalledTimes(0);
});

it("withholds navigation if the provider disappears between restore and the click", async () => {
  const run = vi.fn();
  const check = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(Error("Поставщик выключен"));
  render(<EntryCard title="Zoom" purpose="Открыть календарь" check={check} actions={[{ label: "Открыть", run }]} />);
  fireEvent.click(await screen.findByRole("button", { name: "Открыть" }));
  await screen.findByText("Поставщик выключен");
  expect(run).toHaveBeenCalledTimes(0);
});
