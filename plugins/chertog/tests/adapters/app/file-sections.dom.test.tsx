import type { PluginBrowserBbSdk, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { providerSources } from "../../../src/adapters/bb/app/provider-sources.tsx";
import { ThreadDirectory } from "../../../src/adapters/bb/app/thread-source.ts";

vi.mock("@get-bb/plugin-sdk/app", () => ({}));

it.each(["bb-editor", "markdown-editor"])("keeps %s in A when preview selects B", async editorType => {
  const sdk = {
    threads: { tabs: {} },
    environments: {
      list: async () => ["A", "B"].map(id => ({ id, name: id, path: "/" + id, status: "ready" })),
      paths: async ({ environmentId }: { environmentId: string }) => ({
        paths: [{ kind: "file", path: environmentId === "A" ? "editor.md" : "preview.md" }],
      }),
    },
  } as unknown as PluginBrowserBbSdk;
  const sources = providerSources(sdk, {} as ReturnType<typeof useBbNavigate>, new ThreadDirectory());
  const editor = sources.find(source => source.provider.type === editorType)!;
  const preview = sources.find(source => source.provider.type === "bb-file-preview")!;
  const editorForm = within(render(<>{editor.controls!()}</>).container);
  const previewForm = within(render(<>{preview.controls!()}</>).container);
  const user = userEvent.setup();
  for (const [form, environment] of [[editorForm, "A"], [previewForm, "B"]] as const) {
    await user.click(form.getByRole("button", { name: "Выбрать среду" }));
    await user.selectOptions(form.getByLabelText("Рабочая среда"), environment);
  }
  const reopened = within(render(<>{editor.controls!()}</>).container);
  await user.click(reopened.getByRole("button", { name: "Выбрать среду" }));
  expect(reopened.getByDisplayValue("A")).toBeTruthy();
  expect(editorForm.getByDisplayValue("A")).toBeTruthy();
  expect(previewForm.getByDisplayValue("B")).toBeTruthy();
  expect(editor.section().items.map(item => item.title)).toEqual(["editor.md"]);
  expect(preview.section().items.map(item => item.title)).toEqual(["preview.md"]);
  expect(editor.refOf(editor.section().items[0].id)).toEqual({ provider: editorType, params: { kind: "workspace", environmentId: "A", path: "editor.md" } });
  expect(preview.refOf(preview.section().items[0].id)).toEqual({ provider: "bb-file-preview", params: { kind: "workspace", environmentId: "B", path: "preview.md" } });
});
