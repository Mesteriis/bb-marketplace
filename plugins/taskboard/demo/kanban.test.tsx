// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { TaskboardPage } from "../src/ui/taskboard-page.tsx";
import { buildDemoApi } from "./synthetic-api.ts";

beforeAll(() => installTestPluginRuntime());
afterEach(cleanup);
it("keeps all assigned work in List and requires a project for the real Jira Kanban", async () => {
  const api = await buildDemoApi();
  const board = (await api.listBoards()).find(b => b.connectionId !== null)!;
  const transition = vi.spyOn(api, "applyTransition");
  render(<TaskboardPage api={api} />);
  fireEvent.change(await screen.findByLabelText("Board"), { target: { value: board.id } });
  await screen.findByText("Improve API error handling");
  fireEvent.click(screen.getByRole("button", { name: "Board" }));
  expect(screen.getByText("Select a Jira project to view Kanban. All assigned tasks are available in List.")).toBeTruthy();
  expect(screen.queryByText("Ship mobile onboarding")).toBeNull();
  await waitFor(() => expect(within(screen.getByLabelText("Jira project")).getByText("DEMO — Demo project")).toBeTruthy());
  fireEvent.change(screen.getByLabelText("Jira project"), { target: { value: "DEMO" } });
  const ready = await screen.findByRole("region", { name: "Ready" });
  expect(within(ready).getByText("Ship mobile onboarding")).toBeTruthy();
  expect(within(ready).getByText("Team board task")).toBeTruthy();
  expect(screen.getByRole("region", { name: "Delivered" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "In progress" })).toBeNull();
  fireEvent.change(within(ready).getByLabelText("Move DEMO-101"), { target: { value: "1" } });
  const transitionDialog = await screen.findByRole("dialog");
  fireEvent.click(within(transitionDialog).getByRole("button", { name: "Complete → Done" }));
  await waitFor(() => expect(transition).toHaveBeenCalledWith(board.connectionId, "DEMO-101", "21"));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "List" }));
  await screen.findByText("Improve API error handling");
  expect(screen.queryByText("Team board task")).toBeNull();
});
