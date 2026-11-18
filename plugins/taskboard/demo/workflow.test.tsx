// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { TaskboardPage } from "../src/ui/taskboard-page";
import { buildDemoApi } from "./synthetic-api";

beforeAll(() => installTestPluginRuntime());
afterEach(cleanup);

describe("demo Take into work flow (no real network)", () => {
  it("takes a Jira task into work, completes, edits time and confirms", async () => {
    const api = await buildDemoApi();
    render(<TaskboardPage api={api} notify={() => {}} />);
    const boards = await api.listBoards();
    const jira = boards.find((board) => board.name === "Atlassian Cloud (demo)")!;
    fireEvent.change(await screen.findByLabelText("Board"), { target: { value: jira.id } });
    fireEvent.click(await screen.findByText("Ship mobile onboarding"));
    fireEvent.click(await screen.findByRole("button", { name: "Take into work" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Start" }));
    fireEvent.click(await screen.findByRole("button", { name: "Complete" }));
    const timeDialog = await screen.findByRole("dialog");
    fireEvent.change(within(timeDialog).getByLabelText("Duration (seconds)"), { target: { value: "5400" } });
    fireEvent.change(within(timeDialog).getByLabelText("Comment"), { target: { value: "built it" } });
    fireEvent.click(within(timeDialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Log time (pending)" })).toBeNull());
    const runs = await api.listRuns(jira.id === boards[0].id ? boards[1].id : boards[0].id);
    // DEMO-101 belongs to the Jira board; assert the run completed there.
    const task = (await api.listTasks(jira.id)).tasks.find((t) => t.originKey === "DEMO-101")!;
    const taskRuns = await api.listRuns(task.id);
    expect(taskRuns.some((run) => run.state === "completed")).toBe(true);
  });
});

it("logs time directly on a Jira task without creating or completing a run", async () => {
  const api = await buildDemoApi();
  render(<TaskboardPage api={api} />);
  const board = (await api.listBoards()).find((b) => b.name === "Atlassian Cloud (demo)")!;
  fireEvent.change(await screen.findByLabelText("Board"), { target: { value: board.id } });
  fireEvent.click(await screen.findByText("Ship mobile onboarding"));
  fireEvent.click(await screen.findByRole("button", { name: "Log time" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("Duration (seconds)"), { target: { value: "1200" } });
  fireEvent.change(within(dialog).getByLabelText("Comment"), { target: { value: "Reviewed requirements" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Refresh worklog history" }));
  await screen.findByText("Reviewed requirements");
  const task = (await api.listTasks(board.id)).tasks.find((t) => t.originKey === "DEMO-101")!;
  expect(await api.listRuns(task.id)).toEqual([]);
  expect((await api.listWorklogs!(task.id))[0].durationSeconds).toBe(1200);
});
