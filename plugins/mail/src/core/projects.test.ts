import { describe, expect, it } from "vitest";
import { repoRefOf, sameRepo, workingTree } from "./projects.ts";

describe("repoRefOf", () => {
  it.each([
    ["https://github.com/example-org/demo", "github.com", "example-org/demo"],
    ["https://github.com/example-org/demo.git", "github.com", "example-org/demo"],
    ["https://GitHub.com/Example-Org/Demo/", "github.com", "Example-Org/Demo"],
    ["https://gitlab.example.com:8443/group/sub/proj.git", "gitlab.example.com", "group/sub/proj"],
    ["git@github.com:example-org/demo.git", "github.com", "example-org/demo"],
    ["git@gitlab.com:group/sub/deeper/proj", "gitlab.com", "group/sub/deeper/proj"],
    ["ssh://git@github.com/example-org/demo.git", "github.com", "example-org/demo"],
    ["ssh://git@gitlab.example.org:2222/group/proj.git", "gitlab.example.org", "group/proj"],
  ])("reads %s", (url, host, path) => {
    expect(repoRefOf(url)).toEqual({ host, path });
  });

  it("drops user info from an https remote", () => {
    expect(repoRefOf(`https://someone@github.com/example-org/demo.git`)).toEqual({
      host: "github.com",
      path: "example-org/demo",
    });
  });

  it.each([
    "",
    "not a url",
    "http://github.com/example-org/demo",
    "https://github.com/",
    "https://github.com/only-owner",
    "https://github.com/a/../b",
    "https://github.com/a/b?x=1",
    "file:///tmp/repo",
    "git@github.com:",
    "/local/path/repo",
  ])("refuses %j", (url) => {
    expect(repoRefOf(url)).toBeNull();
  });
});

describe("sameRepo", () => {
  it("compares the host exactly and the path case-insensitively", () => {
    const a = repoRefOf("https://github.com/Example-Org/Demo")!;
    const b = repoRefOf("git@github.com:example-org/demo.git")!;
    expect(sameRepo(a, b)).toBe(true);
    expect(sameRepo(a, repoRefOf("https://gitlab.com/example-org/demo")!)).toBe(false);
    expect(sameRepo(a, repoRefOf("https://github.com/example-org/demo2")!)).toBe(false);
  });
});

describe("workingTree", () => {
  const source = (path: string, isDefault: boolean, hostId = "h1") => ({ type: "local_path", hostId, path, isDefault });

  it("is null without sources", () => {
    expect(workingTree([])).toBeNull();
  });

  it("is the only source", () => {
    expect(workingTree([source("/p/api", false)])).toEqual({ hostId: "h1", path: "/p/api" });
  });

  it("is the default among several", () => {
    expect(workingTree([source("/p/a", false), source("/p/b", true, "h2")])).toEqual({ hostId: "h2", path: "/p/b" });
  });

  it("is null for several without a default, or several defaults", () => {
    expect(workingTree([source("/p/a", false), source("/p/b", false)])).toBeNull();
    expect(workingTree([source("/p/a", true), source("/p/b", true)])).toBeNull();
  });

  it("ignores sources of another type", () => {
    expect(workingTree([{ type: "remote", hostId: "h", path: "/x", isDefault: true }, source("/p/a", false)])).toEqual({
      hostId: "h1",
      path: "/p/a",
    });
  });
});
