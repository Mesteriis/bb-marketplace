// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComposeAttachment } from "../core/model.ts";
import { BB_TEXT } from "./bb-ports.ts";
import { BbFilePicker, PICK_MAX, type FilePickRequest } from "./bb-file-picker.tsx";
import { fakeCall, type BbHandlers } from "./testing/bb-fixtures.ts";

installTestPluginRuntime();
afterEach(cleanup);

const FILES = Array.from({ length: 12 }, (_, i) => ({ name: `f${i}.txt`, path: `src/f${i}.txt` }));
const attachment = (path: string): ComposeAttachment => ({
  id: `att-${path}`,
  fileName: path.slice(path.lastIndexOf("/") + 1),
  mimeType: "text/plain",
  size: 10,
  origin: "bb:project:p-api",
});

function mount(request: Partial<FilePickRequest> = {}, handlers: BbHandlers = {}, context = { projectId: "p-api" as string | null, threadId: null as string | null }) {
  const fake = fakeCall({
    project_files: () => ({ files: FILES, truncated: false }),
    thread_files: () => ({ files: [{ name: "out.log", path: "out.log" }], truncated: false }),
    bb_threads_recent: () => ({ threads: [{ id: "bbt-9", title: "Fix login", updatedAt: null }] }),
    compose_attach_bb: (input) => attachment(input.source.path),
    ...handlers,
  });
  const props = { onAttached: vi.fn(), onClose: vi.fn() };
  render(
    <BbFilePicker
      request={{ kind: "project", draftId: "d-1", ...request }}
      call={fake.call}
      currentProjectId={context.projectId}
      currentThreadId={context.threadId}
      {...props}
    />,
  );
  return { ...fake, ...props };
}

describe("BbFilePicker", () => {
  it("ticks at most 10 files and attaches them from the project", async () => {
    const { to, onAttached } = mount();
    await screen.findByLabelText("src/f0.txt");
    for (const file of FILES.slice(0, 11)) fireEvent.click(screen.getByLabelText(file.path));
    expect(screen.getByText(`${PICK_MAX} of ${PICK_MAX} picked`)).toBeTruthy();
    expect((screen.getByLabelText("src/f10.txt") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    await waitFor(() => expect(onAttached).toHaveBeenCalled());
    expect(to("compose_attach_bb")).toHaveLength(10);
    expect(to("compose_attach_bb")[0]).toEqual({ draftId: "d-1", source: { kind: "project", projectId: "p-api", path: "src/f0.txt" } });
  });

  it("asks again for a secret-like name and attaches it only with confirmed", async () => {
    const { to, onAttached } = mount(
      {},
      {
        project_files: () => ({ files: [{ name: ".env.local", path: ".env.local" }, { name: "a.txt", path: "a.txt" }], truncated: false }),
        compose_attach_bb: (input) => {
          if (input.source.path === ".env.local" && input.confirmed !== true) return Promise.reject(new Error(BB_TEXT.confirm_needed));
          return attachment(input.source.path);
        },
      },
    );
    fireEvent.click(await screen.findByLabelText(".env.local"));
    fireEvent.click(screen.getByLabelText("a.txt"));
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    expect(await screen.findByText("Attach anyway?")).toBeTruthy();
    expect(onAttached).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Attach anyway" }));
    await waitFor(() => expect(onAttached).toHaveBeenCalled());
    expect(to("compose_attach_bb").at(-1)).toMatchObject({ source: { path: ".env.local" }, confirmed: true });
    expect((onAttached.mock.calls[0]![0] as ComposeAttachment[]).map((a) => a.fileName)).toEqual(["a.txt", ".env.local"]);
  });

  it("Leave them out attaches only the others", async () => {
    const { onAttached } = mount(
      {},
      {
        project_files: () => ({ files: [{ name: "id_rsa", path: "id_rsa" }, { name: "a.txt", path: "a.txt" }], truncated: false }),
        compose_attach_bb: (input) =>
          input.source.path === "id_rsa" ? Promise.reject(new Error(BB_TEXT.confirm_needed)) : attachment(input.source.path),
      },
    );
    fireEvent.click(await screen.findByLabelText("id_rsa"));
    fireEvent.click(screen.getByLabelText("a.txt"));
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    fireEvent.click(await screen.findByRole("button", { name: "Leave them out" }));
    expect((onAttached.mock.calls[0]![0] as ComposeAttachment[]).map((a) => a.fileName)).toEqual(["a.txt"]);
  });

  it("from a thread: the thread Mail runs beside", async () => {
    const { to } = mount({ kind: "thread" }, {}, { projectId: "p-api", threadId: "bbt-1" });
    fireEvent.click(await screen.findByLabelText("out.log"));
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    await waitFor(() => expect(to("compose_attach_bb")).toHaveLength(1));
    expect(to("thread_files")[0]).toMatchObject({ bbThreadId: "bbt-1" });
    expect(to("compose_attach_bb")[0]).toMatchObject({ source: { kind: "thread", bbThreadId: "bbt-1", path: "out.log" } });
  });

  it("from a thread without a current one: a recent thread of a project", async () => {
    const { to } = mount({ kind: "thread" }, {}, { projectId: "p-api", threadId: null });
    const select = (await screen.findByLabelText("Thread")) as HTMLSelectElement;
    await screen.findByRole("option", { name: "Fix login" });
    fireEvent.change(select, { target: { value: "bbt-9" } });
    await screen.findByLabelText("out.log");
    expect(to("bb_threads_recent")[0]).toEqual({ projectId: "p-api", limit: 30 });
  });
});
