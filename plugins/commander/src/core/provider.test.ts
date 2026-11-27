import { expect, expectTypeOf, it } from "vitest";
import { LIST_PAGE_MAX, READ_CHUNK_MAX, type FileProvider } from "./provider.ts";

it("exports the provider limits in bytes and entries", () => {
  expect(READ_CHUNK_MAX).toBe(4194304);
  expect(LIST_PAGE_MAX).toBe(1000);
});

it("allows same-endpoint copy to check the target fingerprint or absence", () => {
  type CopyOptions = Parameters<NonNullable<FileProvider["copyWithin"]>>[2];
  expectTypeOf({
    replace: true,
    expectTarget: { size: "5368709120", mtimeNs: "0" },
  }).toExtend<CopyOptions>();
  expectTypeOf({ replace: true, expectTarget: "absent" } as const).toExtend<CopyOptions>();
  expectTypeOf<{ replace: true; expectTarget: "unchecked" }>().not.toExtend<CopyOptions>();
});
