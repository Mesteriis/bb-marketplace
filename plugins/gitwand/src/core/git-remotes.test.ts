import { describe, expect, it } from "vitest";
import { parseGitConfigRemotes, parseGitdirPointer, remoteKey } from "./git-remotes.ts";

describe("remoteKey", () => {
  it.each([
    ["git@github.com:Mesteriis/GitWand-bb.git", "github.com/mesteriis/gitwand-bb"],
    ["https://github.com/Mesteriis/GitWand-bb.git", "github.com/mesteriis/gitwand-bb"],
    ["https://github.com/Mesteriis/GitWand-bb", "github.com/mesteriis/gitwand-bb"],
    ["https://user@github.com/Mesteriis/GitWand-bb/", "github.com/mesteriis/gitwand-bb"],
    ["ssh://git@github.com/Mesteriis/GitWand-bb.git", "github.com/mesteriis/gitwand-bb"],
    ["ssh://git@gitlab.example.org:2222/group/sub/proj.git", "gitlab.example.org/group/sub/proj"],
    ["git@gitlab.com:group/sub/proj.git", "gitlab.com/group/sub/proj"],
  ])("normalizes %s", (url, key) => {
    expect(remoteKey(url)).toBe(key);
  });

  it.each(["", "/Users/someone/bare.git", "../relative.git", "file:///tmp/x.git", "github.com"])("has no forge key for %j", (url) => {
    expect(remoteKey(url)).toBeNull();
  });
});

describe("parseGitConfigRemotes", () => {
  it("reads every remote url and ignores other sections", () => {
    const config = [
      "[core]",
      "\trepositoryformatversion = 0",
      "\turl = not-a-remote",
      '[remote "origin"]',
      "\turl = git@github.com:example/one.git",
      "\tfetch = +refs/heads/*:refs/remotes/origin/*",
      '[branch "main"]',
      "\tremote = origin",
      '[remote "upstream"]',
      "  url=https://gitlab.com/group/two.git",
      "",
    ].join("\n");
    expect(parseGitConfigRemotes(config)).toEqual(["git@github.com:example/one.git", "https://gitlab.com/group/two.git"]);
  });

  it("returns nothing for a config without remotes", () => {
    expect(parseGitConfigRemotes("[core]\n\tbare = false\n")).toEqual([]);
  });
});

describe("parseGitdirPointer", () => {
  it("reads the gitdir of a worktree .git file", () => {
    expect(parseGitdirPointer("gitdir: /work/main/.git/worktrees/feature\n")).toBe("/work/main/.git/worktrees/feature");
  });

  it("refuses anything else", () => {
    expect(parseGitdirPointer("ref: refs/heads/main\n")).toBeNull();
    expect(parseGitdirPointer("gitdir:   \n")).toBeNull();
  });
});
