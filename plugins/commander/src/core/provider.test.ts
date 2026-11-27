import { expect, it } from "vitest";
import { LIST_PAGE_MAX, READ_CHUNK_MAX } from "./provider.ts";

it("exports the provider limits in bytes and entries", () => {
  expect(READ_CHUNK_MAX).toBe(4194304);
  expect(LIST_PAGE_MAX).toBe(1000);
});
