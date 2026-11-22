import { expect, it } from "vitest";
import { diffParamsSchema, filePreviewParamsSchema } from "../../../src/core/diff/refs.ts";

const file = { environmentId: "env_test", path: "docs/my%20file.md" };
const preview = { kind: "workspace", ...file };
const diff = { ...file, fromSha: "0123456789abcdef0123456789abcdef01234567", toSha: "ABCDEF0123456789ABCDEF0123456789ABCDEF01" };

it("preserves the selected workspace, encoded path and complete revisions", () => {
  expect(filePreviewParamsSchema.parse(preview)).toEqual(preview);
  expect(diffParamsSchema.parse(diff)).toEqual(diff);
});

it.each(["../secret", "dir/%2e%2e/secret", "/absolute", "dir%5C..%5Csecret"])("refuses an unsafe workspace path %s in both providers", path => {
  expect(filePreviewParamsSchema.safeParse({ ...preview, path }).success).toBe(false);
  expect(diffParamsSchema.safeParse({ ...diff, path }).success).toBe(false);
});

it("rejects undeclared fields and unsupported kinds", () => {
  expect(filePreviewParamsSchema.safeParse({ ...preview, extra: true }).success).toBe(false);
  expect(filePreviewParamsSchema.safeParse({ ...preview, kind: "host" }).success).toBe(false);
  expect(diffParamsSchema.safeParse({ ...diff, kind: "workspace" }).success).toBe(false);
});

it.each(["fromSha", "toSha"])("requires a complete hexadecimal SHA-1 for %s", field => {
  expect(diffParamsSchema.safeParse({ ...diff, [field]: "0123456" }).success).toBe(false);
  expect(diffParamsSchema.safeParse({ ...diff, [field]: "g".repeat(40) }).success).toBe(false);
});
