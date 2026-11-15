// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignatureEditor } from "./signature-editor.tsx";

installTestPluginRuntime();
afterEach(cleanup);

const SIGNATURE = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Made-up Name", marks: [{ type: "bold" }] }] }],
};

describe("SignatureEditor", () => {
  it("offers bold, italic, underline and link, and no list or quote button", () => {
    render(<SignatureEditor address="team@example.org" initial={null} onSave={vi.fn()} onCancel={vi.fn()} />);
    const toolbar = screen.getByRole("toolbar", { name: "Formatting" });
    const names = Array.from(toolbar.querySelectorAll("button")).map((b) => b.getAttribute("aria-label") ?? "");
    expect(names.map((n) => n.replace(/ \(.*\)$/, ""))).toEqual(["Bold", "Italic", "Underline", "Link"]);
  });

  it("has no list or quote in its schema, so pasted ones become paragraphs", () => {
    render(<SignatureEditor address="team@example.org" initial={SIGNATURE} onSave={vi.fn()} onCancel={vi.fn()} />);
    const box = screen.getByRole("textbox", { name: "Signature for team@example.org" });
    expect(box.textContent).toContain("Made-up Name");
    const editor = (box as unknown as { editor?: import("@tiptap/react").Editor }).editor ?? null;
    expect(editor).not.toBeNull();
    expect(editor!.schema.nodes.bulletList).toBeUndefined();
    expect(editor!.schema.nodes.orderedList).toBeUndefined();
    expect(editor!.schema.nodes.blockquote).toBeUndefined();
    editor!.commands.setContent("<ul><li><p>One</p></li></ul><blockquote><p>Two</p></blockquote>");
    expect(editor!.getJSON().content?.map((node) => node.type)).toEqual(["paragraph", "paragraph"]);
  });

  it("saves the document, and Cancel calls back", async () => {
    const onSave = vi.fn(async () => undefined);
    const onCancel = vi.fn();
    render(<SignatureEditor address="team@example.org" initial={SIGNATURE} onSave={onSave} onCancel={onCancel} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save signature" }));
    });
    expect(onSave).toHaveBeenCalledWith(SIGNATURE);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("shows a refusal inline", async () => {
    render(
      <SignatureEditor
        address="team@example.org"
        initial={SIGNATURE}
        onSave={async () => Promise.reject(new Error("The signature is too long"))}
        onCancel={vi.fn()}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save signature" }));
    });
    expect(screen.getByRole("alert").textContent).toBe("The signature is too long");
  });
});
