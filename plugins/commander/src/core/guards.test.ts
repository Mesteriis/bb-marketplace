import { expect, it } from "vitest";
import {
  assertDeletable,
  assertNotIntoSelf,
  assertNotReplacingSource,
  assertWritable,
} from "./guards.ts";

import type { Endpoint, ResourceRef } from "./model.ts";
import { parsePosix } from "./path.ts";

function ref(endpoint: string, path: string): ResourceRef {
  return { endpoint: endpoint as ResourceRef["endpoint"], path: parsePosix(path) };
}

function endpoint(readOnly: boolean): Endpoint {
  return {
    id: "host:x",
    provider: "local",
    label: "x",
    machine: "x",
    hostId: "x",
    readOnly,
    caseSensitive: true,
  };
}

it("rejects copying a directory into itself", () => {
  expect(() => assertNotIntoSelf([ref("host:x", "/a")], ref("host:x", "/a/b"), true)).toThrow(
    expect.objectContaining({ code: "invalid_path" }),
  );
});

it("rejects a target equal to a source", () => {
  expect(() => assertNotIntoSelf([ref("host:x", "/a")], ref("host:x", "/a"), true)).toThrow(
    expect.objectContaining({ code: "invalid_path" }),
  );
});

it("allows a sibling whose name only starts with the source name", () => {
  expect(() => assertNotIntoSelf([ref("host:x", "/a")], ref("host:x", "/ab"), true)).not.toThrow();
});

it("allows a target on another endpoint even with the same path", () => {
  expect(() => assertNotIntoSelf([ref("host:x", "/a")], ref("host:y", "/a/b"), true)).not.toThrow();
});

it("rejects copying an entry into its own directory, which would replace it", () => {
  expect(() =>
    assertNotReplacingSource([ref("host:x", "/src/a.txt")], ref("host:x", "/src"), true),
  ).toThrow(expect.objectContaining({ code: "invalid_path" }));
});

it("allows copying an entry into another directory", () => {
  expect(() =>
    assertNotReplacingSource([ref("host:x", "/src/a.txt")], ref("host:x", "/dst"), true),
  ).not.toThrow();
});

it("refuses to delete the root", () => {
  expect(() => assertDeletable(ref("host:x", "/"), [])).toThrow(
    expect.objectContaining({ code: "permission_denied" }),
  );
});

it("refuses to delete the home directory", () => {
  expect(() => assertDeletable(ref("host:x", "/home/u"), [parsePosix("/home/u")])).toThrow(
    expect.objectContaining({ code: "permission_denied" }),
  );
});

it("refuses to delete a parent of a protected path", () => {
  expect(() => assertDeletable(ref("host:x", "/home"), [parsePosix("/home/u")])).toThrow(
    expect.objectContaining({ code: "permission_denied" }),
  );
});

it("allows deleting a path below a protected path", () => {
  expect(() => assertDeletable(ref("host:x", "/home/u/docs"), [parsePosix("/home/u")])).not.toThrow();
});

it("refuses writes to a read-only endpoint", () => {
  expect(() => assertWritable(endpoint(true))).toThrow(
    expect.objectContaining({ code: "read_only" }),
  );
});

it("allows writes to a writable endpoint", () => {
  expect(() => assertWritable(endpoint(false))).not.toThrow();
});
