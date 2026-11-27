import { expect, it } from "vitest";
import { Size, addSize, fromBig, toBig } from "./size.ts";

it("converts a 5 GiB wire size to bigint", () => {
  expect(toBig("5368709120")).toBe(5368709120n);
});

it("serializes values beyond an unsigned 64-bit integer", () => {
  expect(fromBig(2n ** 64n)).toBe("18446744073709551616");
});

it.each(["01", "-1", "100000000000000000000"])("rejects wire size %s", (size) => {
  expect(Size.safeParse(size).success).toBe(false);
});

it.each([-1n, 100000000000000000000n])("rejects out-of-range bigint %s", (size) => {
  expect(() => fromBig(size)).toThrow(RangeError);
});

it("adds sizes without losing integer precision", () => {
  expect(addSize("9007199254740993", "1")).toBe("9007199254740994");
});

it("rejects overflow beyond the wire size limit", () => {
  expect(() => addSize("99999999999999999999", "1")).toThrow(RangeError);
});
