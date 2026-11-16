// Regression for the demo seeding path: buildDemoApi must return a fully
// seeded API whose boards/tasks/columns all mount a nonempty real UI.
import { describe, expect, it } from "vitest";
import { buildDemoApi } from "./synthetic-api";

describe("demo synthetic api", () => {
  it("seeds a local board and a Jira board with valid, mountable data", async () => {
    const api = await buildDemoApi();
    const boards = await api.listBoards();
    const names = boards.map((board) => board.name).sort();
    expect(names).toEqual(["Atlassian Cloud (demo)", "Product"]);

    const product = boards.find((board) => board.name === "Product")!;
    expect((await api.listTasks(product.id)).tasks.map((task) => task.title)).toEqual([
      "Write the launch blog post",
      "Fix checkout race condition",
    ]);

    const jira = boards.find((board) => board.name === "Atlassian Cloud (demo)")!;
    const { columns, tasks } = await api.listTasks(jira.id);
    const keys = tasks.map((task) => task.originKey).filter((key): key is string => key !== null).sort();
    expect(keys).toEqual(["DEMO-101", "DEMO-102", "DEMO-103"]);
    expect(tasks.some((task) => task.origin === "local" && task.title === "Team follow-up on the demo")).toBe(true);

    // Every task status must resolve to a column on its board.
    const ids = new Set(columns.map((column) => column.id));
    for (const task of tasks) expect(ids.has(task.status)).toBe(true);
  });
});
