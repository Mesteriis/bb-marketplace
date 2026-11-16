// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { AvatarEditor } from "../src/ui/avatar-editor.tsx";

test("removes only the confirmed avatar and reloads the available actions", async () => {
  const remove = vi.fn(async () => "saved" as const);
  const version = "a".repeat(64);
  render(<AvatarEditor label="profile photo" version={version} canRemove
    save={async () => "unavailable"} remove={remove}
    reload={async () => ({ version: null, canRemove: false })} />);
  fireEvent.click(screen.getByRole("button", { name: "Remove profile photo" }));
  fireEvent.click(screen.getByRole("button", { name: "Keep photo" }));
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Remove profile photo" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm photo removal" }));
  expect((await screen.findByRole("status")).textContent).toBe("Photo removed.");
  expect(remove.mock.calls).toEqual([[version]]);
  expect(screen.queryByRole("button", { name: "Remove profile photo" })).toBeNull();
});
