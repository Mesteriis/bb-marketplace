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

const shape = (code: string, reason?: string) => ({ code, message: "m", retryable: false, ...(reason === undefined ? {} : { reason }) });

it("reads an old error shape without reason and does not add the key", () => {
  expect(CommanderErrorShape.parse(shape("internal"))).toEqual({ code: "internal", message: "m", retryable: false });
  expect("reason" in new CommanderError("internal", "m").toShape()).toBe(false);
});

it("accepts one valid code and reason pair of each archive code", () => {
  for (const [code, reason] of [
    ["invalid_archive", "duplicate_name"], ["limit_exceeded", "ratio"], ["auth_failed", "password_required"],
    ["unsupported", "archives_unavailable"], ["internal", "helper_crashed"],
  ] as const) {
    expect(CommanderErrorShape.parse(shape(code, reason))).toEqual(shape(code, reason));
    expect(new CommanderError(code, "m", false, reason).toShape()).toEqual(shape(code, reason));
  }
});

it("rejects a reason outside its code's closed set, an unknown reason and a reason on other codes", () => {
  for (const [code, reason] of [
    ["invalid_archive", "ratio"], ["limit_exceeded", "bad_tar"], ["auth_failed", "duplicate_name"],
    ["unsupported", "password_required"], ["no_space", "bad_tar"], ["internal", "bad_zip"],
    ["invalid_archive", "no_such_reason"], ["limit_exceeded", "no_such_reason"],
  ]) {
    expect(CommanderErrorShape.safeParse(shape(code, reason)).success, `${code}+${reason}`).toBe(false);
  }
});

it("accepts every documented reason under its own code", () => {
  const sets = {
    invalid_archive: "bad_tar bad_zip bad_eocd bad_zip64 bad_range bad_pax count_mismatch scan_mismatch overlapping_entries local_name_mismatch multi_volume truncated size_overflow duplicate_name crc_mismatch size_mismatch aes_auth_failed",
    limit_exceeded: "meta_too_large directory_too_large too_many_entries name_too_long ratio total_bytes too_many_open_archives",
    auth_failed: "password_required bad_password",
    unsupported: "link_not_supported link_escapes encryption_unsupported v7_tar pax_size unsupported_format unsupported_compression archives_unavailable",
    internal: "helper_checksum_failed helper_version_mismatch helper_crashed protocol_error",
  };
  let total = 0;
  for (const [code, list] of Object.entries(sets)) {
    for (const reason of list.split(" ")) {
      total++;
      expect(CommanderErrorShape.safeParse(shape(code, reason)).success, `${code}+${reason}`).toBe(true);
    }
  }
  expect(total).toBe(38);
});
