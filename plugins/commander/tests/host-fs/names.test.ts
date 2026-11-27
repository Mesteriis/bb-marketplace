import { expect, it } from "vitest";
import { validateTargetName } from "../../src/adapters/bb/host-fs/names.ts";

it.each(["a:b", "a\\b", "CON", "con.txt", "NUL", "COM1.log", "LPT9", "name.", "name ",
  "a<b", "a>b", 'a"b', "a|b", "a?b", "a*b", "a\u0001b", "a\u0000b"])(
  "rejects Windows target %j", (t) => {
    expect(() => validateTargetName({ t }, "win32")).toThrow(expect.objectContaining({ code: "invalid_name" }));
  },
);

it.each(["CONSOLE", "COM10", "nul_", "Привет.txt"])("accepts Windows target %j", (t) => {
  expect(() => validateTargetName({ t }, "win32")).not.toThrow();
});

it.each(["a:b", "CON", "name."])("accepts POSIX target %j", (t) => {
  expect(() => validateTargetName({ t }, "posix")).not.toThrow();
});

it("builds Windows drive paths independently of the test OS", async () => {
  const { parseWindowsPath } = await import("../../src/adapters/bb/host-fs/paths.ts");
  expect(parseWindowsPath(String.raw`C:\Users\Привет`)).toEqual({
    segments: [{ t: "C:" }, { t: "Users" }, { t: "Привет" }],
  });
  expect(parseWindowsPath("D:/")).toEqual({ segments: [{ t: "D:" }] });
  expect(() => parseWindowsPath("E:relative")).toThrow(expect.objectContaining({ code: "invalid_path" }));
});

it("refuses a UNC home explicitly", async () => {
  const { parseWindowsPath } = await import("../../src/adapters/bb/host-fs/paths.ts");
  expect(() => parseWindowsPath(String.raw`\\server\share\home`))
    .toThrow(expect.objectContaining({ code: "unsupported" }));
});
