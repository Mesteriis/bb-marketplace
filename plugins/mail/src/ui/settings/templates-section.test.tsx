// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TemplateView } from "./shared.ts";
import { TemplatesSection, carriesText } from "./templates-section.tsx";

installTestPluginRuntime();
afterEach(cleanup);

const doc = { type: "doc" as const, content: [{ type: "paragraph", content: [{ type: "text", text: "Invented offer text" }] }] };
const offer: TemplateView = {
  id: "t-1",
  name: "Offer",
  doc,
  updatedAt: "2026-11-19T10:00:00.000Z",
  subject: "Offer",
  to: ["ada@example.com"],
  cc: [],
  bcc: ["boss@example.org"],
  files: [{ id: "f-1", name: "price.pdf", mimeType: "application/pdf", size: 2048 }],
};

describe("Templates settings: what a template carries", () => {
  it("says in the list what a template fills beside its text", () => {
    expect(carriesText(offer)).toBe("Subject: Offer · 2 recipients · 1 file");
    expect(carriesText({ id: "t-2", name: "Plain", doc, updatedAt: "" })).toBeNull();
    render(<TemplatesSection templates={[offer]} onSave={async () => {}} onDelete={async () => {}} />);
    expect(screen.getByText("Subject: Offer · 2 recipients · 1 file")).toBeTruthy();
  });

  it("edits the subject and recipients and saves them as lists", async () => {
    const onSave = vi.fn(async () => {});
    render(<TemplatesSection templates={[offer]} onSave={onSave} onDelete={async () => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Offer" }));
    const form = within(await screen.findByRole("form", { name: "Edit Offer" }));
    expect((form.getByLabelText("To") as HTMLInputElement).value).toBe("ada@example.com");
    fireEvent.change(form.getByLabelText("Subject"), { target: { value: " New offer " } });
    fireEvent.change(form.getByLabelText("Cc"), { target: { value: "team@example.org; Bob <bob@example.com>, " } });
    fireEvent.change(form.getByLabelText("Bcc"), { target: { value: "" } });
    fireEvent.click(form.getByRole("button", { name: "Save template" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      id: "t-1",
      name: "Offer",
      subject: "New offer",
      to: ["ada@example.com"],
      cc: ["team@example.org", "Bob <bob@example.com>"],
      bcc: [],
    });
  });

  it("lists a saved template's files, removes one and adds picked files; a new template is saved first", async () => {
    const files = { add: vi.fn(async () => {}), remove: vi.fn(async () => {}) };
    render(<TemplatesSection templates={[offer]} onSave={async () => {}} onDelete={async () => {}} files={files} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Offer" }));
    const list = within(await screen.findByRole("list", { name: "Template files" }));
    expect(list.getByText("price.pdf")).toBeTruthy();
    fireEvent.click(list.getByRole("button", { name: "Remove price.pdf" }));
    await waitFor(() => expect(files.remove).toHaveBeenCalledWith("t-1", "f-1"));
    const picked = new File(["x"], "terms.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("Add files to the template"), { target: { files: [picked] } });
    await waitFor(() => expect(files.add).toHaveBeenCalledWith("t-1", picked));
    cleanup();

    render(<TemplatesSection templates={[]} onSave={async () => {}} onDelete={async () => {}} files={files} />);
    fireEvent.click(screen.getByRole("button", { name: "New template" }));
    expect(await screen.findByText("Save the template first, then add its files.")).toBeTruthy();
    expect(screen.queryByLabelText("Add files to the template")).toBeNull();
  });

  it("shows why a file could not be added", async () => {
    const files = { add: vi.fn(async () => Promise.reject(new Error("Attachments are over the size limit"))), remove: vi.fn(async () => {}) };
    render(<TemplatesSection templates={[offer]} onSave={async () => {}} onDelete={async () => {}} files={files} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Offer" }));
    fireEvent.change(await screen.findByLabelText("Add files to the template"), { target: { files: [new File(["x"], "big.pdf")] } });
    expect((await screen.findByRole("alert")).textContent).toBe("Attachments are over the size limit");
  });
});
