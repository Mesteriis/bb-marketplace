// The dialog frame: it must stay inside the window however tall its content is.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Modal } from "../../../src/ui/chrome/primitives.tsx";

describe("Modal", () => {
  it("caps the dialog at the window height and scrolls it, without relying on a stylesheet", () => {
    // jsdom has no layout; the cap must be inline because a dialog portaled to the body is outside the plugin's
    // scoped stylesheet (found on the stand: height 1586 px in a 900 px window, top unreachable).
    render(<Modal labelledBy="h" onDismiss={() => {}}><h2 id="h">Title</h2></Modal>);
    const dialog = screen.getByRole("dialog");
    expect(dialog.style.maxHeight).toBe("100%");
    expect(dialog.style.overflowY).toBe("auto");
  });
});
