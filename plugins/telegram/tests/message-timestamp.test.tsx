// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { MessageTimestamp } from "../src/ui/message-timestamp.tsx";

test("displays a channel signature and exposes the edit time separately from the post time", () => {
  render(<MessageTimestamp message={{
    channelSignature: "Fixture Author", time: "20:00", edited: true, editedAt: 1700000000,
  }} />);
  expect(screen.getByText("Fixture Author")).toBeTruthy();
  const edit = screen.getByText("edited");
  expect(edit.getAttribute("datetime")).toBe("2023-11-14T22:13:20.000Z");
  expect(edit.getAttribute("title")).toMatch(/^Edited /);
  expect(screen.getByText("20:00")).toBeTruthy();
});
