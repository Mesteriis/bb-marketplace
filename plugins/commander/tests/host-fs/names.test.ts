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
