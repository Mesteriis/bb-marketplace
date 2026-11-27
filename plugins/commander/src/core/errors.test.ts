import { expect, it } from "vitest";
import { CommanderError, CommanderErrorShape, ErrorCode, isCommanderError } from "./errors.ts";

it("serializes a retryable error without its stack", () => {
  const error = new CommanderError("timeout", "Request timed out", true);
  expect(CommanderErrorShape.parse(error.toShape())).toEqual({
    code: "timeout",
    message: "Request timed out",
    retryable: true,
  });
});

it("defaults to a non-retryable wire error", () => {
  expect(new CommanderError("invalid_path", "Invalid resource path").toShape()).toEqual({
    code: "invalid_path",
    message: "Invalid resource path",
    retryable: false,
  });
});

it("recognizes instances without accepting arbitrary errors or wire shapes", () => {
  const error = new CommanderError("internal", "Internal error");
  expect(isCommanderError(error)).toBe(true);
  expect(isCommanderError(new Error("Internal error"))).toBe(false);
  expect(isCommanderError(error.toShape())).toBe(false);
});

it("bounds the message in the wire shape", () => {
  const error = new CommanderError("internal", "a".repeat(500) + "b");
  expect(CommanderErrorShape.parse(error.toShape()).message).toBe("a".repeat(500));
});

it("does not split an emoji at the wire message limit", () => {
  const error = new CommanderError("internal", "a".repeat(499) + "😀");
  expect(error.toShape().message).toBe("a".repeat(499));
});

it("preserves the invalid_name code for a target filesystem error", () => {
  expect(ErrorCode.parse("invalid_name")).toBe("invalid_name");
  expect(new CommanderError("invalid_name", "Invalid target filename").toShape()).toEqual({
    code: "invalid_name",
    message: "Invalid target filename",
    retryable: false,
  });
});
